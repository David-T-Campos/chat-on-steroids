/**
 * The multi-agent broker.
 *
 * Experimental and disabled by default. One ChatGPT conversation is the prime agent; it
 * spawns workers, each of which is a separate ChatGPT tab the extension opens. All state
 * lives here, in this app: the browser only opens tabs and types the first message.
 *
 * ## One run, bound to one conversation
 *
 * There is at most one run at a time, and a run *is* its prime conversation. The prime is
 * established by exactly one event — a successful `spawn` from a ChatGPT conversation this
 * app has proven the call came from — and `primeConversationId` never changes afterwards
 * except through the app's own authenticated Compact & Resume transfer. Nothing infers a
 * prime, nothing promotes one, nothing takes one over, and no chat becomes prime as a side
 * effect of anything else it does.
 *
 * That makes every other question a lookup rather than a guess:
 *
 *   · a call from `primeConversationId` is the prime;
 *   · a call from a worker's bound conversation is that worker;
 *   · every other conversation is a stranger, and while a run exists it is told
 *     `AGENTS_BUSY` and nothing else — never the run's contents.
 *
 * ## Why spawn is atomic
 *
 * `spawn` used to create workers and then work out who the prime was, which is how a chat
 * that was not the prime ended up owning worker chats. Here the order is fixed and every
 * step that can fail happens before the first mutation: prove the caller's conversation →
 * check it is not a worker → check no other run holds the swarm → claim it as prime →
 * create workers. If anything before the binding fails, zero workers exist.
 *
 * ## Why nobody holds a credential
 *
 * Every agent here is identified by *where it is*, and only by that. The prime is the
 * conversation the user is sitting in; a worker is the conversation this app opened for its
 * slot and watched itself open. Making a model carry a bearer secret through every tool call
 * put a routing token in the transcript for roles that a conversation id already names, and
 * a token the model has to remember is a token it can forget, paste into the wrong chat, or
 * have stripped by ChatGPT's own harness.
 *
 * ## A worker is a worker before it speaks
 *
 * The lifecycle transition is the app's, not the model's. The extension opens the tab, learns
 * its exact `/c/<id>`, and reports it; {@link bindConversation} binds *and activates* the slot
 * in one step, before the model in that chat has said anything. So the first user message in
 * a worker chat is the task itself — there is no handshake to perform, no key to quote, and
 * nothing a worker has to do before it can start working.
 */

import { randomUUID } from 'node:crypto';
import type { AgentInfo, AgentMessage, AgentState, SwarmState } from '../shared/session.js';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { inheritWorkspace } from './workspace.js';

export const PRIME_ID = 'prime';

/**
 * Unacknowledged messages held per agent before the broker pushes back.
 *
 * Reached only if an agent stops calling tools entirely while the other side keeps talking.
 * Dropping the oldest to make room quietly destroyed exactly the messages most likely to
 * matter while still telling the sender "Sent", so the limit is a refusal instead.
 */
const MAX_QUEUE = 200;
export const MAX_MESSAGE_CHARS = 4000;
/**
 * Messages one `message` call may carry.
 *
 * Sized to the run rather than to nothing in particular: the worker limit is 8, and the
 * batch that exists to redirect a whole run needs room for one message to each of them plus
 * a couple of corrections.
 */
export const MAX_BATCH_MESSAGES = 16;
const MAX_TASK_CHARS = 4000;
/**
 * The shared preamble one spawn may put in front of every worker's task.
 *
 * Its own budget rather than a share of the task's: the context is written once and the
 * tasks are written per worker, so charging one against the other would make adding a fourth
 * worker silently shrink the room for the standing instructions all four of them need.
 */
const MAX_CONTEXT_CHARS = 4000;
const MAX_LABEL_CHARS = 60;

/**
 * How long a Compact & Resume handover may stay open before the prime binding is released.
 *
 * The handover is the only window in which `primeConversationId` moves, so it is deliberately
 * short-lived: an unfinished one must not leave the run transferable to whatever chat opens
 * next, and an abandoned one must eventually let the prime's disappearance end the run.
 */
export const TRANSFER_TTL_MS = 10 * 60_000;

/**
 * How long a detached worker may make no proven tool call before the run gives up on it.
 *
 * The counterweight to {@link workerConversationGone} no longer being fatal. A closed tab is
 * not evidence that a worker stopped — the turn runs on OpenAI's servers — but it does remove
 * the page evidence that would otherwise report the turn ending, so silence is the only
 * ending left for a worker nobody is watching. Long enough to sit through a slow model turn
 * and a long tool call, short enough that an abandoned slot frees itself without the user
 * having to clear it.
 */
export const DETACHED_SILENCE_MS = 5 * 60_000;

export class AgentError extends Error {}

/** Raised at every `agents` action reached from a conversation outside the active run. */
export class AgentsBusyError extends AgentError {
  constructor() {
    super(
      'AGENTS_BUSY: another ChatGPT conversation is already running the one sub-agent swarm this app supports. ' +
        'Nothing about that run is visible from here. Wait for it to finish, or ask the user to press Clear swarm ' +
        'in Chat On Steroids.'
    );
  }
}

/**
 * Raised when a call meant for the run could not be placed in any conversation.
 *
 * Every identity here is a conversation, so a call this app cannot place is a call it cannot
 * attribute — and the answer to that is to say so, not to accept a key the model is carrying
 * instead. In practice this is a page whose extension is not reporting: the fix is in the
 * browser, and the message says where to look.
 */
export class IdentityLostError extends AgentError {
  constructor() {
    super(
      'WORKER_IDENTITY_LOST: Chat On Steroids could not tell which conversation this call came from, so it cannot ' +
        'act on the run from here. Check that the extension is connected in this tab and try once more. If this chat ' +
        'was opened as a worker and never took up its slot, there is nothing to repair from inside the chat: ask the ' +
        'user to clear that worker row in the app and spawn a replacement.'
    );
  }
}

/**
 * An agent that will not act again, whichever way it ended.
 *
 * `finished` and `failed` differ only in what the user is told. Everything that asks "is
 * this run still going", "may this worker still be messaged", "does this worker still owe
 * us a tab" wants both.
 *
 * `detached` is deliberately *not* here. That is the state of a worker whose ChatGPT tab is
 * gone while its turn is not: it still holds its slot, still resolves for its own
 * conversation, still has an inbox, and still finishes the ordinary way. Every caller of
 * this function has to keep treating it as live — that is the whole reason the state exists.
 */
export function isOver(state: AgentState): boolean {
  return state === 'finished' || state === 'failed';
}

interface Agent {
  info: AgentInfo;
  queue: AgentMessage[];
}

/**
 * The single run, or null.
 *
 * `primeConversationId` is immutable for the lifetime of a run except through
 * {@link commitPrimeTransfer}, which is only ever reached from the commit step of the app's
 * own Compact & Resume session rebind.
 */
interface Run {
  runId: string;
  primeConversationId: string;
  startedAt: number;
  agents: Map<string, Agent>;
  /**
   * An open Compact & Resume handover, at most one.
   *
   * Bookkeeping only: the authority is the session layer's continuation transaction, and
   * this just records that the prime chat is expected to go away right now.
   *
   * `frozen` is what makes the commit safe. A handover expires while it is merely *open* —
   * an abandoned one must not leave the run transferable forever — but the session layer
   * freezes it before it starts the durable write, so time spent on disk can never turn a
   * preflighted handover into an expired one and split the session from its swarm.
   */
  transfer: { from: string; at: number; frozen: boolean } | null;
}

let run: Run | null = null;

/**
 * The earliest instant this process can honestly claim to have been watching a conversation.
 *
 * `lastSeenAt` is stamped on every proven call but only written to disk when something else
 * asks for a write, so a restored run can carry a stale one. Failing a detached worker on
 * that number would end a live worker because of a write that never happened; the floor makes
 * a restart start the silence clock again instead.
 */
let livenessFloor = 0;

let spawnRequest: ((workers: WorkerSpawn[]) => void) | null = null;
const listeners = new Set<() => void>();
const endListeners = new Set<(reason: string, retired: RetiredChat[]) => void>();
let persist: (() => void) | null = null;
let persistNow: ((snapshot: SwarmSnapshot | null) => Promise<void>) | null = null;
let criticalMutationRevision = 0;
let persistedCriticalRevision = 0;
let criticalPersistFlight: Promise<boolean> | null = null;
let retiredPersist: (() => void) | null = null;
const RETIRED_WORKER_TTL_MS = 30 * 60_000;
const retiredWorkers = new Map<string, RetiredChat>();

// ------------------------------------------------------------------ listeners

export function onSwarmChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type SwarmMutationDurability = 'critical' | 'telemetry';

