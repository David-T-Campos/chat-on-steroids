/**
 * Conversation-scoped recurring work, modelled after Claude Code's /loop architecture.
 *
 * This is a clean-room implementation from documented/shipped behaviour, not Anthropic
 * source. Two scheduling modes intentionally share one durable state machine:
 *
 *   fixed   — the app owns the cadence. The first iteration runs immediately and future
 *             iterations become due on a fixed normalized interval.
 *   dynamic — the model does the work, then chooses its next one-shot wakeup through the
 *             `loop` MCP tool. A missing reschedule gets one ~20 minute fallback iteration;
 *             missing it a second time ends the loop.
 *
 * A due turn is not pushed into arbitrary tabs. `/activity` asks for a draft for one exact
 * conversation and browser client, and the page sends it only while the composer is safe.
 * That makes scheduled work idle-only, prevents catch-up bursts, and gives reload/duplicate
 * observers the same idempotency fence Goal Mode uses.
 */

import { randomBytes } from 'node:crypto';
import { writeDurableNow, writeDurableSoon } from './durable.js';

export const LOOPS_STATE = 'loops';
export const LOOP_TTL_MS = 7 * 24 * 60 * 60_000;
export const DYNAMIC_MIN_DELAY_SECONDS = 60;
export const DYNAMIC_MAX_DELAY_SECONDS = 60 * 60;
export const DYNAMIC_FALLBACK_MS = 20 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const RETRY_DRAFT_MS = 30_000;
const MAX_INPUT_CHARS = 24_000;
const MAX_PROMPT_CHARS = 20_000;
const MAX_REASON_CHARS = 600;

export type LoopMode = 'fixed' | 'dynamic';

export interface ParsedLoopCommand {
  action: 'start' | 'clear' | 'status';
  mode: LoopMode;
  prompt: string;
  intervalSeconds: number | null;
  requestedInterval: string | null;
  normalizedInterval: string | null;
  usedDefaultPrompt: boolean;
}

interface LoopRecord {
  conversationId: string;
  mode: LoopMode;
  prompt: string;
  sourceInput: string;
  intervalSeconds: number | null;
  requestedInterval: string | null;
  normalizedInterval: string | null;
  createdAt: number;
  expiresAt: number;
  nextAt: number | null;
  runCount: number;
  lastRunAt: number | null;
  reason: string;
  noOpStreak: number;
  fallbackArmed: boolean;
  fallbackMisses: number;
  generation: number;
}

interface PendingLoop {
  clientId: string;
  parsed: ParsedLoopCommand;
  sourceInput: string;
  createdAt: number;
  expiresAt: number;
}

export interface LoopDraftView {
  token: string;
  conversationId: string;
  mode: LoopMode;
  prompt: string;
  reason: string;
  runCount: number;
  expiresAt: number;
}

interface LoopDraft extends LoopDraftView {
  clientId: string;
  generation: number;
}

export interface LoopView {
  active: boolean;
  mode: LoopMode | null;
  prompt: string;
  requestedInterval: string | null;
  normalizedInterval: string | null;
  nextAt: number | null;
  createdAt: number | null;
  expiresAt: number | null;
  runCount: number;
  lastRunAt: number | null;
  reason: string;
  noOpStreak: number;
  fallback: boolean;
  draft: LoopDraftView | null;
}

interface DurableLoopRecord extends Omit<LoopRecord, 'conversationId'> {
  conversationId: string;
}

interface DurablePendingLoop {
  clientId: string;
  parsed: ParsedLoopCommand;
  sourceInput: string;
  createdAt: number;
  expiresAt: number;
}

export interface LoopsSnapshot {
  version: 1;
  savedAt: number;
  entries: DurableLoopRecord[];
  pending: DurablePendingLoop[];
}

const loops = new Map<string, LoopRecord>();
const pending = new Map<string, PendingLoop>();
const drafts = new Map<string, LoopDraft>();
let generation = 1;

/**
 * The no-argument maintenance policy is deliberately our own wording. It follows the public
 * Claude Code contract without copying Anthropic's bundled prompt: finish current authorized
 * work first, maintain the current PR second, then do conservative validation/cleanup, and do
 * not manufacture a new initiative merely because a timer fired.
 */
