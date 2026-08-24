/**
 * Durable goal and task ledger.
 *
 * This module records orchestration truth; it does not launch a provider. A separate runner
 * owns child processes and reports their accepted transitions here. Keeping those jobs apart
 * means restoring a JSON snapshot can never start work as a side effect.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AGENT_PROVIDERS,
  type AgentProvider,
  type Goal,
  type GoalsState,
  type GoalTask
} from '../shared/goals.js';

export const MAX_GOALS = 50;
export const MAX_TASKS_PER_GOAL = 32;
const MAX_TITLE_CHARS = 120;
const MAX_OBJECTIVE_CHARS = 8_000;
const MAX_ACCEPTANCE_CHARS = 4_000;
const MAX_RESULT_CHARS = 16_000;
const MAX_RUN_ID_CHARS = 80;
const RESTORE_INTERRUPTED = 'Task interrupted because the application restarted before its provider process finished.';

const idSchema = z.string().regex(/^(?:goal|task)_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const runIdSchema = z.string().min(1).max(MAX_RUN_ID_CHARS).regex(/^[A-Za-z0-9_-]+$/);
const providerSchema = z.enum(AGENT_PROVIDERS);
const taskSchema: z.ZodType<GoalTask> = z.object({
  id: idSchema.refine((value) => value.startsWith('task_')),
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  acceptance: z.string().min(1).max(MAX_ACCEPTANCE_CHARS),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  provider: providerSchema.nullable(),
  runId: runIdSchema.nullable(),
  result: z.string().max(MAX_RESULT_CHARS).nullable(),
  error: z.string().max(MAX_RESULT_CHARS).nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().nullable(),
  finishedAt: z.number().int().nonnegative().nullable()
});
interface StoredGoal extends Goal {
  /** Exact browser conversation proved at creation; deliberately omitted from every public projection. */
  ownerConversationId: string | null;
}

const goalSchema: z.ZodType<StoredGoal> = z.object({
  id: idSchema.refine((value) => value.startsWith('goal_')),
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  objective: z.string().min(1).max(MAX_OBJECTIVE_CHARS),
  status: z.enum(['active', 'completed', 'cancelled']),
  tasks: z.array(taskSchema).max(MAX_TASKS_PER_GOAL),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
  ownerConversationId: z.string().min(1).max(500).nullable()
});
const snapshotSchema = z.object({ version: z.literal(1), goals: z.array(goalSchema).max(MAX_GOALS) });

export interface NewGoalTask {
  title: string;
  acceptance: string;
}

export interface NewGoal {
  title: string;
  objective: string;
  tasks?: NewGoalTask[];
}

export interface GoalAssignment {
  provider: AgentProvider;
  runId: string;
}

export interface GoalsSnapshot {
  version: 1;
  goals: StoredGoal[];
}

export interface GoalOwner {
  ownerConversationId?: string | null;
}

const goals = new Map<string, StoredGoal>();
const listeners = new Set<() => void>();
let persist: (() => void) | null = null;
let persistNow: ((snapshot: GoalsSnapshot) => Promise<void>) | null = null;
let criticalMutationRevision = 0;
let persistedCriticalRevision = 0;
let criticalPersistFlight: Promise<boolean> | null = null;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cleanText(value: string, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const clean = value.trim();
  if (!clean) throw new Error(`${label} is required`);
  if (clean.length > max) throw new Error(`${label} is too long (limit ${max} characters)`);
  return clean;
}

function changed(): void {
  criticalMutationRevision += 1;
  persist?.();
  for (const listener of listeners) listener();
}

function goalById(goalId: string): StoredGoal {
  const goal = goals.get(goalId);
  if (!goal) throw new Error(`Unknown goal id: ${goalId}`);
  return goal;
}