function changed(durability: SwarmMutationDurability = 'critical'): void {
  if (durability === 'critical') criticalMutationRevision += 1;
  persist?.();
  for (const listener of listeners) listener();
}

/** The store registers here so the broker needs to know nothing about files. */
export function onSwarmPersist(handler: (() => void) | null): void {
  persist = handler;
}

/**
 * Registers the durable barrier for broker mutations whose loss changes identity, topology,
 * terminal state, or accepted messages. The existing `onSwarmPersist` callback remains the
 * cheap/debounced path for every mutation; this second hook is explicit so callers performing
 * a user-visible critical transition can await disk durability before publishing success.
 *
 * The callback receives the exact snapshot for the revision being drained. That avoids a
 * persistence adapter re-reading mutable broker state after an await and accidentally claiming
 * a different generation durable.
 */
export function onSwarmPersistNow(handler: ((snapshot: SwarmSnapshot | null) => Promise<void>) | null): void {
  persistNow = handler;
}

/**
 * Durably drains all critical broker revisions observed through the end of the write loop.
 * Returns false when the host has not wired an immediate persistence sink yet; it never
 * silently treats the debounced callback as an fsync-equivalent barrier.
 */
export async function persistCriticalSwarmNow(): Promise<boolean> {
  if (!persistNow) return false;
  if (persistedCriticalRevision >= criticalMutationRevision) return true;
  if (!criticalPersistFlight) {
    criticalPersistFlight = (async () => {
      while (persistedCriticalRevision < criticalMutationRevision) {
        const handler = persistNow;
        if (!handler) return false;
        const targetRevision = criticalMutationRevision;
        const snapshot = snapshotSwarm();
        await handler(snapshot);
        persistedCriticalRevision = Math.max(persistedCriticalRevision, targetRevision);
      }
      return true;
    })().finally(() => {
      criticalPersistFlight = null;
    });
  }
  return criticalPersistFlight;
}

export function onRetiredWorkersPersist(handler: (() => void) | null): void {
  retiredPersist = handler;
}

/**
 * Called when a run ends, for any reason.
 *
 * The bridge listens so worker bootstraps queued for the run that just ended are cancelled
 * in the same tick; without it the browser kept opening tabs for workers of a swarm that no
 * longer existed.
 */