export const DEFAULT_LOOP_PROMPT = [
  'Continue useful maintenance for the work already established in this conversation.',
  'First finish any explicit unfinished implementation, verification, review response, or other commitment already in progress.',
  'If that is settled and the current branch has a pull request, check its review threads, failing CI, conflicts, and whether it is behind its base; diagnose before changing anything.',
  'If the work is otherwise quiet, run relevant verification or small reversible cleanup that directly improves the existing task.',
  'Do not invent a new project or unrelated initiative just because this is a scheduled turn.',
  'Only take irreversible or externally consequential actions when the conversation already clearly authorizes that same action pattern.',
  'If there is genuinely nothing actionable, say so briefly.'
].join('\n\n');

function token(): string {
  return randomBytes(18).toString('base64url');
}

function cleanInput(raw: string): string {
  return String(raw || '').replace(/\r/g, '').trim().slice(0, MAX_INPUT_CHARS);
}

function cleanPrompt(raw: string): string {
  return String(raw || '').trim().slice(0, MAX_PROMPT_CHARS);
}

function compactUnit(unit: string): 's' | 'm' | 'h' | 'd' | null {
  const value = unit.toLowerCase();
  if (value === 's' || value.startsWith('second')) return 's';
  if (value === 'm' || value.startsWith('minute')) return 'm';
  if (value === 'h' || value.startsWith('hour')) return 'h';
  if (value === 'd' || value.startsWith('day')) return 'd';
  return null;
}

function secondsFor(amount: number, unit: 's' | 'm' | 'h' | 'd'): number {
  if (unit === 's') return Math.ceil(amount / 60) * 60;
  if (unit === 'm') return amount * 60;
  if (unit === 'h') return amount * 60 * 60;
  return amount * 24 * 60 * 60;
}

function closest(target: number, candidates: readonly number[]): number {
  return candidates.reduce((best, value) =>
    Math.abs(value - target) < Math.abs(best - target) ? value : best
  );
}

/**
 * A five-field cron expression cannot express an arbitrary elapsed duration exactly. Claude
 * Code rounds awkward intervals to a clean cron cadence and tells the user. Preserve that
 * semantic property even though this app stores the cadence as seconds rather than a cron
 * string: sub-hour intervals use divisors of an hour, hour intervals divisors of a day, and
 * longer intervals use whole days. This makes `7m` become a stable wall-clock-friendly
 * cadence instead of drifting through hour boundaries, and `90m` becomes two hours.
 */
export function normalizeFixedInterval(requestedSeconds: number): number {
  const seconds = Math.max(60, Math.floor(requestedSeconds));
  if (seconds < 60 * 60) {
    const minutes = seconds / 60;
    const cleanMinutes = closest(minutes, [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]);
    return cleanMinutes * 60;
  }
  if (seconds <= 24 * 60 * 60) {
    const hours = seconds / (60 * 60);
    const cleanHours = closest(hours, [1, 2, 3, 4, 6, 8, 12, 24]);
    return cleanHours * 60 * 60;
  }
  const days = Math.max(1, Math.round(seconds / (24 * 60 * 60)));
  return days * 24 * 60 * 60;
}

function intervalLabel(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const value = seconds / 86_400;
    return `${value} day${value === 1 ? '' : 's'}`;
  }
  if (seconds % 3_600 === 0) {
    const value = seconds / 3_600;
    return `${value} hour${value === 1 ? '' : 's'}`;
  }
  const value = seconds / 60;
  return `${value} minute${value === 1 ? '' : 's'}`;
}

function stripCommand(raw: string): string {
  const input = cleanInput(raw);
  const match = /^\/(?:loop|proactive)(?:\s+|$)/i.exec(input);
  return match ? input.slice(match[0].length).trim() : input;
}

