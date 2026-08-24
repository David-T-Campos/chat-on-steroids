/** Owns the process lifecycle for goal tasks assigned to an external local agent. */

import type { GoalTask } from '../shared/goals.js';
import {
  buildAgentInvocation,
  parseAgentResult,
  type AgentLaunchRequest,
  type ExternalAgentProvider
} from './agent-providers.js';
import {
  assignGoalTask,
  cancelGoalTask,
  completeGoalTask,
  failGoalTask,
  goalState,
  persistCriticalGoalsNow
} from './goals.js';
import {
  getManagedProcess,
  startManagedProcess,
  stopManagedProcess,
  type ManagedProcessStatus
} from './process-manager.js';

const PROVIDER_OUTPUT_LINES = 1_000;
const RECONCILE_INTERVAL_MS = 1_000;
export const DEFAULT_AGENT_TASK_TIMEOUT_MS = 30 * 60_000;

export interface ApprovedAgentWorkspace {
  /** Already resolved through the approved-root sandbox by the calling boundary. */
  real: string;
  /** Virtual path safe to show to the model and renderer. */
  virtual: string;
}

export interface StartAgentTaskInput extends Omit<AgentLaunchRequest, 'prompt'> {
  goalId: string;
  taskId: string;
  workspace: ApprovedAgentWorkspace;
}

interface OwnedRun {
  goalId: string;
  taskId: string;
  provider: ExternalAgentProvider;
  processId: string;
  deadlineAt: number;
}

interface AgentProcessOperations {
  start(command: string, args: readonly string[], cwd: string): Promise<ManagedProcessStatus>;
  get(id: string, maxLines: number): ManagedProcessStatus;
  stop(id: string, maxLines: number): Promise<ManagedProcessStatus>;
}

const defaultProcessOperations: AgentProcessOperations = {
  start: (command, args, cwd) => startManagedProcess(command, args, cwd),
  get: (id, maxLines) => getManagedProcess(id, maxLines),
  stop: (id, maxLines) => stopManagedProcess(id, maxLines)
};

let processOperations = defaultProcessOperations;
const owned = new Map<string, OwnedRun>();
const refreshFlights = new Map<string, Promise<GoalTask>>();
let reconcileTimer: NodeJS.Timeout | null = null;
let reconcileFlight: Promise<void> | null = null;

function runKey(goalId: string, taskId: string): string {
  return `${goalId}:${taskId}`;
}

function taskFor(goalId: string, taskId: string): GoalTask {
  const goal = goalState(goalId).goals[0]!;
  const task = goal.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown task id: ${taskId}`);
  return task;
}

function validateWorkspace(workspace: ApprovedAgentWorkspace): void {
  if (!workspace || typeof workspace.real !== 'string' || workspace.real.trim() === '') {
    throw new Error('An approved real workspace is required');
  }
  if (typeof workspace.virtual !== 'string' || !workspace.virtual.startsWith('/')) {
    throw new Error('An approved virtual workspace is required');
  }
}

function taskPrompt(goalId: string, taskId: string, workspace: ApprovedAgentWorkspace): string {
  const goal = goalState(goalId).goals[0]!;
  const task = goal.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown task id: ${taskId}`);
  return [
    `Goal: ${goal.title}`,
    `Objective: ${goal.objective}`,
    `Task: ${task.title}`,
    `Acceptance: ${task.acceptance}`,
    `Workspace: ${workspace.virtual}`,
    '',
    'Work only on this task. Respect repository instructions and existing user changes. Return a concise factual result with changes, validation, and blockers.'
  ].join('\n');
}

function outputOf(status: ManagedProcessStatus): Parameters<typeof parseAgentResult>[1] {
  return {
    exitCode: status.exitCode,
    stdout: status.stdout,
    stderr: status.stderr,
    truncated: status.stdoutTruncated || status.stderrTruncated || status.stdoutCursorLost || status.stderrCursorLost
  };
}

function failLostRun(run: OwnedRun, error: unknown): GoalTask {
  owned.delete(runKey(run.goalId, run.taskId));
  const detail = error instanceof Error ? error.message : String(error);
  return failGoalTask(run.goalId, run.taskId, `Owned provider process was lost: ${detail}`);
}

function stopReconcileTimerIfIdle(): void {
  if (owned.size > 0 || !reconcileTimer) return;
  clearInterval(reconcileTimer);
  reconcileTimer = null;
}

function reconcileOwnedRuns(): Promise<void> {
  if (reconcileFlight) return reconcileFlight;
  const flight = (async () => {
    try {
      for (const run of [...owned.values()]) {
        try {
          const task = taskFor(run.goalId, run.taskId);
          if (task.status !== 'running') {
            owned.delete(runKey(run.goalId, run.taskId));
            continue;
          }
          if (Date.now() >= run.deadlineAt) {
            await processOperations.stop(run.processId, 80).catch(() => undefined);
            owned.delete(runKey(run.goalId, run.taskId));
            if (taskFor(run.goalId, run.taskId).status === 'running') {
              failGoalTask(
                run.goalId,
                run.taskId,
                'Provider task exceeded the 30 minute runtime deadline and was stopped.'
              );
            }
            continue;
          }
          await refreshAgentTask(run.goalId, run.taskId);
        } catch {
          // refreshAgentTask converts provider/process failures into task failures. The only
          // remaining errors are stale concurrent lifecycle calls, which the next sweep sees.
        }
      }
      await persistCriticalGoalsNow().catch(() => false);
    } finally {
      stopReconcileTimerIfIdle();
    }
  })().finally(() => {
    if (reconcileFlight === flight) reconcileFlight = null;
  });
  reconcileFlight = flight;
  return flight;
}