export function onSwarmEnd(listener: (reason: string, retired: RetiredChat[]) => void): () => void {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

/** A worker chat that was still going when its run ended. */
export interface RetiredChat {
  id: string;
  conversationId: string;
  reason: string;
  retiredAt: number;
}

/** A worker whose chat still has to be opened. Carries no credential. */
export interface WorkerSpawn {
  id: string;
  task: string;
}

/** Workers that exist but have not joined: their chat is still owed. */
export function pendingWorkerSpawns(): WorkerSpawn[] {
  if (!run) return [];
  return [...run.agents.values()]
    .filter((agent) => agent.info.role === 'worker' && agent.info.state === 'invited')
    .map((agent) => ({ id: agent.info.id, task: agent.info.task }));
}

/**
 * The bridge registers here, so the broker never has to know about HTTP or tabs.
 *
 * Registration replays whatever is already owed: startup restores the run before the bridge
 * exists, so the restore itself has nobody to ask for a tab.
 */
export function onSpawnRequest(handler: (workers: WorkerSpawn[]) => void): void {
  spawnRequest = handler;
  const owed = pendingWorkerSpawns();
  if (owed.length > 0) {
    handler(owed);
    logInfo(`multi-agent: ${owed.length} worker chat(s) still owed a tab`);
  }
}

// ------------------------------------------------------------------ identity

/**
 * What a caller can offer as proof of who it is. No field is ever an agent id.
 */
export interface Caller {
  /**
   * The ChatGPT conversation this call was proven to come from, and the only identity any
   * agent has.
   *
   * Only ever set from evidence gathered for the call being handled: ChatGPT's own message
   * model naming this exact tool request, in exactly one conversation. Never from anything
   * the model wrote, and never from "the chat that has been active lately".
   */
  conversationId?: string | null;
}

function requireEnabled(): void {
  if (!getConfig().multiAgent.enabled) {
    throw new AgentError('Multi-agent mode is switched off in Chat On Steroids. Ask the user to enable it.');
  }
}

/** The live agent bound to a conversation, prime included. */
function agentForConversationId(conversationId: string): Agent | null {
  if (!run) return null;
  if (conversationId === run.primeConversationId) return run.agents.get(PRIME_ID) ?? null;
  for (const agent of run.agents.values()) {
    if (agent.info.conversationId === conversationId && !isOver(agent.info.state)) return agent;
  }
  return null;
}

/**
 * Who is calling, or null.
 *
 * One lookup, because there is one identity: the conversation this call was proven to come
 * from. A call that could not be placed in a conversation belongs to nobody, and saying so
 * is what keeps an unidentified call from being filed under whichever agent was busiest.
 */
function resolve(caller: Caller): Agent | null {
  if (!run || !caller.conversationId) return null;
  return agentForConversationId(caller.conversationId);
}

/** Attribution for an ordinary tool call: only ever a binding, never a claim. */
export function agentForCaller(caller: Caller): string | null {
  if (!getConfig().multiAgent.enabled) return null;
  return resolve(caller)?.info.id ?? null;
}

/**
 * Identity for the one control call a terminal worker is allowed to retry: `agents finish`.
 *
 * Ordinary resolution deliberately hides terminal workers so an ended chat cannot keep using
 * local tools as a live member of the run. A lost `finish` result is different: the broker must
 * recognise the same conversation's tombstone so the dispatcher can re-offer anything that
 * rode on that lost result without reviving the worker or authorising another action.
 *
 * Keep this as a separate lookup rather than widening {@link agentForCaller}. The dispatcher
 * selects it only for the literal finish action; every other call retains the fail-closed live
 * membership rule.
 */
export function agentForFinishCaller(caller: Caller): string | null {
  if (!getConfig().multiAgent.enabled) return null;
  return (resolve(caller) ?? retiredAgent(caller))?.info.id ?? null;
}

/**
 * Resolves the caller to a member of the active run, or refuses in the one honest way.
 *
 * Three refusals, deliberately different. A caller with no run at all is told how to start
 * one. A chat that *was* identified and is not in the run learns only `AGENTS_BUSY` — never
 * who the prime is, how many workers there are, or what they are doing. And a call whose
 * conversation could not be established at all is a different failure entirely: it is not a
 * stranger, it is an agent whose identity this app could not read, so it is told that in
 * those words rather than being handed a credential to carry instead.
 */
function requireMember(caller: Caller): Agent {
  requireEnabled();
  if (!run) {
    throw new AgentError(
      'No sub-agent run is active. The chat that calls agents action=spawn becomes the prime agent of a new run.'
    );
  }
  if (!caller.conversationId) throw new IdentityLostError();
  const agent = resolve(caller);
  if (!agent) throw new AgentsBusyError();
  return agent;
}

/** Resolves who is calling, or refuses with something the model can act on. */
export function identify(caller: Caller): AgentInfo {
  return { ...requireMember(caller).info };
}

// -------------------------------------------------------------------- state

/**
 * The one message a worker is opened with: the run's shared context, then its own task.
 *
 * Labelled, because the two halves are addressed differently — the context is standing
 * instruction for everyone in the run, the task is this worker's job — and a worker that
 * cannot tell them apart is one that reports back on the house rules.
 */
function briefFor(context: string, task: string): string {
  if (!context) return task;
  return `Shared context for every worker in this run:
${context}

Your task:
${task}`;
}

function makeWorker(id: string, label: string, task: string): Agent {
  return {
    info: {
      id,
      role: 'worker',
      label,
      task,
      state: 'invited',
      createdAt: Date.now(),
      activatedAt: null,
      finishedAt: null,
      result: null,
      pending: 0,
      awaitingAck: 0,
      delivered: 0,
      conversationId: null,
      detachedAt: null,
      lastSeenAt: null,
      revivable: false
    },
    queue: []
  };
}

function makePrime(conversationId: string): Agent {
  return {
    info: {
      id: PRIME_ID,
      role: 'prime',
      label: 'Prime',
      task: 'Coordinates the workers',
      state: 'active',
      createdAt: Date.now(),
      activatedAt: Date.now(),
      finishedAt: null,
      result: null,
      pending: 0,
      awaitingAck: 0,
      delivered: 0,
      conversationId,
      detachedAt: null,
      lastSeenAt: Date.now(),
      revivable: false
    },
    queue: []
  };
}

function recount(agent: Agent): void {
  const live = agent.queue.filter((message) => message.ackedAt === null);
  agent.info.pending = live.length;
  agent.info.awaitingAck = live.filter((message) => message.offeredAt !== null).length;
}

function primeAgent(): Agent {
  const agent = run?.agents.get(PRIME_ID);
  if (!agent) throw new AgentError('No sub-agent run is active.');
  return agent;
}

/**
 * Ends the run: agents, queues, credentials, and — through the end listeners — any worker
 * bootstrap the browser has not opened yet.
 *
 * Half-clearing is what produced the worst observed behaviour, a browser opening tabs for
 * workers of a run that no longer had a prime to report to.
 */
function endRun(reason: string): void {
  if (!run) return;
  const retired: RetiredChat[] = [...run.agents.values()]
    .filter((agent) => agent.info.role === 'worker' && !isOver(agent.info.state) && agent.info.conversationId)
    .map((agent) => ({
      id: agent.info.id,
      conversationId: agent.info.conversationId as string,
      reason,
      retiredAt: Date.now()
    }));
  for (const worker of retired) retiredWorkers.set(worker.conversationId, worker);
  retiredPersist?.();
  const what = `${run.runId} (${[...run.agents.keys()].join(', ')})`;
  run = null;
  logInfo(`multi-agent: ended run ${what} — ${reason}`);
  for (const listener of endListeners) listener(reason, retired);
}

function pruneRetiredWorkers(): void {
  const cutoff = Date.now() - RETIRED_WORKER_TTL_MS;
  let changed = false;
  for (const [conversationId, worker] of retiredWorkers) {
    if (worker.retiredAt >= cutoff) continue;
    retiredWorkers.delete(conversationId);
    changed = true;
  }
  if (changed) retiredPersist?.();
}

export function retiredWorkerForConversation(conversationId: string | null | undefined): RetiredChat | null {
  pruneRetiredWorkers();
  if (!conversationId) return null;
  const worker = retiredWorkers.get(conversationId);
  return worker ? { ...worker } : null;
}

export function hasRetiredWorkerLeases(): boolean {
  pruneRetiredWorkers();
  return retiredWorkers.size > 0;
}

export function forgetRetiredWorker(conversationId: string): void {
  if (retiredWorkers.delete(conversationId)) retiredPersist?.();
}

// -------------------------------------------------------------------- spawn

export interface SpawnInput {
  workers: ReadonlyArray<{ label?: string; task: string }>;
  /**
   * What every worker in this spawn needs to know, written once.
   *
   * A worker starts with none of the prime's conversation, so the repository, the house
   * rules, the branch, the things it must not touch and how to validate had to be repeated
   * inside every single task. That is the prime paying output tokens to say the same
   * paragraph four times, and it is the paragraph most likely to drift between copies.
   * Written here, this app puts it in front of each worker's own task instead.
   */
  context?: string | null;
  caller: Caller;
}

export interface SpawnResult {
  created: AgentInfo[];
  /** True on the call that established the run, so the caller can say what happened. */
  becamePrime: boolean;
  runId: string;
}

interface SpawnOptions {
  /** Keep browser side effects behind an explicit durable acceptance barrier. */
  deferDelivery?: boolean;
}

/**
 * Publishes browser bootstraps only for worker ids that are still genuinely invited.
 *
 * Production MCP spawn uses this as the second half of its transaction: broker state is
 * planned first, that exact revision is made durable, and only then are browser tabs requested.
 * A retry after a failed disk barrier is safe because already-running workers are ignored.
 */
export function requestWorkerBootstraps(ids: readonly string[]): number {
  if (!run || ids.length === 0) return 0;
  const wanted = new Set(ids);
  const owed = [...run.agents.values()]
    .filter(
      (agent) =>
        agent.info.role === 'worker' &&
        agent.info.state === 'invited' &&
        wanted.has(agent.info.id)
    )
    .map((agent) => ({ id: agent.info.id, task: agent.info.task }));
  if (owed.length === 0) return 0;
  if (spawnRequest) spawnRequest(owed);
  else logWarn('multi-agent: no browser extension is paired, so worker chats cannot be opened automatically');
  return owed.length;
}

/**
 * Claims the calling conversation as prime and creates its workers, atomically.
 *
 * Every step that can fail happens before the first mutation, in a fixed order:
 *
 *   1. the request itself is valid (all of it, not the prefix that happened to parse);
 *   2. this app has *proven* which conversation is calling;
 *   3. that conversation is not a worker of the active run;
 *   4. no other conversation holds the one swarm;
 *   5. only then is the prime bound and the workers created.
 *
 * So a spawn that fails for any reason leaves zero workers behind, and no conversation ever
 * becomes prime as a by-product of some other outcome.
 */
export function spawn(input: SpawnInput, options: SpawnOptions = {}): SpawnResult {
  requireEnabled();
  const max = getConfig().multiAgent.maxWorkers;
  if (input.workers.length === 0) throw new AgentError('At least one worker is required');

  const context = input.context?.trim() ?? '';
  if (context.length > MAX_CONTEXT_CHARS) {
    throw new AgentError(`The shared context is too long (limit ${MAX_CONTEXT_CHARS} characters)`);
  }

  const planned = input.workers.map((worker, index) => {
    const task = worker.task.trim();
    if (!task) throw new AgentError(`Worker ${index + 1} has no task. Every worker needs one.`);
    if (task.length > MAX_TASK_CHARS) throw new AgentError(`Worker ${index + 1}'s task is too long`);
    const label = worker.label?.trim() ?? '';
    if (label.length > MAX_LABEL_CHARS) {
      throw new AgentError(`Worker ${index + 1}'s label is too long (limit ${MAX_LABEL_CHARS} characters)`);
    }
    // Composed once, here, and stored as *the* task. Everything downstream — the bootstrap
    // the browser types, the repeated-spawn match, the status table, the snapshot — then
    // sees the same single string a worker actually receives, with no second field to keep
    // in step and no way for the two halves to be delivered apart.
    return { label, task: briefFor(context, task) };
  });

  const conversationId = input.caller.conversationId ?? null;
  if (!conversationId) {
    throw new AgentError(
      'UNIDENTIFIED_CALLER: this app could not prove which ChatGPT conversation this call came from, so it will not ' +
        'make this chat the prime agent of a run. No workers were created. The paired browser extension has to be ' +
        'connected and this conversation has to be showing its connector activity; wait a moment and call ' +
        'agents action=spawn again.'
    );
  }

  if (run) {
    const caller = resolve(input.caller);
    if (caller && caller.info.role === 'worker') {
      throw new AgentError(
        `${caller.info.id} is a worker in this run. Workers must not create workers of their own — send the prime ` +
          'agent a message instead and let it decide.'
      );
    }
    if (conversationId !== run.primeConversationId) throw new AgentsBusyError();
  }

  const becamePrime = run === null;
  if (!run) {
    run = {
      runId: randomUUID().slice(0, 8),
      primeConversationId: conversationId,
      startedAt: Date.now(),
      agents: new Map([[PRIME_ID, makePrime(conversationId)]]),
      transfer: null
    };
  }

  const live = [...run.agents.values()].filter((agent) => agent.info.role === 'worker' && !isOver(agent.info.state));

  // The same request arriving twice is one request. A tool result that never reached
  // ChatGPT leaves a model with no idea its workers exist, and the obvious thing for it to
  // do is ask again; creating a second identical set is how a user ends up with four
  // sub-agent chats they asked for twice.
  const repeat = matchExistingRequest(planned, live);
  if (repeat) {
    if (!options.deferDelivery) requestWorkerBootstraps(repeat.map((agent) => agent.info.id));
    logInfo(`multi-agent: repeated spawn matched ${repeat.length} existing worker(s) in run ${run.runId}`);
    return { created: repeat.map((agent) => ({ ...agent.info })), becamePrime, runId: run.runId };
  }

  if (live.length + planned.length > max) {
    const total = live.length + planned.length;
    if (becamePrime) run = null;
    throw new AgentError(`That would make ${total} live workers; the limit set in the app is ${max}.`);
  }

  const ids: string[] = [];
  for (let n = 1; ids.length < planned.length && n <= 64; n++) {
    const id = `worker-${n}`;
    if (!run.agents.has(id)) ids.push(id);
  }
  if (ids.length < planned.length) {
    if (becamePrime) run = null;
    throw new AgentError('Too many workers have been created in this run');
  }

  const created: AgentInfo[] = [];
  for (const [index, worker] of planned.entries()) {
    const id = ids[index] as string;
    const agent = makeWorker(id, worker.label || id, worker.task);
    run.agents.set(id, agent);
    // A worker starts in the folder the prime was working in, so its first call can use the
    // same shorthand. It is a copy: a worker sent into another project overwrites its own
    // entry and never the prime's.
    inheritWorkspace(id, run.primeConversationId);
    created.push({ ...agent.info });
  }

  logInfo(
    becamePrime
      ? `multi-agent: run ${run.runId} started by conversation ${conversationId} with ${created.length} worker(s)`
      : `multi-agent: created ${created.length} worker(s) in run ${run.runId}`
  );
  changed();
  if (!options.deferDelivery) requestWorkerBootstraps(created.map((agent) => agent.id));
  return { created, becamePrime, runId: run.runId };
}

/**
 * Finds the workers a repeated spawn is really asking about.
 *
 * All or nothing, matched on the request as written. A request that asks for anything new is
 * a new request and creates everything it asks for, so a prime that genuinely wants a third
 * worker still gets one; only an exact repetition of work already under way is folded back.
 */
function matchExistingRequest(
  requested: ReadonlyArray<{ label: string; task: string }>,
  live: readonly Agent[]
): Agent[] | null {
  if (requested.length === 0 || live.length === 0) return null;
  // An unambiguous encoding of the (label, task) pair rather than a separator character.
  // Any separator is only as good as the assumption that it cannot occur in the operands, and
  // both of these are free text a model wrote; JSON removes the assumption entirely, so
  // ("a", "b c") and ("a b", "c") can never shape-collide into one match. It also keeps this
  // file plain text: the NUL that used to do this job was a literal byte, which made every
  // text tool treat the source as binary.
  const shape = (label: string, task: string): string => JSON.stringify([label.trim(), task.trim()]);
  const taken = new Set<Agent>();
  const matched: Agent[] = [];
  for (const worker of requested) {
    // The stored label defaults to the worker id, so an unlabelled request has to match the
    // way spawn would have written it.
    const found = live.find(
      (agent) =>
        !taken.has(agent) &&
        (shape(agent.info.label, agent.info.task) === shape(worker.label || agent.info.id, worker.task) ||
          shape(agent.info.label, agent.info.task) === shape(worker.label, worker.task))
    );
    if (!found) return null;
    taken.add(found);
    matched.push(found);
  }
  return matched;
}

// ----------------------------------------------------------------- recovery

/**
 * The over-and-done slot a caller belongs to, if it belongs to one.
 *
 * Terminal agents are invisible to ordinary resolution on purpose — nothing in a run should
 * route to them — but a retried `finish` still has to be answered honestly. This is the one
 * lookup that can see them.
 */
function retiredAgent(caller: Caller): Agent | null {
  if (!run || !caller.conversationId) return null;
  for (const agent of run.agents.values()) {
    if (agent.info.conversationId === caller.conversationId && isOver(agent.info.state)) return agent;
  }
  return null;
}

// ------------------------------------------------------------------ routing

/**
 * Star topology, enforced.
 *
 * Two workers talking directly is the thing this mode must not allow: it is how a swarm
 * silently negotiates a plan the user never sees and the prime cannot report.
 */
function assertRoute(from: Agent, to: Agent): void {
  if (from.info.id === to.info.id) throw new AgentError('An agent cannot message itself');
  if (from.info.role === 'worker' && to.info.role !== 'prime') {
    throw new AgentError('Workers may only message the prime agent. Send it there and let the prime decide.');
  }
  if (from.info.role === 'prime' && to.info.role !== 'worker') {
    throw new AgentError('The prime agent can only message workers');
  }
}

/**
 * Adds a message to a recipient's queue, or refuses.
 *
 * Refusing is the point. Dropping the oldest waiting message to make room would throw away a
 * task or a result while still telling the sender it was sent.
 */
function assertRoom(to: Agent, incoming: number): void {
  const waiting = to.queue.filter((item) => item.ackedAt === null).length;
  if (waiting + incoming > MAX_QUEUE) {
    throw new AgentError(
      `QUEUE_FULL: ${to.info.id} already has ${waiting} unacknowledged messages, which is the limit. Nothing was sent ` +
        'and nothing was discarded. A queue this deep normally means that agent has stopped calling tools.'
    );
  }
}

function enqueue(to: Agent, message: AgentMessage): void {
  assertRoom(to, 1);
  to.queue.push(message);
  if (to.queue.length > MAX_QUEUE * 2) {
    const settled = to.queue.filter((item) => item.ackedAt !== null).slice(-MAX_QUEUE);
    to.queue = [...settled, ...to.queue.filter((item) => item.ackedAt === null)];
  }
  recount(to);
}

function newMessage(from: string, to: string, text: string): AgentMessage {
  return {
    id: randomUUID().slice(0, 8),
    from,
    to,
    time: Date.now(),
    text,
    offeredAt: null,
    offers: 0,
    offeredOnFinish: false,
    ackedAt: null
  };
}

/**
 * Sends a message from the caller — whoever the broker says that is — to `toId`.
 *
 * There is deliberately no "from" parameter. The sender is derived from the caller's
 * binding, so the star topology cannot be sidestepped by writing someone else's id.
 */
export function sendMessage(caller: Caller, toId: string, text: string): AgentMessage {
  return sendMessages(caller, [{ to: toId, text }])[0] as AgentMessage;
}

/**
 * Sends several messages from the caller in one operation, all or nothing.
 *
 * One `agents` call is one proof of who is calling. Sending three corrections used to be
 * three MCP round trips and three separate identity resolutions — each of which can be
 * refused on its own, so a prime redirecting its whole run could get two of its three
 * messages delivered and no way to tell which.
 *
 * Everything that can be checked is checked across the whole batch before anything is
 * queued, including how much room each recipient has left, so a batch either lands complete
 * or changes nothing. Two messages to the same worker keep their written order.
 */
export function sendMessages(
  caller: Caller,
  items: ReadonlyArray<{ to: string; text: string }>
): AgentMessage[] {
  if (items.length === 0) throw new AgentError('No messages were given');
  if (items.length > MAX_BATCH_MESSAGES) {
    throw new AgentError(`Too many messages in one call (limit ${MAX_BATCH_MESSAGES})`);
  }
  const from = requireMember(caller);
  // A finished worker keeps its conversation so a lost finish result can be recognised as a
  // retry. Without this guard that same binding let it go on queueing work for the prime
  // after it had reported and stopped.
  if (isOver(from.info.state)) {
    throw new AgentError(
      `${from.info.id} has ${from.info.state === 'failed' ? 'failed' : 'finished'} and cannot send messages.`
    );
  }

  const planned: Array<{ to: Agent; message: AgentMessage }> = [];
  const perRecipient = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const where = items.length > 1 ? ` (message ${index + 1} of ${items.length})` : '';
    const trimmed = item.text?.trim() ?? '';
    if (!trimmed) throw new AgentError(`The message is empty${where}`);
    if (trimmed.length > MAX_MESSAGE_CHARS) {
      throw new AgentError(`Message is too long (limit ${MAX_MESSAGE_CHARS} characters)${where}`);
    }
    const toId = item.to?.trim() ?? '';
    const to = toId ? run?.agents.get(toId) : undefined;
    if (!to) {
      throw new AgentError(`Unknown agent "${toId}"${where}. Call agents action=status to see who exists.`);
    }
    assertRoute(from, to);
    if (isOver(to.info.state)) {
      throw new AgentError(
        `${toId} has ${to.info.state === 'failed' ? 'failed' : 'finished'} and is no longer listening${where}`
      );
    }
    // Counted per recipient across the batch: three messages to one worker with two slots
    // left has to be refused here, not half-delivered and then refused by enqueue.
    const already = perRecipient.get(to.info.id) ?? 0;
    assertRoom(to, already + 1);
    perRecipient.set(to.info.id, already + 1);
    planned.push({ to, message: newMessage(from.info.id, to.info.id, trimmed) });
  }

  for (const { to, message } of planned) enqueue(to, message);
  changed();
  return planned.map(({ message }) => ({ ...message }));
}