export function parseLoopCommand(raw: string): ParsedLoopCommand {
  let body = stripCommand(raw);
  const control = body.toLowerCase();
  if (['clear', 'stop', 'off', 'cancel'].includes(control)) {
    return {
      action: 'clear',
      mode: 'dynamic',
      prompt: '',
      intervalSeconds: null,
      requestedInterval: null,
      normalizedInterval: null,
      usedDefaultPrompt: false
    };
  }
  if (control === 'status') {
    return {
      action: 'status',
      mode: 'dynamic',
      prompt: '',
      intervalSeconds: null,
      requestedInterval: null,
      normalizedInterval: null,
      usedDefaultPrompt: false
    };
  }

  let requestedSeconds: number | null = null;
  let requestedInterval: string | null = null;

  // Claude gives the leading compact duration priority over any trailing "every …" phrase.
  const leading = /^(\d+)\s*([smhd])(?:\s+|$)/i.exec(body);
  if (leading) {
    const amount = Number.parseInt(leading[1], 10);
    const unit = compactUnit(leading[2]);
    if (Number.isFinite(amount) && amount > 0 && unit) {
      requestedSeconds = secondsFor(amount, unit);
      requestedInterval = leading[0].trim();
      body = body.slice(leading[0].length).trim();
    }
  } else {
    const trailing = /(?:^|\s)every\s+(\d+)\s*(s|m|h|d|seconds?|minutes?|hours?|days?)\s*$/i.exec(body);
    if (trailing) {
      const amount = Number.parseInt(trailing[1], 10);
      const unit = compactUnit(trailing[2]);
      if (Number.isFinite(amount) && amount > 0 && unit) {
        requestedSeconds = secondsFor(amount, unit);
        requestedInterval = trailing[0].trim();
        body = body.slice(0, trailing.index).trim();
      }
    }
  }

  const usedDefaultPrompt = cleanPrompt(body) === '';
  const prompt = usedDefaultPrompt ? DEFAULT_LOOP_PROMPT : cleanPrompt(body);
  if (requestedSeconds === null) {
    return {
      action: 'start',
      mode: 'dynamic',
      prompt,
      intervalSeconds: null,
      requestedInterval: null,
      normalizedInterval: null,
      usedDefaultPrompt
    };
  }
  const normalized = normalizeFixedInterval(requestedSeconds);
  return {
    action: 'start',
    mode: 'fixed',
    prompt,
    intervalSeconds: normalized,
    requestedInterval,
    normalizedInterval: intervalLabel(normalized),
    usedDefaultPrompt
  };
}

function iterationPrompt(record: Pick<LoopRecord, 'mode' | 'prompt'>): string {
  if (record.mode === 'fixed') {
    return [
      '[Chat On Steroids /loop — scheduled iteration]',
      '',
      'Execute the recurring task below now, using the current conversation and current machine state:',
      '',
      record.prompt,
      '',
      'The app already owns the fixed schedule. Do not create another timer or duplicate schedule. Complete this iteration normally.'
    ].join('\n');
  }
  return [
    '[Chat On Steroids /loop — self-paced iteration]',
    '',
    'Execute the recurring task below now, using the current conversation and current machine state:',
    '',
    record.prompt,
    '',
    'At the end of this iteration, make an explicit pacing decision with the `loop` tool.',
    `If more work should happen later, call action=schedule_wakeup with delay_seconds between ${DYNAMIC_MIN_DELAY_SECONDS} and ${DYNAMIC_MAX_DELAY_SECONDS}, a specific one-sentence reason, and noop=true only when this iteration observed no meaningful change.`,
    'Choose the delay from what you actually observed; do not wake merely to keep a cache warm or to busy-poll work that already has its own completion signal.',
    'If the recurring task is finished or should no longer continue, call action=stop instead.'
  ].join('\n');
}

function recordFromParsed(conversationId: string, parsed: ParsedLoopCommand, sourceInput: string, now: number): LoopRecord {
  return {
    conversationId,
    mode: parsed.mode,
    prompt: parsed.prompt,
    sourceInput: cleanInput(sourceInput),
    intervalSeconds: parsed.intervalSeconds,
    requestedInterval: parsed.requestedInterval,
    normalizedInterval: parsed.normalizedInterval,
    createdAt: now,
    expiresAt: now + LOOP_TTL_MS,
    // The command's own turn is iteration one. Fixed schedules wait one interval after it.
    // Dynamic mode also arms the runtime's single missing-reschedule fallback immediately;
    // a valid `loop` tool call replaces it before it can fire.
    nextAt:
      parsed.mode === 'fixed' && parsed.intervalSeconds
        ? now + parsed.intervalSeconds * 1000
        : now + DYNAMIC_FALLBACK_MS,
    runCount: 1,
    lastRunAt: now,
    reason: parsed.mode === 'dynamic' ? 'waiting for the first self-paced wakeup decision' : '',
    noOpStreak: 0,
    fallbackArmed: parsed.mode === 'dynamic',
    fallbackMisses: 0,
    generation: generation++
  };
}

