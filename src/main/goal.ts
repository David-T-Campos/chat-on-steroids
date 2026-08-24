/**
 * The goal loop — a second model, standing in for the user, that keeps a chat moving.
 *
 * ChatGPT finishes a long turn. Somebody has to read it and say what is still missing, and
 * for an unattended run that somebody is an OpenRouter model given the same conversation and
 * one instruction: you are the user, write the next message. When it decides the task is
 * finished it writes `NO_REPLY` instead, and nothing is typed at all. That is the whole
 * feature, and the two halves live in different places for a reason:
 *
 *   · The *page* owns "the turn is really over". Only the browser can tell a finished answer
 *     from a mid-turn redraw, a tool call, or a reload replaying yesterday's transcript, and
 *     it already has that machinery — the same settle barrier a compaction goes through.
 *   · This module owns everything after that: the context, the credential, the request, and
 *     the one draft per chat that the page is allowed to send.
 *
 * ## Why the app makes the call and not the extension
 *
 * The API key is a real credential. It lives in the same DPAPI blob as everything else the
 * app holds and never leaves the main process, so the extension is handed a *reply* rather
 * than a key. That also means the context is built from the local recording, which is the
 * authoritative copy of what was said — the page's DOM is a rendering of it, and a rendering
 * that has been scrolled, virtualised and re-mounted for six hours.
 *
 * ## What is sent
 *
 * Every user message and every final ChatGPT answer of this session, in order, and nothing
 * else. No tool calls, no arguments, no results, no file contents. The goal model is deciding
 * whether the user's request has been satisfied, and the conversation is the only evidence it
 * needs for that; the rest is this machine's business and does not leave it.
 *
 * ## One draft per chat
 *
 * A draft is keyed by the generation it answers. A second request for the same turn is the
 * same draft — a retried POST, a reloaded tab, two observers of one settle — and is answered
 * with what already exists rather than by asking the model twice and sending two messages
 * into somebody's conversation.
 */

import { createHash } from 'node:crypto';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { getSecret } from './secrets.js';
import { readEvents, readRecentEvents } from './session/store.js';

/** Where OpenRouter lives. One host, both routes. */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Sent so a key's owner can see which application spent it, which OpenRouter asks for and
 * uses to attribute traffic. Neither header carries anything about the user or the chat.
 */
const ATTRIBUTION_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://github.com/chat-on-steroids',
  'X-Title': 'Chat On Steroids'
};

/** How many messages of history the goal model is given, newest kept. */
const MAX_CONTEXT_MESSAGES = 120;
/** …and how many characters of them, so one 200k-character answer cannot be the whole prompt. */
const MAX_CONTEXT_CHARS = 120_000;
/** The per-message cut. Long enough to carry an answer's substance, short enough to fit many. */
const MAX_MESSAGE_CHARS = 12_000;
/** How long one draft may take before it is abandoned as failed. */
const REQUEST_TIMEOUT_MS = 180_000;
/** The catalogue is UI data; a dead provider must not leave the picker request hanging forever. */
const MODEL_LIST_TIMEOUT_MS = 30_000;
/** A single SSE record should be tiny; this still leaves ample room around the 12k reply cap. */
const MAX_SSE_RECORD_CHARS = 64_000;
/** Error prose is diagnostic only. Never buffer an arbitrary provider-controlled failure body. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** The model catalogue is bounded UI metadata, not an unlimited provider document. */
const MAX_MODEL_LIST_BODY_BYTES = 8 * 1024 * 1024;
/** Cache/picker cardinality and field bounds for provider-controlled model metadata. */
const MAX_MODELS = 5_000;
const MAX_MODEL_FIELD_CHARS = 500;
/** How long a finished draft stays available to the page that has to type it. */
const DRAFT_TTL_MS = 10 * 60_000;
/** The model listing is small and changes daily, not by the second. */
const MODEL_CACHE_MS = 5 * 60_000;
/** The page shows models in pages of this size, and asks for them the same way. */
export const MODEL_PAGE_SIZE = 20;

/**
 * The word that means "say nothing".
 *
 * Matched on the whole trimmed reply rather than searched for, because a model explaining
 * *when* it would answer `NO_REPLY` must not thereby end the run. Punctuation and case are
 * allowed to vary; anything else is a message the user is meant to send.
 */
const NO_REPLY = /^no[\s_-]?reply[\s.!]*$/i;

/**
 * The instruction. Deliberately in the second person and deliberately short.
 *
 * The failure this is written against is a model that answers *about* the conversation —
 * "The assistant should now implement X" — which is a review, not a user message, and reads
 * as one the moment it lands in the composer. So the role is stated first, the register is
 * described concretely (lowercase, casual, the way the actual user in this recording writes),
 * and the stopping condition is given a positive value rather than being an exception: saying
 * nothing when the work is done is the goal, not a failure to produce output.
 */