/**
 * Messages to put in this agent's next tool result, including anything already offered but
 * not yet acknowledged.
 *
 * That is the deliberate at-least-once trade: if the previous result never reached ChatGPT —
 * the connector dropping mid-turn is a failure this project has reproduced — the message
 * comes round again instead of vanishing. `offers > 1` lets the caller label a repeat.
 *
 * `onFinish` records that this offer rode on a `finish` result, the one result whose loss is
 * answered by an identical retry and whose acknowledgement therefore proves nothing.
 */
export function offerMessages(id: string, onFinish = false): AgentMessage[] {
  const agent = run?.agents.get(id);
  if (!agent) return [];
  const waiting = agent.queue.filter((message) => message.ackedAt === null);
  if (waiting.length === 0) return [];
  const now = Date.now();
  for (const message of waiting) {
    message.offeredAt = now;
    message.offers += 1;
    message.offeredOnFinish = onFinish;
  }
  recount(agent);
  changed('telemetry');
  return waiting.map((message) => ({ ...message }));
}

/**
 * Retires everything previously offered to this agent, except what this call cannot honestly
 * be said to have proven.
 *
 * Called at the start of that agent's next authenticated call, because that call is the best
 * evidence available that the previous tool result made it back into the conversation.
 * Evidence, not proof — so a message offered on a `finish` result is not retired by another
 * `finish`, which would otherwise let a worker's own retry count an unread message as
 * delivered and then terminalise it.
 */