function cleanExpired(now = Date.now()): boolean {
  let changed = false;
  for (const [id, record] of loops) {
    if (record.expiresAt <= now) {
      loops.delete(id);
      drafts.delete(id);
      changed = true;
    }
  }
  for (const [clientId, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(clientId);
      changed = true;
    }
  }
  return changed;
}

export function snapshotLoops(): LoopsSnapshot {
  cleanExpired();
  return {
    version: 1,
    savedAt: Date.now(),
    entries: [...loops.values()].map((entry) => ({ ...entry })),
    pending: [...pending.values()].map((entry) => ({ ...entry, parsed: { ...entry.parsed } }))
  };
}

function changed(): void {
  writeDurableSoon(LOOPS_STATE, snapshotLoops());
}

async function changedNow(): Promise<void> {
  await writeDurableNow(LOOPS_STATE, snapshotLoops());
}

export function restoreLoops(snapshot: LoopsSnapshot | null): void {
  loops.clear();
  pending.clear();
  drafts.clear();
  generation = 1;
  if (!snapshot || snapshot.version !== 1) return;
  const now = Date.now();
  for (const raw of Array.isArray(snapshot.entries) ? snapshot.entries : []) {
    if (!raw || typeof raw.conversationId !== 'string' || raw.expiresAt <= now) continue;
    if (raw.mode !== 'fixed' && raw.mode !== 'dynamic') continue;
    const entry: LoopRecord = {
      ...raw,
      prompt: cleanPrompt(raw.prompt),
      sourceInput: cleanInput(raw.sourceInput),
      reason: String(raw.reason || '').slice(0, MAX_REASON_CHARS),
      generation: Number.isInteger(raw.generation) ? raw.generation : generation++
    };
    if (!entry.prompt) continue;
    loops.set(entry.conversationId, entry);
    generation = Math.max(generation, entry.generation + 1);
  }
  for (const raw of Array.isArray(snapshot.pending) ? snapshot.pending : []) {
    if (!raw || typeof raw.clientId !== 'string' || raw.expiresAt <= now) continue;
    const parsed = raw.parsed;
    if (!parsed || parsed.action !== 'start' || (parsed.mode !== 'fixed' && parsed.mode !== 'dynamic')) continue;
    pending.set(raw.clientId.slice(0, 100), {
      clientId: raw.clientId.slice(0, 100),
      parsed: { ...parsed, prompt: cleanPrompt(parsed.prompt) },
      sourceInput: cleanInput(raw.sourceInput),
      createdAt: Number(raw.createdAt) || now,
      expiresAt: Number(raw.expiresAt) || now + PENDING_TTL_MS
    });
  }
  if (cleanExpired(now)) changed();
}

export function loopForConversation(conversationId: string): LoopRecord | null {
  if (cleanExpired()) changed();
  return loops.get(conversationId) ?? null;
}

function publicView(record: LoopRecord | null, draft: LoopDraftView | null): LoopView {
  if (!record) {
    return {
      active: false,
      mode: null,
      prompt: '',
      requestedInterval: null,
      normalizedInterval: null,
      nextAt: null,
      createdAt: null,
      expiresAt: null,
      runCount: 0,
      lastRunAt: null,
      reason: '',
      noOpStreak: 0,
      fallback: false,
      draft: null
    };
  }
  return {
    active: true,
    mode: record.mode,
    prompt: record.prompt,
    requestedInterval: record.requestedInterval,
    normalizedInterval: record.normalizedInterval,
    nextAt: record.nextAt,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    runCount: record.runCount,
    lastRunAt: record.lastRunAt,
    reason: record.reason,
    noOpStreak: record.noOpStreak,
    fallback: record.fallbackArmed,
    draft
  };
}

export function loopStateFor(conversationId: string): LoopView {
  const record = loopForConversation(conversationId);
  const draft = drafts.get(conversationId) ?? null;
  return publicView(record, draft);
}