export function goalSystemPrompt(): string {
  return (
    'You are the user in this conversation, not an assistant. The messages labelled "user" are yours; the ' +
    'messages labelled "assistant" are ChatGPT answering you.\n\n' +
    'Your job: read what you originally asked for and what ChatGPT has done about it, then write your next ' +
    'message so the work carries on.\n\n' +
    'Write exactly like the user in this recording writes: lowercase, casual, short, no greeting, no sign-off, ' +
    'no politeness padding, no markdown headings, no bullet lists unless the user uses them. One or two ' +
    'sentences is normal. Say what is still missing, what to do next, or what to fix — concretely, naming the ' +
    'thing. Never review or narrate the assistant\'s work back to it, never say "the assistant should", never ' +
    'explain that you are continuing, and never mention that you are a model or that anything is automated.\n\n' +
    'If the goal you originally asked for has been fully implemented and there is genuinely nothing left worth ' +
    'asking for, reply with exactly:\n\nNO_REPLY\n\n' +
    'NO_REPLY is the right answer whenever the work is done — prefer it over inventing more work, over asking ' +
    'for polish nobody asked for, and over thanking anyone. Nothing is sent when you write it.\n\n' +
    'Otherwise reply with the message itself and nothing else: no quotes around it, no preamble, no explanation ' +
    'of your reasoning.'
  );
}

/** How a draft is going, in the order it goes. */
export type GoalStage =
  /** Building the context and opening the request. */
  | 'sending'
  /** The model is writing; `text` grows. */
  | 'answering'
  /** There is a message to type. */
  | 'ready'
  /** The model said the goal is met. Nothing is typed, and the loop ends here. */
  | 'no-reply'
  | 'failed';

export interface GoalDraftView {
  token: string;
  conversationId: string;
  /** The generation this draft answers. One draft per generation, ever. */
  turnId: string;
  stage: GoalStage;
  model: string;
  /** What the model has written so far, for the panel above the composer. */
  text: string;
  /** The message to type, present only at `ready`. */
  reply: string;
  /** A short machine-readable reason, shown by the page when the stage is `failed`. */
  error: string | null;
}

interface GoalDraft extends GoalDraftView {
  sessionId: string;
  /** Browser tab that owns the right to type/ack this draft. Empty only for legacy callers. */
  clientId: string;
  startedAt: number;
  settledAt: number;
  /** Set once the page has been told to type this, so it can never be typed twice. */
  acknowledged: boolean;
  work: Promise<void> | null;
  abort: AbortController | null;
}

/** At most one draft per conversation. A new turn replaces the old chat's finished draft. */
const drafts = new Map<string, GoalDraft>();

export function goalSettings(): { enabled: boolean; model: string; reasoning: string } {
  const goal = getConfig().goal;
  return { enabled: goal.enabled, model: goal.model, reasoning: goal.reasoning };
}

export async function goalKeyPresent(): Promise<boolean> {
  return (await getSecret('openRouterApiKey')) !== null;
}

function view(draft: GoalDraft): GoalDraftView {
  return {
    token: draft.token,
    conversationId: draft.conversationId,
    turnId: draft.turnId,
    stage: draft.stage,
    model: draft.model,
    text: draft.text,
    // The reply is handed over only while it is still the thing to do. Once acknowledged it
    // is history, and a page that polls again must not find a message to type a second time.
    reply: draft.stage === 'ready' && !draft.acknowledged ? draft.reply : '',
    error: draft.error
  };
}

function expireDraftPayload(draft: GoalDraft): void {
  if (draft.settledAt === 0 || Date.now() - draft.settledAt <= DRAFT_TTL_MS) return;
  // The TTL is for the *payload*, not the idempotency key. A ready draft can have crossed
  // ChatGPT's irreversible send boundary while its local ACK was lost. Keep this turn's token
  // as a spent tombstone until a genuinely newer generation supersedes it.
  draft.acknowledged = true;
  draft.text = '';
  draft.reply = '';
  draft.error = null;
  draft.work = null;
}

/** What the page should be told about this chat right now, or null when there is nothing. */
export function goalViewFor(conversationId: string, clientId?: string): GoalDraftView | null {
  const draft = drafts.get(conversationId);
  if (!draft) return null;
  expireDraftPayload(draft);
  if (clientId !== undefined && draft.clientId !== clientId) return null;
  // An acknowledged draft has already been acted on — typed, or decided against. It is kept
  // here only so the turn it belongs to cannot be drafted a second time, and reporting it
  // would leave the page polling fast and the panel above the composer describing something
  // that finished minutes ago.
  if (draft.acknowledged) return null;
  return view(draft);
}