function taskById(goal: StoredGoal, taskId: string): GoalTask {
  const task = goal.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown task id: ${taskId}`);
  return task;
}

function ensureActive(goal: StoredGoal): void {
  if (goal.status !== 'active') throw new Error(`Goal ${goal.id} is ${goal.status}, not active`);
}

function ensureRunning(task: GoalTask): void {
  if (task.status !== 'running') {
    throw new Error(`Task ${task.id} is terminal or not running (state ${task.status})`);
  }
}

function newTask(input: NewGoalTask, at: number): GoalTask {
  return {
    id: `task_${randomUUID()}`,
    title: cleanText(input.title, 'Task title', MAX_TITLE_CHARS),
    acceptance: cleanText(input.acceptance, 'Task acceptance criteria', MAX_ACCEPTANCE_CHARS),
    status: 'queued',
    provider: null,
    runId: null,
    result: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    finishedAt: null
  };
}

function refreshGoal(goal: StoredGoal, at: number): void {
  goal.updatedAt = at;
  if (goal.tasks.length > 0 && goal.tasks.every((task) => task.status === 'completed')) {
    goal.status = 'completed';
    goal.completedAt = at;
  }
}

export function onGoalsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The app host registers its debounced durable writer here. */
export function onGoalsPersist(handler: (() => void) | null): void {
  persist = handler;
}

export function onGoalsPersistNow(handler: ((snapshot: GoalsSnapshot) => Promise<void>) | null): void {
  persistNow = handler;
}

/** Drains every accepted ledger revision through the host's atomic durable writer. */
export async function persistCriticalGoalsNow(): Promise<boolean> {
  if (!persistNow) return false;
  if (persistedCriticalRevision >= criticalMutationRevision) return true;
  if (!criticalPersistFlight) {
    criticalPersistFlight = (async () => {
      while (persistedCriticalRevision < criticalMutationRevision) {
        const handler = persistNow;
        if (!handler) return false;
        const targetRevision = criticalMutationRevision;
        await handler(snapshotGoals());
        persistedCriticalRevision = Math.max(persistedCriticalRevision, targetRevision);
      }
      return true;
    })().finally(() => {
      criticalPersistFlight = null;
    });
  }
  return criticalPersistFlight;
}

function publicGoal(goal: StoredGoal): Goal {
  const { ownerConversationId: _ownerConversationId, ...visible } = goal;
  return clone(visible);
}

export function createGoal(input: NewGoal, owner: GoalOwner = {}): Goal {
  if (goals.size >= MAX_GOALS) throw new Error(`Too many goals (limit ${MAX_GOALS})`);
  const taskInputs = input.tasks ?? [];
  if (taskInputs.length > MAX_TASKS_PER_GOAL) {
    throw new Error(`Too many tasks in one goal (limit ${MAX_TASKS_PER_GOAL})`);
  }
  const at = Date.now();
  // Validate every field before publishing the goal, so an invalid later task cannot leave
  // a partial ledger entry behind.
  const tasks = taskInputs.map((task) => newTask(task, at));
  const ownerConversationId = owner.ownerConversationId ?? null;
  if (
    ownerConversationId !== null &&
    (typeof ownerConversationId !== 'string' || ownerConversationId.length === 0 || ownerConversationId.length > 500)
  ) {
    throw new Error('Goal owner conversation identity is invalid');
  }
  const goal: StoredGoal = {
    id: `goal_${randomUUID()}`,
    title: cleanText(input.title, 'Goal title', MAX_TITLE_CHARS),
    objective: cleanText(input.objective, 'Goal objective', MAX_OBJECTIVE_CHARS),
    status: 'active',
    tasks,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    ownerConversationId
  };
  goals.set(goal.id, goal);
  changed();
  return publicGoal(goal);
}

export function assertGoalOwner(goalId: string, conversationId: string | null | undefined): void {
  if (!conversationId) throw new Error('GOAL_IDENTITY_REQUIRED: this goal action needs an exact conversation identity.');
  const goal = goalById(goalId);
  if (!goal.ownerConversationId || goal.ownerConversationId !== conversationId) {
    throw new Error('GOAL_ACCESS_DENIED: this goal belongs to a different conversation.');
  }
}

/** Moves every goal owned by chat A to chat B during the app's authenticated continuation commit. */
export function transferGoalOwnership(fromConversationId: string, toConversationId: string): number {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return 0;
  let moved = 0;
  const at = Date.now();
  for (const goal of goals.values()) {
    if (goal.ownerConversationId !== fromConversationId) continue;
    goal.ownerConversationId = toConversationId;
    goal.updatedAt = at;
    moved += 1;
  }
  if (moved > 0) changed();
  return moved;
}

export function runningGoalTaskForProviderRun(
  provider: AgentProvider,
  runId: string
): { goalId: string; task: GoalTask } | null {
  for (const goal of goals.values()) {
    const task = goal.tasks.find(
      (candidate) => candidate.status === 'running' && candidate.provider === provider && candidate.runId === runId
    );
    if (task) return { goalId: goal.id, task: clone(task) };
  }
  return null;
}

export function addGoalTasks(goalId: string, inputs: NewGoalTask[]): Goal {
  const goal = goalById(goalId);
  ensureActive(goal);
  if (inputs.length === 0) throw new Error('At least one task is required');
  if (goal.tasks.length + inputs.length > MAX_TASKS_PER_GOAL) {
    throw new Error(`Too many tasks in one goal (limit ${MAX_TASKS_PER_GOAL})`);
  }
  const at = Date.now();
  const additions = inputs.map((task) => newTask(task, at));
  goal.tasks.push(...additions);
  goal.updatedAt = at;
  changed();
  return publicGoal(goal);
}

export function assignGoalTask(goalId: string, taskId: string, assignment: GoalAssignment): GoalTask {
  const goal = goalById(goalId);
  ensureActive(goal);
  const task = taskById(goal, taskId);
  if (task.status !== 'queued') throw new Error(`Task ${task.id} is not queued (state ${task.status})`);
  const runId = runIdSchema.parse(assignment.runId);
  for (const candidate of goals.values()) {
    if (
      candidate.tasks.some(
        (other) => other.status === 'running' && other.provider === assignment.provider && other.runId === runId
      )
    ) {
      throw new Error(`Provider run ${runId} is already assigned to another task`);
    }
  }
  const at = Date.now();
  task.provider = providerSchema.parse(assignment.provider);
  task.runId = runId;
  task.status = 'running';
  task.startedAt = at;
  task.updatedAt = at;
  task.finishedAt = null;
  task.result = null;
  task.error = null;
  goal.updatedAt = at;
  changed();
  return clone(task);
}

export function completeGoalTask(goalId: string, taskId: string, result: string): GoalTask {
  const goal = goalById(goalId);
  ensureActive(goal);
  const task = taskById(goal, taskId);
  ensureRunning(task);
  const at = Date.now();
  task.status = 'completed';
  task.result = cleanText(result, 'Task result', MAX_RESULT_CHARS);
  task.error = null;
  task.updatedAt = at;
  task.finishedAt = at;
  refreshGoal(goal, at);
  changed();
  return clone(task);
}

export function failGoalTask(goalId: string, taskId: string, error: string): GoalTask {
  const goal = goalById(goalId);
  ensureActive(goal);
  const task = taskById(goal, taskId);
  ensureRunning(task);
  const at = Date.now();
  task.status = 'failed';
  task.error = cleanText(error, 'Task error', MAX_RESULT_CHARS);
  task.result = null;
  task.updatedAt = at;
  task.finishedAt = at;
  goal.updatedAt = at;
  changed();
  return clone(task);
}

export function cancelGoalTask(goalId: string, taskId: string): GoalTask {
  const goal = goalById(goalId);
  ensureActive(goal);
  const task = taskById(goal, taskId);
  ensureRunning(task);
  const at = Date.now();
  task.status = 'cancelled';
  task.runId = null;
  task.result = null;
  task.error = null;
  task.updatedAt = at;
  task.finishedAt = at;
  goal.updatedAt = at;
  changed();
  return clone(task);
}

export function goalState(goalId?: string): GoalsState {
  if (goalId !== undefined) return { goals: [publicGoal(goalById(goalId))] };
  return { goals: [...goals.values()].map((goal) => publicGoal(goal)) };
}

export function snapshotGoals(): GoalsSnapshot {
  return { version: 1, goals: [...goals.values()].map((goal) => clone(goal)) };
}

/**
 * Restores data only when the whole snapshot validates. Provider processes are never
 * resurrected from JSON; any task that claimed to be running is failed explicitly.
 */
export function restoreGoals(snapshot: GoalsSnapshot | null): void {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) return;
  const restored = new Map<string, StoredGoal>();
  const at = Date.now();
  for (const candidate of parsed.data.goals) {
    if (restored.has(candidate.id)) return;
    if (new Set(candidate.tasks.map((task) => task.id)).size !== candidate.tasks.length) return;
    const goal = clone(candidate);
    for (const task of goal.tasks) {
      if (task.status !== 'running') continue;
      task.status = 'failed';
      task.runId = null;
      task.result = null;
      task.error = RESTORE_INTERRUPTED;
      task.updatedAt = at;
      task.finishedAt = at;
    }
    if (goal.tasks.some((task) => task.status === 'failed') && goal.status === 'completed') {
      goal.status = 'active';
      goal.completedAt = null;
    }
    goal.updatedAt = Math.max(goal.updatedAt, at);
    restored.set(goal.id, goal);
  }
  goals.clear();
  for (const [id, goal] of restored) goals.set(id, goal);
}

export function resetGoalsForTests(): void {
  goals.clear();
  listeners.clear();
  persist = null;
  persistNow = null;
  criticalMutationRevision = 0;
  persistedCriticalRevision = 0;
  criticalPersistFlight = null;
}