export async function startLoopNow(
  conversationId: string,
  raw: string
): Promise<{ parsed: ParsedLoopCommand; prompt: string | null; view: LoopView; message: string }> {
  const parsed = parseLoopCommand(raw);
  if (parsed.action === 'clear') {
    const cleared = await clearLoopNow(conversationId);
    return { parsed, prompt: null, view: loopStateFor(conversationId), message: cleared ? 'Loop stopped.' : 'No loop was active.' };
  }
  if (parsed.action === 'status') {
    return { parsed, prompt: null, view: loopStateFor(conversationId), message: loopStatusText(conversationId) };
  }
  const now = Date.now();
  const record = recordFromParsed(conversationId, parsed, raw, now);
  const previous = loops.get(conversationId);
  loops.set(conversationId, record);
  drafts.delete(conversationId);
  try {
    await changedNow();
  } catch (error) {
    if (previous) loops.set(conversationId, previous);
    else loops.delete(conversationId);
    throw error;
  }
  return {
    parsed,
    prompt: iterationPrompt(record),
    view: publicView(record, null),
    message:
      record.mode === 'fixed'
        ? `Loop started; first run is now, then ${record.normalizedInterval}.`
        : 'Self-paced loop started; the model will choose each next wakeup.'
  };
}

export async function openPendingLoopNow(
  clientId: string,
  raw: string
): Promise<{ parsed: ParsedLoopCommand; prompt: string | null; message: string }> {
  const parsed = parseLoopCommand(raw);
  const key = clientId.slice(0, 100);
  if (parsed.action !== 'start') {
    pending.delete(key);
    changed();
    return {
      parsed,
      prompt: null,
      message: parsed.action === 'status' ? 'This New Chat has no conversation-scoped loop yet.' : 'No loop was active.'
    };
  }
  const now = Date.now();
  pending.set(key, {
    clientId: key,
    parsed,
    sourceInput: cleanInput(raw),
    createdAt: now,
    expiresAt: now + PENDING_TTL_MS
  });
  await changedNow();
  return {
    parsed,
    prompt: iterationPrompt({ mode: parsed.mode, prompt: parsed.prompt }),
    message: parsed.mode === 'fixed' ? 'Loop will bind to the new chat after its first send.' : 'Self-paced loop will bind to the new chat after its first send.'
  };
}

export async function claimPendingLoopNow(clientId: string, conversationId: string): Promise<boolean> {
  cleanExpired();
  const key = clientId.slice(0, 100);
  const entry = pending.get(key);
  if (!entry) return false;
  const now = Date.now();
  const record = recordFromParsed(conversationId, entry.parsed, entry.sourceInput, now);
  // The first iteration already started before ChatGPT minted its conversation id. Keep that
  // as run one rather than scheduling a second immediate copy during the bind.
  loops.set(conversationId, record);
  pending.delete(key);
  drafts.delete(conversationId);
  await changedNow();
  return true;
}

export async function clearLoopNow(conversationId: string): Promise<boolean> {
  const existed = loops.delete(conversationId);
  drafts.delete(conversationId);
  if (existed) await changedNow();
  return existed;
}

export async function scheduleDynamicWakeup(
  conversationId: string,
  delaySeconds: number,
  reason: string,
  noop: boolean
): Promise<LoopView> {
  const record = loopForConversation(conversationId);
  if (!record) throw new Error('LOOP_NOT_ACTIVE');
  if (record.mode !== 'dynamic') throw new Error('LOOP_NOT_DYNAMIC');
  const delay = Math.max(DYNAMIC_MIN_DELAY_SECONDS, Math.min(DYNAMIC_MAX_DELAY_SECONDS, Math.round(delaySeconds)));
  record.nextAt = Date.now() + delay * 1000;
  record.reason = String(reason || '').trim().slice(0, MAX_REASON_CHARS) || `resume in ${delay} seconds`;
  record.noOpStreak = noop ? record.noOpStreak + 1 : 0;
  record.fallbackArmed = false;
  record.fallbackMisses = 0;
  record.generation = generation++;
  drafts.delete(conversationId);
  await changedNow();
  return publicView(record, null);
}

export async function stopDynamicLoop(conversationId: string): Promise<boolean> {
  const record = loopForConversation(conversationId);
  if (!record) return false;
  if (record.mode !== 'dynamic') throw new Error('LOOP_NOT_DYNAMIC');
  return clearLoopNow(conversationId);
}

/**
 * Returns/claims a due scheduled message for this exact browser client. Merely reading status
 * never advances a schedule. The first client to claim a due generation owns it until it ACKs;
 * a duplicate tab gets null rather than the same user message.
 */