export function acknowledgeOffers(id: string, byFinish = false): AgentMessage[] {
  const agent = run?.agents.get(id);
  if (!agent) return [];
  const offered = agent.queue.filter(
    (message) => message.ackedAt === null && message.offeredAt !== null && !(byFinish && message.offeredOnFinish)
  );
  if (offered.length === 0) return [];
  const now = Date.now();
  for (const message of offered) message.ackedAt = now;
  agent.info.delivered += offered.length;
  recount(agent);
  changed('telemetry');
  return offered.map((message) => ({ ...message }));
}

export function pendingCount(id: string): number {
  return run?.agents.get(id)?.info.pending ?? 0;
}

/**
 * Releases the single global swarm claim once there is nothing left for the run to deliver.
 *
 * Worker terminal state alone is not enough: `finishAgent()` queues the final report to the
 * prime, and at-least-once delivery means that report must survive until a later authenticated
 * prime call acknowledges it. The dispatcher calls this only after inbox acknowledgement and
 * result construction, so an `agents status` call can still inspect the run that it is about
 * to retire.
 *
 * `allowPendingReports` exists only for the durable orphan fallback. That path separately
 * proves roughly two minutes of durable quiescence for every bound chat before choosing slot
 * availability over an inbox the abandoned prime is no longer collecting.
 */
export function releaseQuiescentRun(options: { allowPendingReports?: boolean; reason?: string } = {}): boolean {
  if (!run || swarmTransferActive()) return false;
  const workers = [...run.agents.values()].filter((agent) => agent.info.role === 'worker');
  if (workers.length === 0 || workers.some((agent) => !isOver(agent.info.state))) return false;
  const prime = run.agents.get(PRIME_ID);
  if (!prime) return false;
  if (!options.allowPendingReports && prime.info.pending > 0) return false;
  endRun(options.reason ?? 'all workers are terminal and their final reports were delivered');
  changed();
  return true;
}

// ------------------------------------------------------------------- finish

export interface FinishResult {
  info: AgentInfo;
  /** The report queued for the prime, so the caller can record it durably. */
  report: AgentMessage | null;
  /** This call found the agent already terminal and changed nothing. */
  repeat: boolean;
}

/**
 * Finishes the calling worker. An agent can only ever finish itself.
 *
 * Finishing twice is one finish. This connector loses tool results, so a worker whose result
 * never came back simply calls again, usually with slightly different wording. Taking the
 * second call literally rewrote `finishedAt` and queued a *second* final report, so the
 * prime was told the same thing twice with no way to tell that from two genuine reports.
 */
export function finishAgent(caller: Caller, result: string): FinishResult {
  requireEnabled();
  if (!run) throw new AgentError('No sub-agent run is active.');
  if (!caller.conversationId) throw new IdentityLostError();
  // The one call that also answers from a conversation whose slot has already ended: this
  // connector loses tool results, so a retry of *this* call is exactly what that looks like,
  // and telling the chat that had genuinely finished that it was a stranger was worse than
  // useless.
  const agent = resolve(caller) ?? retiredAgent(caller);
  if (!agent) throw new AgentsBusyError();
  if (agent.info.role !== 'worker') {
    throw new AgentError(
      'The prime agent does not finish: the run ends when its workers have reported and the user is done with it.'
    );
  }
  if (isOver(agent.info.state)) {
    logInfo(`multi-agent: ${agent.info.id} called finish again after it had already ${agent.info.state}`);
    return { info: { ...agent.info }, report: null, repeat: true };
  }

  // What the prime told this worker and cannot be shown to have reached it. Taken before
  // the state changes and said out loud, because this app cannot prove a tool result
  // arrived — the guarantee it can keep is "either the worker got it or you are told it
  // may not have", and only the prime can act on the second case.
  const unconfirmed = agent.queue.filter((message) => message.ackedAt === null).map((message) => message.id);

  agent.info.state = 'finished';
  agent.info.finishedAt = Date.now();
  agent.info.result = result.slice(0, MAX_MESSAGE_CHARS);
  // What survives is the tombstone: the identity, the task, the result and the conversation,
  // none of which can authorise anything. The conversation is deliberately kept — it is what
  // lets a retried finish from that same chat be recognised as the retry it is.

  const caveat =
    unconfirmed.length > 0
      ? `\n(${agent.info.id} ended without ever confirming ${unconfirmed.length} message(s) you sent it — ` +
        `${unconfirmed.slice(0, 5).join(', ')}${unconfirmed.length > 5 ? ', …' : ''}. ` +
        'Assume it may not have read them and check the result against what you asked for.)'
      : '';
  const report = newMessage(agent.info.id, PRIME_ID, `[${agent.info.id} finished] ${agent.info.result}${caveat}`);
  // Over the queue limit on purpose: the worker is about to stop existing and has no way to
  // retry its final report.
  const prime = primeAgent();
  prime.queue.push(report);
  recount(prime);
  logInfo(`multi-agent: ${agent.info.id} finished`);
  changed();
  return { info: { ...agent.info }, report: { ...report }, repeat: false };
}

/**
 * App-owned terminal cleanup for a worker whose ChatGPT turn produced a settled answer.
 *
 * Broker messages ride on later tool results, so a worker that simply answers and then goes
 * idle has no future execution point at which an explicit `agents finish` can be required.
 * Leaving that worker `active` permanently consumed a slot and made the UI promise a worker
 * was still working when its chat had plainly finished. Treat workers as one-shot jobs: the
 * browser's settled assistant answer releases the slot, while an explicit finish remains the
 * same idempotent path when the model does call it first.
 */
export function finishWorkerConversation(conversationId: string, result: string): FinishResult | null {
  if (!run || !conversationId) return null;
  const agent = agentForConversationId(conversationId);
  if (!agent || agent.info.role !== 'worker' || isOver(agent.info.state)) return null;
  return finishAgent({ conversationId }, result);
}

/**
 * Ends a worker that never got off the ground, definitively.
 *
 * Called by whoever owns the bootstrap once it has run out of retries or time. Before this
 * existed, giving up only deleted the queued command: the worker stayed `invited`, still
 * counted towards the worker limit, still blocked the next bootstrap, and still promised the
 * prime a report that could never arrive.
 */
export function failAgent(
  id: string,
  reason: string,
  note?: string,
  options: { revivable?: boolean } = {}
): FinishResult | null {
  const agent = run?.agents.get(id);
  if (!run || !agent || agent.info.role !== 'worker' || isOver(agent.info.state)) return null;
  agent.info.state = 'failed';
  agent.info.finishedAt = Date.now();
  agent.info.detachedAt = null;
  agent.info.result = reason.slice(0, MAX_MESSAGE_CHARS);
  // Only a failure that says nothing about the turn itself may be undone by the turn proving
  // otherwise. A tab that never opened, a worker a person cleared, and a bootstrap that ran
  // out of retries are all verdicts about the work; a chat that was closed is not.
  agent.info.revivable = options.revivable === true;
  // A revivable failure keeps whatever the prime said to it. If the worker comes back, those
  // messages are still the instructions it never acknowledged; throwing them away here and
  // then reviving the worker would silently drop them.
  if (!agent.info.revivable) agent.queue = [];
  recount(agent);

  const report = newMessage(
    id,
    PRIME_ID,
    note ??
      `[${id} failed] Its ChatGPT tab never came up: ${agent.info.result}. It will not report. Do that part of the ` +
        'work yourself or spawn a replacement worker.'
  );
  const prime = primeAgent();
  prime.queue.push(report);
  recount(prime);
  logWarn(`multi-agent: ${id} failed — ${reason}`);
  changed();
  return { info: { ...agent.info }, report: { ...report }, repeat: false };
}

// -------------------------------------------------------- prime lifecycle

/** Whether a run exists at all. */
export function swarmRunning(): boolean {
  return run !== null;
}

/** The conversation the prime is bound to, or null when there is no run. */
export function primeConversation(): string | null {
  return run?.primeConversationId ?? null;
}

/** The run identifier, or null. Names the run in logs, transfers and tool results. */
export function currentRunId(): string | null {
  return run?.runId ?? null;
}

/** Whether Compact & Resume currently owns the prime binding transition. */
export function swarmTransferActive(): boolean {
  const transfer = run?.transfer ?? null;
  if (!transfer) return false;
  if (!transferExpired(transfer)) return true;
  // An abandoned unfrozen handover is no longer authority after its existing 10-minute TTL.
  // Clear it lazily here so it cannot turn into a permanent global swarm lock. Frozen commits
  // never expire and transferExpired() already preserves that invariant.
  if (run) run.transfer = null;
  changed();
  return false;
}