/**
 * Marks this draft as delivered, so nothing can type it again.
 *
 * The page acknowledges after it has typed and sent — or after it has decided it cannot —
 * and both are the same fact here: this draft is spent.
 */
export function ackGoalDraft(conversationId: string, token: string, clientId?: string): boolean {
  const draft = drafts.get(conversationId);
  if (!draft || draft.token !== token) return false;
  if (clientId !== undefined && draft.clientId !== clientId) return false;
  draft.acknowledged = true;
  // An acknowledgement can also mean "this draft will never be sent" (Goal Mode was switched
  // off, the chat moved on, or the composer stayed occupied). Do not keep spending the user's
  // OpenRouter key after the browser has explicitly retired the draft. If the request has not
  // reached fetch yet, run() observes `acknowledged` at its next await boundary; if it has,
  // aborting the controller closes the stream immediately.
  draft.abort?.abort();
  if (draft.settledAt === 0) draft.settledAt = Date.now();
  return true;
}

/**
 * Retires every outstanding generation when Goal authority/settings are revoked or replaced.
 *
 * Disabling Goal, changing the model/reasoning, or replacing its credential must affect work
 * that is already in flight, not only the next draft. Each entry stays as a spent tombstone so
 * a reload cannot re-draft the same finished ChatGPT turn after the cancellation.
 */
export function retireGoalDrafts(): number {
  let retired = 0;
  for (const draft of drafts.values()) {
    if (draft.acknowledged) continue;
    draft.acknowledged = true;
    draft.abort?.abort();
    if (draft.settledAt === 0) draft.settledAt = Date.now();
    draft.text = '';
    draft.reply = '';
    retired += 1;
  }
  return retired;
}

export function resetGoalStateForTests(): void {
  for (const draft of drafts.values()) draft.abort?.abort();
  drafts.clear();
  firstUserCache.clear();
  modelCache = null;
}

export interface StartGoalDraftInput {
  sessionId: string;
  conversationId: string;
  /** The generation whose answer triggered this. The draft's identity. */
  turnId: string;
  /** Browser-tab ownership fence. Omitted only by direct/legacy callers. */
  clientId?: string;
}

/**
 * Starts one draft for one finished turn, or hands back the one that already exists.
 *
 * Returns immediately: drafting takes tens of seconds and the page is polling `/activity`
 * anyway, so the stream lands there rather than being held open on one request that a
 * service-worker restart would drop.
 */