function ensureReconcileTimer(): void {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => void reconcileOwnedRuns(), RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
}

export async function startAgentTask(input: StartAgentTaskInput): Promise<GoalTask> {
  validateWorkspace(input.workspace);
  const key = runKey(input.goalId, input.taskId);
  if (owned.has(key)) throw new Error(`Task ${input.taskId} already has a running provider process`);
  const current = taskFor(input.goalId, input.taskId);
  if (current.status !== 'queued') throw new Error(`Task ${input.taskId} is not queued (state ${current.status})`);

  const invocation = buildAgentInvocation({
    provider: input.provider,
    prompt: taskPrompt(input.goalId, input.taskId, input.workspace),
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    ...(input.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: input.maxBudgetUsd })
  });
  const process = await processOperations.start(invocation.command, invocation.args, input.workspace.real);
  try {
    const task = assignGoalTask(input.goalId, input.taskId, {
      provider: input.provider,
      runId: process.id
    });
    owned.set(key, {
      goalId: input.goalId,
      taskId: input.taskId,
      provider: input.provider,
      processId: process.id,
      deadlineAt: Date.now() + DEFAULT_AGENT_TASK_TIMEOUT_MS
    });
    ensureReconcileTimer();
    return task;
  } catch (error) {
    // A child that cannot be bound to its ledger entry has no owner. End it before
    // publishing the failure; the task itself is still queued and may be retried.
    await processOperations.stop(process.id, PROVIDER_OUTPUT_LINES).catch(() => undefined);
    throw error;
  }
}

async function refreshAgentTaskOnce(goalId: string, taskId: string): Promise<GoalTask> {
  const current = taskFor(goalId, taskId);
  if (current.status !== 'running') {
    throw new Error(`Task ${taskId} is terminal or not running (state ${current.status})`);
  }
  const key = runKey(goalId, taskId);
  const run = owned.get(key);
  if (!run) return failGoalTask(goalId, taskId, 'Owned provider process was lost before its result was collected.');

  let process: ManagedProcessStatus;
  try {
    process = processOperations.get(run.processId, PROVIDER_OUTPUT_LINES);
  } catch (error) {
    return failLostRun(run, error);
  }
  if (process.running) return current;

  owned.delete(key);
  try {
    return completeGoalTask(goalId, taskId, parseAgentResult(run.provider, outputOf(process)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failGoalTask(goalId, taskId, detail);
  }
}

export function refreshAgentTask(goalId: string, taskId: string): Promise<GoalTask> {
  const key = runKey(goalId, taskId);
  const current = refreshFlights.get(key);
  if (current) return current;
  const flight = refreshAgentTaskOnce(goalId, taskId).finally(() => {
    if (refreshFlights.get(key) === flight) refreshFlights.delete(key);
    stopReconcileTimerIfIdle();
  });
  refreshFlights.set(key, flight);
  return flight;
}

export async function cancelAgentTask(goalId: string, taskId: string): Promise<GoalTask> {
  const current = taskFor(goalId, taskId);
  if (current.status !== 'running') {
    throw new Error(`Task ${taskId} is terminal or not running (state ${current.status})`);
  }
  const key = runKey(goalId, taskId);
  const run = owned.get(key);
  if (!run) return failGoalTask(goalId, taskId, 'Owned provider process was lost before it could be cancelled.');
  await processOperations.stop(run.processId, 80);
  owned.delete(key);
  stopReconcileTimerIfIdle();
  return cancelGoalTask(goalId, taskId);
}

/** Application-shutdown owner for every provider process started through this module. */
export async function stopAllAgentTasks(): Promise<void> {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  await reconcileFlight?.catch(() => undefined);
  const runs = [...owned.values()];
  await Promise.all(
    runs.map(async (run) => {
      const key = runKey(run.goalId, run.taskId);
      try {
        await processOperations.stop(run.processId, 1);
        owned.delete(key);
        if (taskFor(run.goalId, run.taskId).status === 'running') cancelGoalTask(run.goalId, run.taskId);
      } catch (error) {
        owned.delete(key);
        if (taskFor(run.goalId, run.taskId).status === 'running') {
          const detail = error instanceof Error ? error.message : String(error);
          failGoalTask(run.goalId, run.taskId, `Provider cleanup failed during application shutdown: ${detail}`);
        }
      }
    })
  );
  stopReconcileTimerIfIdle();
}

/** Dependency seam used by lifecycle tests; production callers never replace these operations. */
export function setAgentProcessOperationsForTests(operations: AgentProcessOperations): void {
  processOperations = operations;
}

export function resetAgentRunnerForTests(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  reconcileFlight = null;
  refreshFlights.clear();
  owned.clear();
  processOperations = defaultProcessOperations;
}