/**
 * The prime chat has gone: end the run.
 *
 * Called by the bridge when the prime's tab reports that it closed or navigated away with no
 * transfer open. Deliberately owned by the extension rather than inferred from silence, and
 * deliberately not asked of the model: a swarm whose coordinator is gone has nobody to
 * report to, and workers that keep going are tabs writing files for a run nobody is reading.
 */
export function primeConversationGone(conversationId: string): boolean {
  if (!run || run.primeConversationId !== conversationId) return false;
  // A handover in flight is the one case where the prime chat is *supposed* to go away.
  if (run.transfer && !transferExpired(run.transfer)) return false;
  endRun('the prime conversation was closed');
  changed();
  return true;
}

/**
 * Detaches a bound worker when the browser reports its final tab closed.
 *
 * **A closed tab is not a finished worker.** The turn belongs to OpenAI's servers, not to the
 * page: a worker whose chat is closed mid-task keeps thinking, keeps calling this connector,
 * and its calls keep arriving stamped with the same `x-request-id` workflow that
 * correlation.ts has already proved belongs to this exact conversation. Terminalising the
 * slot here was reading the browser's lifecycle as if it were the turn's — the run declared a
 * failure, told the prime to do that work itself, and freed a slot belonging to a worker that
 * was at that moment still writing files.
 *
 * So the browser event is recorded as what it actually is: the view went away. The worker
 * keeps its slot, its binding, its inbox and its right to `finish`, and it ends only when
 * something says something about the *work* — a `finish`, a durably completed turn, a person
 * clearing the row, or {@link failSilentDetachedWorkers} once the calls stop too.
 */
export function workerConversationGone(conversationId: string): boolean {
  if (!run || !conversationId) return false;
  const worker = [...run.agents.values()].find(
    (agent) => agent.info.role === 'worker' && agent.info.conversationId === conversationId && !isOver(agent.info.state)
  );
  if (!worker || worker.info.state === 'detached') return false;
  worker.info.state = 'detached';
  worker.info.detachedAt = Date.now();
  worker.info.revivable = true;
  // Nothing is queued for the prime here on purpose. The prime cannot act on "a tab closed",
  // and it is told the one thing it can act on either way: the worker's result when it
  // finishes, or the failure report when it goes quiet. `status` shows `detached` meanwhile.
  logInfo(`multi-agent: ${worker.info.id} detached — its chat was closed while its turn may still be running`);
  changed();
  return true;
}

/** What one piece of first-hand liveness evidence did to the agent it names. */
export interface AliveResult {
  agentId: string;
  /** True only on the call that brought a given-up-on agent back. */
  revived: boolean;
  /** Queued for the prime when the prime had already been told this worker was gone. */
  report: AgentMessage | null;
}

/**
 * First-hand liveness, and the revival it can justify.
 *
 * Fed by the two things that prove a conversation still exists, and by nothing else: an MCP
 * call this app *proved* came from it (the request-id join), and its own page reporting to
 * the bridge. Both mean the same thing here, which is why there is one clock rather than a
 * browser one and a connector one that disagree — a worker whose tab is open is never on the
 * silence clock at all, because its page keeps stamping this.
 *
 * Two things follow from that evidence:
 *
 *   - the agent bound to that conversation was alive at this instant, which is the clock
 *     {@link failSilentDetachedWorkers} measures; and
 *   - if that agent had been given up on *because its chat went away*, this is direct
 *     evidence that giving up was wrong, so it is taken back.
 *
 * Revival is deliberately never something a model can ask for. It is the same evidence that
 * routes every other call — a stored request id, or the extension's own report — arriving at
 * a slot that was closed underneath a turn which never stopped.
 *
 * A revival can put a run one worker over the configured limit, when the prime spawned a
 * replacement in the meantime. That is the honest reading: the worker *is* running, the limit
 * governs how many chats this app will start, and refusing to recognise one that is already
 * working would only make its calls unattributable.
 */
export function noteAgentAlive(conversationId: string | null | undefined, source: 'call' | 'page' = 'call'): AliveResult | null {
  if (!run || !conversationId) return null;
  const agent = boundAgent(conversationId);
  if (!agent) return null;
  const now = Date.now();
  const ended = agent.info.role === 'worker' && agent.info.state !== 'active' && agent.info.state !== 'invited';
  // A worker that reported, or that was ended on the work's own evidence, stays ended: its
  // chat calling again is a model that has not stopped, not a slot to reopen.
  if (!ended || (agent.info.state !== 'detached' && !agent.info.revivable)) {
    agent.info.lastSeenAt = now;
    return { agentId: agent.info.id, revived: false, report: null };
  }
  const was = agent.info.state;
  agent.info.state = 'active';
  agent.info.detachedAt = null;
  agent.info.finishedAt = null;
  agent.info.revivable = false;
  agent.info.lastSeenAt = now;
  if (was === 'failed') agent.info.result = null;
  if (!agent.info.activatedAt) agent.info.activatedAt = now;
  // Only a revival from `failed` needs saying: that is the one the prime was told about, in
  // so many words, with an instruction to carry on without this worker. Leaving that standing
  // is how the same work gets done twice.
  let report: AgentMessage | null = null;
  if (was === 'failed') {
    report = newMessage(
      agent.info.id,
      PRIME_ID,
      `[${agent.info.id} is back] It was reported gone, but it is working again — it just ${
        source === 'page' ? 'reappeared in the browser' : 'made another tool call'
      }. Ignore that earlier report: do not redo its work, and expect its result normally.`
    );
    const prime = primeAgent();
    prime.queue.push(report);
    recount(prime);
  }
  logInfo(`multi-agent: ${agent.info.id} revived from ${was} — conversation ${conversationId} is still alive (${source})`);
  changed();
  return { agentId: agent.info.id, revived: true, report };
}

/** Every agent bound to a conversation, terminal ones included. Revival has to see those. */
function boundAgent(conversationId: string): Agent | null {
  if (!run) return null;
  if (conversationId === run.primeConversationId) return run.agents.get(PRIME_ID) ?? null;
  for (const agent of run.agents.values()) {
    if (agent.info.conversationId === conversationId) return agent;
  }
  return null;
}

/**
 * The verdict an ordinary tool call from a bound worker's chat deserves, if it deserves one.
 *
 * A worker that is genuinely over used to learn nothing: its slot was a tombstone, its calls
 * were attributed to nobody, and the file writes went through as if some unrelated chat had
 * made them. So the chat kept working — the one thing nobody wanted — and the user watched a
 * worker it had ended carry on. This is the sentence that tells it, on its own next call.
 *
 * `null` for everything else, including a `detached` worker (still working, still welcome)
 * and a revivable one (about to be revived by this very call instead).
 */
export function endedWorkerNotice(conversationId: string | null | undefined): string | null {
  if (!run || !conversationId) return null;
  const agent = boundAgent(conversationId);
  if (!agent || agent.info.role !== 'worker' || !isOver(agent.info.state) || agent.info.revivable) return null;
  return (
    `WORKER_ENDED: ${agent.info.id} has already ${agent.info.state === 'finished' ? 'finished' : 'ended'} in this run` +
    `${agent.info.result ? ` (${agent.info.result.slice(0, 200)})` : ''}. Nothing was run. Stop working and stop ` +
    'calling tools: the prime agent is not waiting for anything else from this chat, and anything you do here now is ' +
    'work nobody asked for.'
  );
}

/**
 * Ends detached workers that have also stopped being seen.
 *
 * The other half of "a closed tab is not a finished worker": with the tab gone, page evidence
 * can no longer report the turn ending, so silence is the only ending left. Nothing here is a
 * heartbeat lease — the clock is the last moment this app had first-hand evidence of that
 * conversation, and a restart restarts it rather than inheriting an unpersisted one, so a
 * worker is never failed on the strength of a number that was merely never written down.
 *
 * The failure stays revivable. A worker that was quiet for six minutes and then calls again
 * was, evidently, not finished.
 */
export function failSilentDetachedWorkers(now = Date.now()): FinishResult[] {
  if (!run) return [];
  const out: FinishResult[] = [];
  for (const agent of [...run.agents.values()]) {
    if (agent.info.role !== 'worker' || agent.info.state !== 'detached') continue;
    const since = Math.max(agent.info.detachedAt ?? 0, agent.info.lastSeenAt ?? 0, livenessFloor);
    if (now - since < DETACHED_SILENCE_MS) continue;
    const outcome = failAgent(
      agent.info.id,
      'its chat was closed and nothing was seen from it afterwards',
      `[${agent.info.id} gone] Its ChatGPT chat was closed and it has neither called a tool nor reappeared since, so ` +
        'this app can no longer see what it is doing. The worker slot is free. Continue without it, or spawn a ' +
        'replacement if that work still matters.',
      { revivable: true }
    );
    if (outcome) out.push(outcome);
  }
  return out;
}