export function startGoalDraft(input: StartGoalDraftInput): GoalDraftView {
  const existing = drafts.get(input.conversationId);
  const clientId = input.clientId ?? '';
  if (existing) expireDraftPayload(existing);
  // A Goal reply is an irreversible browser-side write. Conversation identity alone is not
  // enough because two tabs can show the same ChatGPT chat and both poll /activity. Keep one
  // tab as the writer until that draft is spent/expired; a second observer must not abort it,
  // replace its local generation id, or receive its token to type independently.
  if (existing && !existing.acknowledged && existing.clientId !== clientId) {
    throw new Error('goal_owned_elsewhere');
  }
  // Same turn, same draft. This is the idempotency that keeps a retried POST or a second
  // request from the owning tab from putting two messages into one conversation.
  if (existing && existing.turnId === input.turnId) return view(existing);
  // A different turn supersedes whatever the last one left behind, including an unfinished
  // request: the answer it was writing was about a conversation that has since moved on.
  if (existing) {
    existing.abort?.abort();
    drafts.delete(input.conversationId);
  }
  const settings = getConfig().goal;
  const draft: GoalDraft = {
    token: `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    clientId,
    turnId: input.turnId,
    stage: 'sending',
    model: settings.model,
    text: '',
    reply: '',
    error: null,
    startedAt: Date.now(),
    settledAt: 0,
    acknowledged: false,
    work: null,
    abort: null
  };
  drafts.set(input.conversationId, draft);
  draft.work = run(draft).catch((err: Error) => {
    settle(draft, 'failed', `goal_failed: ${err.message}`);
  });
  return view(draft);
}

function settle(draft: GoalDraft, stage: GoalStage, error: string | null = null): void {
  // A draft that was superseded is no longer this chat's draft, and must not be able to
  // publish a reply into the one that replaced it.
  if (drafts.get(draft.conversationId) !== draft) return;
  draft.stage = stage;
  draft.error = error;
  draft.settledAt = Date.now();
}

async function run(draft: GoalDraft): Promise<void> {
  const key = await getSecret('openRouterApiKey');
  if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;
  if (!key) return settle(draft, 'failed', 'no_api_key');
  const messages = await conversationMessages(draft.sessionId);
  if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;
  // Goal Mode is supposed to continue *the user's objective*. A partially recovered recorder
  // can contain assistant prose without the user row that gave it meaning; treating that as a
  // usable conversation asks the second model to invent what the user wants and can create a
  // brand-new task. Fail closed until at least one recorded user message anchors the request.
  if (messages.length === 0 || !messages.some((message) => message.role === 'user')) {
    return settle(draft, 'failed', 'no_conversation');
  }

  const abort = new AbortController();
  draft.abort = abort;
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    const settings = getConfig().goal;
    const body: Record<string, unknown> = {
      model: draft.model,
      stream: true,
      messages: [{ role: 'system', content: goalSystemPrompt() }, ...messages]
    };
    // `default` means "send nothing and let the provider decide", which is not the same as
    // sending an effort the model may not have.
    if (settings.reasoning !== 'default') body['reasoning'] = { effort: settings.reasoning };

    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...ATTRIBUTION_HEADERS
      },
      body: JSON.stringify(body),
      signal: abort.signal
    });
    if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;
    if (!response.ok || !response.body) {
      return settle(draft, 'failed', await httpFailure(response));
    }
    draft.stage = 'answering';
    const text = await readStream(response.body, draft);
    if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;
    const reply = text.trim();
    if (!reply) return settle(draft, 'failed', 'empty_reply');
    if (NO_REPLY.test(reply)) {
      logInfo(`goal: ${draft.model} says the goal is met in ${draft.conversationId}; nothing was sent`);
      draft.reply = '';
      return settle(draft, 'no-reply');
    }
    // Typed rather than written. See humanReply: the em dashes go, and a couple of the
    // mistakes a person leaves behind go in. After the NO_REPLY test above, never before it.
    draft.reply = humanReply(reply);
    logInfo(`goal: drafted ${reply.length} characters for ${draft.conversationId} with ${draft.model}`);
    settle(draft, 'ready');
  } catch (err) {
    const detail = (err as Error).message;
    const failure = abort.signal.aborted
      ? 'timeout_or_cancelled'
      : detail === 'reply_too_long' || detail === 'stream_record_too_long'
        ? detail
        : `request_failed: ${detail}`;
    logWarn(`goal: draft for ${draft.conversationId} failed — ${failure}`);
    settle(draft, 'failed', failure);
  } finally {
    clearTimeout(timer);
    draft.abort = null;
  }
}

/** The failure in words the page can put on screen, without leaking the key back out. */
async function httpFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const raw = await boundedResponseText(response, MAX_ERROR_BODY_BYTES);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? (parsed as { error?: { message?: unknown } }).error?.message
        : null;
    detail = typeof message === 'string' ? message.slice(0, 200) : raw.slice(0, 200);
  } catch (error) {
    // A body that is neither JSON nor readable adds nothing the status code does not say.
    // Oversize is worth naming because it explains why otherwise useful provider prose was
    // intentionally not read.
    if (error instanceof Error && error.message === 'response_body_too_large') detail = 'response body too large';
  }
  if (response.status === 401 || response.status === 403) return `auth_rejected: ${detail || 'the OpenRouter key was refused'}`;
  if (response.status === 402) return `out_of_credit: ${detail || 'the OpenRouter account is out of credit'}`;
  if (response.status === 404) return `unknown_model: ${detail || 'OpenRouter does not know that model id'}`;
  if (response.status === 429) return `rate_limited: ${detail || 'OpenRouter is rate-limiting this key'}`;
  return `http_${response.status}${detail ? `: ${detail}` : ''}`;
}

/**
 * Reads one provider response under a byte ceiling without ever first materialising an
 * unbounded string/ArrayBuffer. `Content-Length` is an early refusal only; streaming bytes are
 * counted too because a chunked or dishonest response is just as untrusted.
 */
async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response_body_too_large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('response_body_too_large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Best effort only; the size refusal itself is authoritative.
    }
    throw error;
  }
}

/**
 * Reads an SSE completion stream, publishing as it goes.
 *
 * OpenRouter sends `data:` lines with an OpenAI-shaped delta, `: ` comment lines as
 * keep-alives, and `data: [DONE]` at the end. A chunk can split a line anywhere, so the tail
 * of every chunk is carried into the next one; the version that assumed chunk boundaries were
 * line boundaries dropped whichever token happened to straddle one.
 */
async function readStream(body: ReadableStream<Uint8Array>, draft: GoalDraft): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';
  /** True means the OpenAI-compatible stream declared this completion finished. */
  const consume = (rawLine: string): boolean => {
    if (rawLine.length > MAX_SSE_RECORD_CHARS) throw new Error('stream_record_too_long');
    const line = rawLine.trim();
    if (!line || line.startsWith(':') || !line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (!payload) return false;
    if (payload === '[DONE]') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A non-empty data record is protocol, not decoration. Ignoring malformed JSON after
      // valid deltas promotes a provider-truncated sentence to a ready user message.
      throw new Error('malformed_stream_record');
    }
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const rawError = (parsed as { error?: unknown }).error;
      if (rawError) {
        const rawMessage =
          typeof rawError === 'string'
            ? rawError
            : rawError && typeof rawError === 'object' && 'message' in rawError
              ? (rawError as { message?: unknown }).message
              : null;
        const detail =
          typeof rawMessage === 'string'
            ? rawMessage.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200)
            : '';
        // OpenRouter can surface an upstream failure *inside* an already-200 SSE response,
        // including after some deltas were emitted. Ignoring that event turns a truncated
        // completion into a ready Goal message and types a sentence the model never finished.
        throw new Error(`provider_stream_error${detail ? `: ${detail}` : ''}`);
      }
    }
    const delta = deltaOf(parsed);
    if (!delta) return false;
    if (text.length + delta.length > MAX_MESSAGE_CHARS) throw new Error('reply_too_long');
    text += delta;
    // Published as it arrives: this is what the panel above the composer is streaming.
    if (drafts.get(draft.conversationId) === draft) draft.text = text;
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let cut = buffered.indexOf('\n');
      while (cut >= 0) {
        const line = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 1);
        if (consume(line)) {
          // `[DONE]` is a terminal protocol record, not a keep-alive. Do not wait for a proxy
          // to close the HTTP body and never accept provider/proxy junk after the declared end
          // as part of the user message. Cancelling also stops an otherwise lingering body from
          // spending the rest of the request timeout transferring bytes we will not consume.
          await reader.cancel().catch(() => undefined);
          return text;
        }
        cut = buffered.indexOf('\n');
      }
      if (buffered.length > MAX_SSE_RECORD_CHARS) throw new Error('stream_record_too_long');
    }
    // TextDecoder can still be holding the last bytes of a split UTF-8 code point, and an SSE
    // producer is allowed to close after its final `data:` record without a trailing newline.
    // The old parser discarded both pieces at EOF and turned an otherwise valid completion into
    // `empty_reply` (or silently lost its last token).
    buffered += decoder.decode();
    if (buffered.length > MAX_SSE_RECORD_CHARS) throw new Error('stream_record_too_long');
    if (buffered) consume(buffered);
    return text;
  } catch (error) {
    // Stop pulling a stream we have already refused. Without this, an upstream model that
    // ignored the short-reply instruction could keep transferring bytes after the draft had
    // become unusable locally.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function deltaOf(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const choice = choices[0] as { delta?: { content?: unknown }; message?: { content?: unknown } };
  const content = choice?.delta?.content ?? choice?.message?.content;
  return typeof content === 'string' ? content : '';
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The recent reader is deliberately tail-bounded. Once that tail saturates, preserve the one
 * old row Goal still semantically requires: what the user originally asked for. Cache only
 * successful lookups because a missing first user may simply mean recording is not there yet.
 */
const firstUserCache = new Map<string, ChatMessage>();

async function firstUserMessage(sessionId: string): Promise<ChatMessage | null> {
  const cached = firstUserCache.get(sessionId);
  if (cached) return cached;
  const [event] = await readEvents(sessionId, { kinds: ['user_message'], limit: 1 });
  if (!event || event.kind !== 'user_message') return null;
  const content = clip(event.message.text);
  if (!content) return null;
  const message: ChatMessage = { role: 'user', content };
  firstUserCache.set(sessionId, message);
  while (firstUserCache.size > 128) {
    const oldest = firstUserCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    firstUserCache.delete(oldest);
  }
  return message;
}

/**
 * The conversation as the goal model sees it: what the user asked, and what ChatGPT answered.
 *
 * Read from the local recording rather than from the page. Only *final* assistant messages
 * count — a streaming snapshot is the same answer half-written, and including both would
 * show the model the same reply twice with the shorter one second.
 */
export async function conversationMessages(sessionId: string): Promise<ChatMessage[]> {
  const recentLimit = MAX_CONTEXT_MESSAGES * 2;
  const events = await readRecentEvents(sessionId, recentLimit, {
    kinds: ['user_message', 'assistant_message']
  });
  const ordered: ChatMessage[] = [];
  const byStableMessage = new Map<string, number>();
  for (const event of events) {
    let next: ChatMessage | null = null;
    if (event.kind === 'user_message') {
      const content = clip(event.message.text);
      if (content) next = { role: 'user', content };
    } else if (event.kind === 'assistant_message' && event.final) {
      const content = clip(event.message.text);
      if (content) next = { role: 'assistant', content };
    }
    if (!next) continue;

    // Current recordings are canonicalized by the session store before they get here. Older
    // append-only sessions are still valid history, though, and can contain two final snapshots
    // of the same stable ChatGPT message after a remount/replay. Keep its first position but
    // replace the content with the newest snapshot. Id-less legacy rows remain distinct because
    // there is no identity strong enough to merge them safely.
    const stableId = 'messageId' in event && typeof event.messageId === 'string' && event.messageId ? event.messageId : null;
    const key = stableId ? `${event.kind}\u0000${stableId}` : null;
    const existingAt = key ? byStableMessage.get(key) : undefined;
    if (existingAt !== undefined) ordered[existingAt] = next;
    else {
      if (key) byStableMessage.set(key, ordered.length);
      ordered.push(next);
    }
  }
  // A saturated recent read does not prove it reached the start of the conversation. Its first
  // user can merely be the oldest follow-up still inside the tail, which makes the system
  // prompt's "what you originally asked for" instruction false. Resolve the actual first user
  // once in that case, while keeping everything sent to the provider bounded below.
  let firstUserAt = ordered.findIndex((message) => message.role === 'user');
  let firstUser = firstUserAt >= 0 ? ordered[firstUserAt]! : null;
  if (events.length >= recentLimit) {
    const original = await firstUserMessage(sessionId);
    if (original) {
      firstUser = original;
      // Equality by content is sufficient for the outgoing ChatMessage projection. If the
      // first recent user has the same text as the original, keeping that one avoids a duplicate;
      // otherwise the original lives outside the tail and gets its own reserved slot.
      if (firstUserAt < 0 || ordered[firstUserAt]?.content !== original.content) firstUserAt = -1;
    }
  }

  // If the whole bounded read fits and contains the true first-user anchor, preserve it exactly.
  // Otherwise Goal Mode needs two anchors at once: the newest work tells it what just happened,
  // while the first user message tells it what the work was for.
  const totalChars = ordered.reduce((sum, message) => sum + message.content.length, 0);
  if (firstUserAt >= 0 && ordered.length <= MAX_CONTEXT_MESSAGES && totalChars <= MAX_CONTEXT_CHARS) return ordered;

  const kept: ChatMessage[] = [];
  let chars = firstUser?.content.length ?? 0;
  const tailSlots = MAX_CONTEXT_MESSAGES - (firstUser ? 1 : 0);
  for (let at = ordered.length - 1; at >= 0 && kept.length < tailSlots; at--) {
    if (at === firstUserAt) continue;
    const message = ordered[at]!;
    if (chars + message.content.length > MAX_CONTEXT_CHARS) break;
    chars += message.content.length;
    kept.push(message);
  }
  kept.reverse();
  if (firstUser) kept.unshift(firstUser);
  return kept;
}

/*
 * ---------------------------------------------------------------------------------------
 * Typing it, rather than writing it
 * ---------------------------------------------------------------------------------------
 *
 * Two things give away a chat message a model composed, and neither of them survives being
 * asked nicely in a system prompt.
 *
 * The first is the em dash. It is not on a keyboard, nobody reaches for it halfway through
 * firing off a follow-up, and one of them in a lowercase two-sentence message is the whole
 * tell on its own.
 *
 * The second is that the message is *clean*. Real messages in a conversation like this one
 * have a dropped apostrophe or a transposed pair in them, because the person typing them did
 * not go back to fix it. A model asked to write casually still writes correctly.
 *
 * Both are applied to the finished reply, after `NO_REPLY` has been ruled out: the stopping
 * condition is matched against what the model actually said, never against a string this
 * file has been editing.
 *
 * ## Why none of it is random
 *
 * One finished turn is one message. A retried POST, a second observer and a reloaded tab all
 * ask for the same draft again, and the idempotency that keeps two messages out of somebody's
 * conversation only holds if asking twice returns the identical string. Anything drawn from a
 * clock or `Math.random` would quietly turn one draft into several different messages
 * depending on who asked and when. So the seed is the draft itself.
 */

/** FNV-1a over the draft, so every choice below is the draft's own and never a clock's. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0 || 1;
}

/** xorshift32. Small, and the only thing it decides is which words carry the mistakes. */
function stepped(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/**
 * The em dash, and the spaced en dash that is the same move by another character.
 *
 * A comma is what that sentence looks like when it is typed instead, so that is the default.
 * The exceptions are the shapes where a comma would be wrong or doubled: a dash opening or
 * closing a line is a bullet or a trailing thought and simply goes, a dash already sitting
 * against punctuation leaves a space behind, and a dash between two digits is a range and
 * becomes the hyphen somebody would actually have reached for.
 *
 * The whitespace class is horizontal only. A plain `\s*` would have swallowed the newlines
 * around a dash at the start of a line and welded a list into one paragraph.
 */
function undash(text: string): string {
  return text.replace(/[^\S\r\n]*[—–][^\S\r\n]*/g, (match, at: number, whole: string) => {
    const before = at > 0 ? whole[at - 1] : '';
    const after = whole[at + match.length] ?? '';
    if (!before || before === '\n') return '';
    if (!after || after === '\n') return '';
    if (/[0-9]/.test(before) && /[0-9]/.test(after)) return '-';
    if (/[,;:]/.test(before) || /[,;:.!?]/.test(after)) return ' ';
    return ', ';
  });
}

/**
 * Text a mistake must never be put into.
 *
 * A typo is only harmless in prose. Inside a path, a command, a URL or a file name it is a
 * different instruction, and the whole point of this message is that ChatGPT acts on it.
 */
const PROTECTED = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|\S+[\\/@]\S+|[\w-]+\.[\w-]+/g;

/** One plain lowercase word: no capitals, so an acronym or a model id is never a candidate. */
const CANDIDATE = /(?<![\w'’-])[a-z][a-z'’]{2,}[a-z](?![\w'’-])/g;

/**
 * The mistake this word would carry, or null when it has none available.
 *
 * In the order a real one happens. The dropped apostrophe is far and away the commonest and
 * the least jarring to read, so it is tried first; the collapsed double letter next; the
 * transposition last, because it is the most visible and a message full of them reads as
 * broken rather than as fast.
 */
function mistyped(word: string): string | null {
  if (/['’]/.test(word)) {
    const dropped = word.replace(/['’]/g, '');
    if (dropped.length >= 3 && dropped !== word) return dropped;
  }
  if (word.length >= 5) {
    const doubled = /([a-z])\1/.exec(word);
    if (doubled) return word.slice(0, doubled.index) + word.slice(doubled.index + 1);
  }
  if (word.length >= 5) {
    // Never the first or last letter: those are the two a reader recognises a word by at a
    // glance, and swapping either reads as a different word rather than as a slip.
    for (let at = Math.floor((word.length - 1) / 2); at >= 1; at--) {
      if (at + 1 <= word.length - 2 && word[at] !== word[at + 1]) {
        return word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
      }
    }
  }
  return null;
}

/** Every word that could carry a mistake, with where it is and what it becomes. */
function typoSites(text: string): Array<{ at: number; word: string; typo: string }> {
  const guarded: Array<[number, number]> = [];
  PROTECTED.lastIndex = 0;
  for (let found = PROTECTED.exec(text); found; found = PROTECTED.exec(text)) {
    guarded.push([found.index, found.index + found[0].length]);
  }
  const out: Array<{ at: number; word: string; typo: string }> = [];
  CANDIDATE.lastIndex = 0;
  for (let found = CANDIDATE.exec(text); found; found = CANDIDATE.exec(text)) {
    const at = found.index;
    const word = found[0];
    if (guarded.some(([from, to]) => at < to && at + word.length > from)) continue;
    const typo = mistyped(word);
    if (typo) out.push({ at, word, typo });
  }
  return out;
}

/**
 * The finished draft, as it would have been typed.
 *
 * `undash` always runs. The mistakes are deliberately few — one, and one more for every
 * couple of hundred characters after that, never more than three — because a message with a
 * slip in every sentence is a tell of its own in the other direction. They are spread by
 * dividing the candidate words into that many buckets and taking one from each, so two of
 * them never land in the same breath.
 */
export function humanReply(reply: string): string {
  const text = undash(reply);
  const sites = typoSites(text);
  if (sites.length === 0) return text;
  const wanted = Math.min(3, 1 + Math.floor(text.length / 220));
  const next = stepped(seedOf(text));
  const chosen = new Set<number>();
  const bucket = sites.length / wanted;
  for (let index = 0; index < wanted; index++) {
    const from = Math.floor(index * bucket);
    const to = Math.max(from + 1, Math.min(sites.length, Math.floor((index + 1) * bucket)));
    chosen.add(from + (next() % (to - from)));
  }
  let out = text;
  // Back to front, so an edit never moves the offset of one still to come.
  for (const index of [...chosen].sort((a, b) => b - a)) {
    const site = sites[index]!;
    out = out.slice(0, site.at) + site.typo + out.slice(site.at + site.word.length);
  }
  return out;
}

function clip(text: string): string {
  const trimmed = (text ?? '').trim();
  if (trimmed.length <= MAX_MESSAGE_CHARS) return trimmed;
  // Goal Mode is specifically trying to decide what still remains after ChatGPT's *finished*
  // answer. Long answers commonly put the verification/result/conclusion at the end, so keeping
  // only the prefix can remove the exact evidence needed to stop the loop and make it ask for
  // work that is already done. Preserve both ends inside the same hard per-message budget.
  const marker = '\n[… cut …]\n';
  const contentBudget = MAX_MESSAGE_CHARS - marker.length;
  const head = Math.ceil(contentBudget / 2);
  const tail = contentBudget - head;
  return `${trimmed.slice(0, head)}${marker}${trimmed.slice(-tail)}`;
}

export interface GoalModel {
  id: string;
  name: string;
  /** Unix seconds, as OpenRouter publishes it. 0 when the listing did not say. */
  created: number;
  contextLength: number;
}

let modelCache: { at: number; keyScope: string; models: GoalModel[] } | null = null;

/**
 * The models OpenRouter currently publishes, newest first.
 *
 * Sorted by release date rather than alphabetically or by popularity, because the question
 * this picker answers is "what is new" — the whole reason to open it is that a better model
 * exists than the one already chosen. Paged, because the listing is several hundred long and
 * nobody scrolls that.
 */
export async function listGoalModels(offset = 0, limit = MODEL_PAGE_SIZE): Promise<{ models: GoalModel[]; total: number }> {
  const models = await allGoalModels();
  const from = Math.max(0, Math.floor(offset));
  const count = Math.max(1, Math.min(100, Math.floor(limit)));
  return { models: models.slice(from, from + count), total: models.length };
}

async function allGoalModels(): Promise<GoalModel[]> {
  const key = await getSecret('openRouterApiKey');
  // OpenRouter may return a key-restricted catalogue. A cache filled under key A is therefore
  // not valid under key B. Keep only a one-way fingerprint beside the models rather than the
  // credential itself; replacing a key immediately changes the cache scope without retaining
  // either secret for the five-minute listing TTL.
  const keyScope = key ? createHash('sha256').update(key).digest('hex') : 'public';
  if (modelCache && modelCache.keyScope === keyScope && Date.now() - modelCache.at < MODEL_CACHE_MS) {
    return modelCache.models;
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), MODEL_LIST_TIMEOUT_MS);
  let response: Response;
  let parsed: unknown;
  try {
    response = await fetch(`${OPENROUTER_BASE}/models`, {
      headers: {
        // The listing is public; the key is sent when there is one so a key with a restricted
        // model set sees its own set rather than the catalogue.
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...ATTRIBUTION_HEADERS
      },
      signal: abort.signal
    });
    if (!response.ok) throw new Error(`OpenRouter would not list its models (HTTP ${response.status})`);
    const raw = await boundedResponseText(response, MAX_MODEL_LIST_BODY_BYTES);
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error('OpenRouter returned a model list this app could not read');
    }
  } catch (error) {
    if (abort.signal.aborted) throw new Error('OpenRouter model list request timed out');
    if (error instanceof Error && error.message === 'response_body_too_large') {
      throw new Error('OpenRouter model list response body was too large');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const raw = parsed && typeof parsed === 'object' ? (parsed as { data?: unknown }).data : null;
  if (!Array.isArray(raw)) throw new Error('OpenRouter returned a model list this app could not read');
  const models: GoalModel[] = [];
  for (const entry of raw) {
    if (models.length >= MAX_MODELS) break;
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as { id?: unknown; name?: unknown; created?: unknown; context_length?: unknown };
    if (typeof model.id !== 'string' || model.id === '' || model.id.length > MAX_MODEL_FIELD_CHARS) continue;
    models.push({
      id: model.id,
      name:
        typeof model.name === 'string' && model.name
          ? model.name.slice(0, MAX_MODEL_FIELD_CHARS)
          : model.id,
      created: typeof model.created === 'number' && Number.isFinite(model.created) ? model.created : 0,
      contextLength:
        typeof model.context_length === 'number' && Number.isFinite(model.context_length) ? model.context_length : 0
    });
  }
  // Newest first, and ties broken by id so the order is stable between two identical calls
  // rather than dependent on the listing's own arrival order.
  models.sort((a, b) => (b.created - a.created) || a.id.localeCompare(b.id));
  modelCache = { at: Date.now(), keyScope, models };
  return models;
}