export function loopViewFor(conversationId: string, clientId: string): LoopView {
  if (cleanExpired()) changed();
  const record = loops.get(conversationId) ?? null;
  if (!record) return publicView(null, null);

  const held = drafts.get(conversationId);
  if (held) {
    return publicView(record, held.clientId === clientId ? held : null);
  }
  const now = Date.now();
  if (!clientId || record.nextAt === null || record.nextAt > now) return publicView(record, null);

  // One fallback is the runtime's recovery for a dynamic iteration that forgot its pacing
  // decision. If the fallback iteration itself later forgets too, ackLoopDraft stops it.
  if (record.mode === 'dynamic') {
    if (record.fallbackArmed) record.fallbackMisses += 1;
    record.fallbackArmed = false;
    record.nextAt = null;
  } else {
    const seconds = Math.max(60, record.intervalSeconds ?? 60);
    // No catch-up. A laptop asleep for three hours gets one run when it is observed idle,
    // then the next cadence starts from that fire.
    record.nextAt = now + seconds * 1000;
  }
  record.lastRunAt = now;
  record.runCount += 1;
  record.generation = generation++;
  const draft: LoopDraft = {
    token: token(),
    conversationId,
    clientId,
    generation: record.generation,
    mode: record.mode,
    prompt: iterationPrompt(record),
    reason: record.reason,
    runCount: record.runCount,
    expiresAt: record.expiresAt
  };
  drafts.set(conversationId, draft);
  changed();
  return publicView(record, draft);
}

export async function ackLoopDraft(
  conversationId: string,
  draftToken: string,
  clientId: string,
  sent: boolean
): Promise<boolean> {
  const draft = drafts.get(conversationId);
  if (!draft || draft.token !== draftToken || draft.clientId !== clientId) return false;
  drafts.delete(conversationId);
  const record = loops.get(conversationId);
  if (!record) return true;

  if (!sent) {
    // The page could not safely cross the send boundary (usually the user was typing).
    // Re-offer one fresh token later; never count it as an iteration and never catch up.
    record.runCount = Math.max(1, record.runCount - 1);
    record.nextAt = Date.now() + RETRY_DRAFT_MS;
    changed();
    return true;
  }

  if (record.mode === 'dynamic' && record.nextAt === null) {
    if (record.fallbackMisses >= 1) {
      // This was already the one runtime fallback and it still produced no pacing decision.
      loops.delete(conversationId);
      await changedNow();
      return true;
    }
    record.nextAt = Date.now() + DYNAMIC_FALLBACK_MS;
    record.reason = 'runtime fallback because the previous iteration did not schedule its next wakeup';
    record.fallbackArmed = true;
  }
  changed();
  return true;
}

export function moveLoopConversation(fromConversationId: string, toConversationId: string): boolean {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return false;
  const record = loops.get(fromConversationId);
  if (!record) return false;
  const prior = loops.get(toConversationId);
  // A target with a newer explicit loop wins; Compact & Resume must never overwrite work the
  // user already configured in the replacement chat.
  if (prior && prior.createdAt >= record.createdAt) {
    loops.delete(fromConversationId);
    drafts.delete(fromConversationId);
    changed();
    return false;
  }
  loops.delete(fromConversationId);
  drafts.delete(fromConversationId);
  record.conversationId = toConversationId;
  record.generation = generation++;
  loops.set(toConversationId, record);
  drafts.delete(toConversationId);
  changed();
  return true;
}

export function loopStatusText(conversationId: string): string {
  const record = loopForConversation(conversationId);
  if (!record) return 'No /loop is active in this chat.';
  const cadence =
    record.mode === 'fixed'
      ? `fixed ${record.normalizedInterval ?? intervalLabel(record.intervalSeconds ?? 60)}`
      : record.fallbackArmed
        ? 'self-paced (runtime fallback armed)'
        : 'self-paced';
  const next = record.nextAt ? new Date(record.nextAt).toLocaleString() : 'waiting for the model to schedule it';
  return `/loop is active: ${cadence}; ${record.runCount} run${record.runCount === 1 ? '' : 's'}; next ${next}.`;
}

export function resetLoopsForTests(): void {
  loops.clear();
  pending.clear();
  drafts.clear();
  generation = 1;
}