/** A frozen handover never expires: it is mid-commit, and the commit must be able to finish. */
const transferExpired = (transfer: { at: number; frozen: boolean }): boolean =>
  !transfer.frozen && Date.now() - transfer.at > TRANSFER_TTL_MS;

/**
 * Notes that the app's own Compact & Resume is moving this session to a new chat.
 *
 * Deliberately *not* a second one-time-token system. The single continuation transaction
 * lives in the session layer, which owns the durable local session and its one-time token;
 * the swarm binding is one of the things that transaction moves, alongside the workspace and
 * the recorded history. All this flag does is stop {@link primeConversationGone} from
 * killing the run while chat A is being replaced, which is the one moment the prime chat is
 * *supposed* to disappear.
 */
export function beginPrimeTransfer(conversationId: string): boolean {
  if (!run || run.primeConversationId !== conversationId) return false;
  run.transfer = { from: conversationId, at: Date.now(), frozen: false };
  return true;
}

/** Abandons an open handover, so the prime stays where it is. */
export function cancelPrimeTransfer(conversationId: string): void {
  if (run?.transfer?.from === conversationId) run.transfer = null;
}

/**
 * What the session layer must know *before* it starts writing, and the point of no expiry.
 *
 * The commit is a fallible durable write followed by moves that have to be total, and the
 * swarm move is the one that used to be neither: it re-checked its own deadline inside the
 * total phase, so a commit that preflighted fine, then spent a second on disk, could leave
 * the durable session in chat B with the swarm still bound to chat A. So the decision is
 * taken here, once, before the write:
 *
 *   `absent`      — this chat is not the prime of any run. There is nothing to move, and the
 *                   session rebind is free to proceed.
 *   `unavailable` — it *is* the prime, but no usable handover is open. The caller must refuse
 *                   the whole commit; a session that moved without its swarm is the split this
 *                   exists to prevent.
 *   `frozen`      — the handover is now pinned and {@link commitPrimeTransfer} will succeed
 *                   for this pair unless the run itself ends in the meantime, which is a
 *                   terminal state rather than a half-commit: there is no prime left in chat A
 *                   to be inconsistent with.
 *
 * A freeze whose commit does not happen is released with {@link thawPrimeTransfer}, which
 * restarts the clock without abandoning the handover, so a retry is still possible.
 */
export function freezePrimeTransfer(fromConversationId: string): 'absent' | 'unavailable' | 'frozen' {
  if (!run || run.primeConversationId !== fromConversationId) return 'absent';
  const transfer = run.transfer;
  if (!transfer || transfer.from !== fromConversationId || transferExpired(transfer)) return 'unavailable';
  if (!run.agents.has(PRIME_ID)) return 'unavailable';
  transfer.frozen = true;
  return 'frozen';
}

/** Undoes a freeze whose commit did not happen, leaving the handover open but expiring again. */
export function thawPrimeTransfer(fromConversationId: string): void {
  if (run?.transfer?.from === fromConversationId) {
    run.transfer.frozen = false;
    run.transfer.at = Date.now();
  }
}

/**
 * Moves the prime binding as part of the session rebind commit.
 *
 * Called only from the commit step of the session continuation transaction, after
 * {@link freezePrimeTransfer} authorised it and after that transaction has proven chat B is
 * real and usable. Deliberately has no deadline of its own — the freeze is the deadline — so
 * the only way this can now decline is that the run ended entirely while the write was in
 * flight, and a run that no longer exists cannot be left behind in chat A.
 *
 * Returns false, changing nothing, when there is no handover open from that exact
 * conversation, which is what stops a stray chat from inheriting a swarm.
 */
export function commitPrimeTransfer(fromConversationId: string, toConversationId: string): boolean {
  if (!run || !run.transfer || !toConversationId) return false;
  if (run.transfer.from !== fromConversationId || run.primeConversationId !== fromConversationId) return false;
  const prime = run.agents.get(PRIME_ID);
  if (!prime) return false;
  run.primeConversationId = toConversationId;
  prime.info.conversationId = toConversationId;
  run.transfer = null;
  logInfo(`multi-agent: prime moved from conversation ${fromConversationId} to ${toConversationId}`);
  changed();
  return true;
}

/**
 * Recovery-only repair for the one crash ordering normal transfer cannot represent.
 *
 * Compact & Resume durably moves session S from chat A to chat B before publishing the
 * in-memory swarm move. If the process dies between those two steps, restore intentionally
 * brings the swarm back without its volatile transfer flag, so {@link commitPrimeTransfer}
 * must (and does) refuse. Continuation recovery can nevertheless prove from its WAL plus the
 * durable session metadata that A→B already committed. This hook lets that recovery authority
 * repair the projection without inventing a new transfer.
 *
 * It is deliberately not a general takeover API and is never exposed to MCP. The caller must
 * already have durable proof of this exact A→B transition. We additionally fail closed if B is
 * bound to any worker in the restored run. Repeating the same proven repair is idempotent.
 */
export function repairPrimeConversationAfterRecovery(
  fromConversationId: string,
  toConversationId: string
): boolean {
  if (!run || !fromConversationId || !toConversationId || fromConversationId === toConversationId) return false;
  const prime = run.agents.get(PRIME_ID);
  if (!prime) return false;

  if (run.primeConversationId === toConversationId && prime.info.conversationId === toConversationId) return true;
  if (run.primeConversationId !== fromConversationId || prime.info.conversationId !== fromConversationId) return false;

  for (const agent of run.agents.values()) {
    if (agent.info.id === PRIME_ID) continue;
    if (agent.info.conversationId === toConversationId) {
      logWarn(
        `multi-agent: recovery refused to move prime to conversation ${toConversationId}; ${agent.info.id} already owns it`
      );
      return false;
    }
  }

  run.primeConversationId = toConversationId;
  prime.info.conversationId = toConversationId;
  if (run.transfer?.from === fromConversationId) run.transfer = null;
  logInfo(
    `multi-agent: recovery repaired prime from conversation ${fromConversationId} to ${toConversationId} after durable session commit`
  );
  changed();
  return true;
}

// -------------------------------------------------------------------- state

export function swarmState(): SwarmState {
  const list = run ? [...run.agents.values()].map((agent) => ({ ...agent.info })) : [];
  list.sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'prime' ? -1 : 1));
  return {
    enabled: getConfig().multiAgent.enabled,
    running: run !== null,
    agents: list
  };
}

export function agentConversation(id: string): string | null {
  return run?.agents.get(id)?.info.conversationId ?? null;
}

/** Reverse lookup used to file a recorded event into the right session. */
export function agentForConversation(conversationId: string): string | null {
  if (!run) return null;
  if (conversationId === run.primeConversationId) return PRIME_ID;
  for (const agent of run.agents.values()) {
    if (agent.info.conversationId === conversationId) return agent.info.id;
  }
  return null;
}

/**
 * Binds a worker to the ChatGPT conversation it is running in, and starts it.
 *
 * This *is* the worker lifecycle transition. Called by the bridge when the extension
 * acknowledges the tab it opened — the one party that knows the mapping first-hand, and knows
 * it before the model in that tab has said anything — so by the time the worker reads its task
 * it is already an active member of the run and its later calls route by conversation alone.
 * Nothing is asked of the model to make that true.
 *
 * It can never move the prime: that binding is set once by `spawn` and moved only by an
 * authenticated transfer. It can never move a worker either — see
 * {@link bindWorkerConversation} for why one binding per slot and one slot per conversation
 * is an invariant rather than a preference.
 */
export function bindConversation(id: string, conversationId: string): boolean {
  const agent = run?.agents.get(id);
  if (!agent || agent.info.role !== 'worker' || isOver(agent.info.state)) return false;
  return activateWorker(agent, conversationId);
}

/**
 * Binds a worker to its conversation and makes it active, in one indivisible step.
 *
 * One step on purpose. A slot that is bound but not yet active is a state nothing can act
 * on and everything has to special-case: the bridge cannot tell whether its bootstrap
 * succeeded, `pendingWorkerSpawns` still owes it a tab, and the prime waits on a worker that
 * is, in every sense that matters, already running. Activation on binding is what makes
 * "the app opened this chat for this slot" and "this worker is running" the same fact.
 */
function activateWorker(agent: Agent, conversationId: string): boolean {
  if (!bindWorkerConversation(agent, conversationId)) return false;
  if (agent.info.state === 'invited') {
    agent.info.state = 'active';
    agent.info.activatedAt = Date.now();
    logInfo(`multi-agent: ${agent.info.id} is active in conversation ${conversationId}`);
    changed();
  }
  return true;
}

/**
 * The one place a worker's conversation is ever set. Exactly once, and to a free chat.
 *
 * Two invariants, both load-bearing for identity:
 *
 *   *One binding per slot.* A worker already running in a conversation stays there. Every
 *   later report of a different chat is either a mistake or someone else's tab, and honouring
 *   it would point the worker's messages, its recorded events and its workspace at a chat
 *   that is not doing the work — while the chat that *is* doing it stops being recognised at
 *   all. A binding is only re-set to the identical value, which is a no-op.
 *
 *   *One slot per conversation.* A conversation already holding the prime or another live
 *   worker cannot be bound again, or one chat would answer to two identities and
 *   {@link agentForConversation} would file its work under whichever it found first.
 *
 * The second check counts finished workers too. Their chats are tombstones: still readable,
 * never re-usable, and a new worker inheriting one would make the transcript of a worker that
 * is over look like the transcript of the one that replaced it.
 */
function bindWorkerConversation(agent: Agent, conversationId: string): boolean {
  if (!conversationId) return false;
  if (agent.info.conversationId === conversationId) return true;
  if (agent.info.conversationId) {
    logWarn(
      `multi-agent: refused to move ${agent.info.id} from conversation ${agent.info.conversationId} to ${conversationId}`
    );
    return false;
  }
  const taken = run ? agentForConversation(conversationId) : null;
  if (taken && taken !== agent.info.id) {
    logWarn(`multi-agent: refused to bind ${agent.info.id} to conversation ${conversationId}, already held by ${taken}`);
    return false;
  }
  agent.info.conversationId = conversationId;
  changed();
  return true;
}

/** Ends the run. Called when the user turns the mode off or clears the swarm. */
export function resetSwarm(): void {
  endRun('the run was cleared in the app');
  changed();
}

/** What a clear actually did, so the UI can say it rather than guess. */
export interface ClearResult {
  cleared: 'run' | 'worker' | 'none';
  report: AgentMessage | null;
  reason: string;
}

/**
 * The user clearing one row in the app.
 *
 * The prime *is* the run, so clearing it ends everything — there is no such thing as a run
 * whose prime was removed but whose workers continue. A worker is one slot: it is
 * terminalised, never deleted, so the row stays visible and honestly labelled as over while
 * its queued bootstrap is retired and the slot frees up.
 */
export function clearAgent(id: string): ClearResult {
  if (id === PRIME_ID) {
    if (!run) return { cleared: 'none', report: null, reason: 'there is no run to clear' };
    resetSwarm();
    return { cleared: 'run', report: null, reason: 'the run was cleared in the app' };
  }
  const agent = run?.agents.get(id);
  if (!agent) return { cleared: 'none', report: null, reason: `${id} is not part of this run` };
  if (isOver(agent.info.state)) return { cleared: 'none', report: null, reason: `${id} has already ended` };
  const reason = 'the user cleared this worker in the app';
  const outcome = failAgent(
    id,
    reason,
    `[${id} cleared] The user ended this worker from the app. It will not report and cannot be messaged. Carry on ` +
      'without it, or spawn a replacement worker if the work still needs doing.'
  );
  return { cleared: 'worker', report: outcome?.report ?? null, reason };
}

// -------------------------------------------------------------- persistence

export interface RetiredWorkersSnapshot {
  version: 1;
  savedAt: number;
  workers: RetiredChat[];
}

export function snapshotRetiredWorkers(): RetiredWorkersSnapshot {
  pruneRetiredWorkers();
  return { version: 1, savedAt: Date.now(), workers: [...retiredWorkers.values()].map((worker) => ({ ...worker })) };
}

export function restoreRetiredWorkers(snapshot: RetiredWorkersSnapshot | null): void {
  retiredWorkers.clear();
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.workers)) return;
  const cutoff = Date.now() - RETIRED_WORKER_TTL_MS;
  for (const worker of snapshot.workers.slice(-64)) {
    if (
      !worker ||
      typeof worker.id !== 'string' ||
      typeof worker.conversationId !== 'string' ||
      !worker.conversationId ||
      typeof worker.reason !== 'string' ||
      !Number.isFinite(worker.retiredAt) ||
      worker.retiredAt < cutoff
    ) {
      continue;
    }
    retiredWorkers.set(worker.conversationId, { ...worker });
  }
}

/**
 * What survives a restart.
 *
 * Agent state and unacknowledged messages are the parts that cannot be reconstructed: the
 * session log is the audit trail, but it does not know which messages were still in flight.
 * Nothing here is a credential: an agent is the conversation it runs in, and that id is
 * recorded on purpose.
 */
export interface SwarmSnapshot {
  /**
   * 4 = agents identified by conversation alone, with no routing codes. Earlier shapes are
   * discarded rather than migrated: a version-3 run's workers were identified by codes their
   * chats still hold and this build cannot honour, so restoring one would produce a run whose
   * workers can never be recognised again.
   */
  version: 4;
  savedAt: number;
  runId: string;
  primeConversationId: string;
  startedAt: number;
  agents: Array<{
    info: AgentInfo;
    queue: AgentMessage[];
  }>;
}

export function snapshotSwarm(): SwarmSnapshot | null {
  if (!run) return null;
  return {
    version: 4,
    savedAt: Date.now(),
    runId: run.runId,
    primeConversationId: run.primeConversationId,
    startedAt: run.startedAt,
    agents: [...run.agents.values()].map((agent) => ({
      info: { ...agent.info },
      // Acknowledged messages are already durable session events; what has to survive here
      // is the in-flight tail.
      queue: agent.queue.filter((message) => message.ackedAt === null).map((message) => ({ ...message }))
    }))
  };
}

/**
 * Restores a run from disk.
 *
 * Messages that were in flight come back unoffered rather than delivered: the app cannot
 * know whether the result carrying them ever arrived, and offering one twice is the
 * recoverable half of that uncertainty. An open transfer is deliberately not restored — a
 * handover interrupted by a restart is abandoned, and the prime stays where it was.
 */
export function restoreSwarm(snapshot: SwarmSnapshot | null): void {
  run = null;
  criticalMutationRevision = 0;
  persistedCriticalRevision = 0;
  criticalPersistFlight = null;
  if (!snapshot || !Array.isArray(snapshot.agents)) return;
  if (snapshot.version !== 4 || typeof snapshot.primeConversationId !== 'string' || !snapshot.primeConversationId) {
    logInfo('multi-agent: discarded a run saved by an older build — spawn again to start a new one.');
    return;
  }
  const agents = new Map<string, Agent>();
  for (const entry of snapshot.agents) {
    if (!entry?.info?.id) continue;
    const agent: Agent = {
      info: { ...entry.info },
      queue: (Array.isArray(entry.queue) ? entry.queue : []).map((message) => ({
        ...message,
        offeredAt: null,
        offeredOnFinish: message.offeredOnFinish ?? false
      }))
    };
    recount(agent);
    agents.set(entry.info.id, agent);
  }
  if (!agents.has(PRIME_ID)) {
    logInfo('multi-agent: discarded a saved run with no prime agent');
    return;
  }
  run = {
    runId: snapshot.runId || randomUUID().slice(0, 8),
    primeConversationId: snapshot.primeConversationId,
    startedAt: snapshot.startedAt || snapshot.savedAt || Date.now(),
    agents,
    transfer: null
  };
  // This process has been watching for exactly no time. Every `lastSeenAt` that came back
  // from disk predates the restart and cannot be evidence of silence since it.
  livenessFloor = Date.now();

  // A worker that was invited but whose chat was never bound needs it opened again. If the
  // bridge is not registered yet — at startup it is not, because the run is restored first —
  // this is replayed by onSpawnRequest the moment it registers.
  const stranded = pendingWorkerSpawns();
  if (stranded.length > 0 && spawnRequest) {
    spawnRequest(stranded);
    logInfo(`multi-agent: re-requested ${stranded.length} worker chat(s) that were unbound at the restart`);
  }
  const pending = [...agents.values()].reduce((sum, agent) => sum + agent.info.pending, 0);
  logInfo(`multi-agent: restored run ${run.runId} with ${agents.size} agent(s) and ${pending} undelivered message(s)`);
}

/** Test seam: forgets everything without touching disk. */
export function resetAgentsForTests(): void {
  run = null;
  retiredWorkers.clear();
  livenessFloor = 0;
  spawnRequest = null;
  persist = null;
  persistNow = null;
  criticalMutationRevision = 0;
  persistedCriticalRevision = 0;
  criticalPersistFlight = null;
  retiredPersist = null;
  listeners.clear();
  endListeners.clear();
}
