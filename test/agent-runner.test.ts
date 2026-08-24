import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedProcessStatus } from '../src/main/process-manager.js';

const { createGoal, goalState, resetGoalsForTests } = await import('../src/main/goals.js');
const {
  cancelAgentTask,
  refreshAgentTask,
  resetAgentRunnerForTests,
  setAgentProcessOperationsForTests,
  startAgentTask,
  stopAllAgentTasks
} = await import('../src/main/agent-runner.js');

function processStatus(overrides: Partial<ManagedProcessStatus> = {}): ManagedProcessStatus {
  return {
    id: 'p1',
    pid: 8123,
    command: 'claude',
    running: true,
    stopping: false,
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    durationMs: 20,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    cursor: 'p1.0.0',
    outputMode: 'tail',
    stdoutCursorLost: false,
    stderrCursorLost: false,
    stdoutLinesPending: 0,
    stderrLinesPending: 0,
    stopMode: null,
    tty: false,
    cols: 120,
    rows: 30,
    ...overrides
  };
}

function oneTask(): { goalId: string; taskId: string } {
  const goal = createGoal({
    title: 'Ship orchestration',
    objective: 'Coordinate a safe external review.',
    tasks: [{ title: 'Audit the bridge', acceptance: 'Return findings with file and line evidence.' }]
  });
  return { goalId: goal.id, taskId: goal.tasks[0]!.id };
}

beforeEach(() => {
  resetGoalsForTests();
  resetAgentRunnerForTests();
});

describe('starting provider tasks', () => {
  it('launches one fixed provider in the approved workspace and marks the task running', async () => {
    const started = vi.fn(async (_command: string, _args: readonly string[], _cwd: string) => processStatus());
    setAgentProcessOperationsForTests({
      start: started,
      get: () => processStatus(),
      stop: async () => processStatus({ running: false, exitCode: 130 })
    });
    const ids = oneTask();

    const task = await startAgentTask({
      ...ids,
      provider: 'claude-code',
      workspace: { real: 'C:\\approved\\repo', virtual: '/repo' },
      maxTurns: 5,
      maxBudgetUsd: 2
    });

    expect(started).toHaveBeenCalledTimes(1);
    const [command, args, cwd] = started.mock.calls[0]!;
    expect(command).toBe('claude');
    expect(cwd).toBe('C:\\approved\\repo');
    expect(args).toContain('--no-session-persistence');
    expect(args.join('\n')).toContain('Goal: Ship orchestration');
    expect(args.join('\n')).toContain('Acceptance: Return findings with file and line evidence.');
    expect(task).toMatchObject({ status: 'running', provider: 'claude-code', runId: 'p1' });
    expect(goalState(ids.goalId).goals[0]!.tasks[0]!.runId).toBe('p1');
  });

  it('refuses a duplicate launch without starting a second process', async () => {
    const started = vi.fn(async () => processStatus());
    setAgentProcessOperationsForTests({
      start: started,
      get: () => processStatus(),
      stop: async () => processStatus({ running: false, exitCode: 130 })
    });
    const ids = oneTask();
    const request = { ...ids, provider: 'hermes' as const, workspace: { real: 'C:\\approved', virtual: '/repo' } };

    await startAgentTask(request);
    await expect(startAgentTask(request)).rejects.toThrow(/already|queued|running/i);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('leaves a task queued when the provider process cannot start', async () => {
    setAgentProcessOperationsForTests({
      start: async () => {
        throw new Error('not installed');
      },
      get: () => processStatus(),
      stop: async () => processStatus({ running: false, exitCode: 130 })
    });
    const ids = oneTask();

    await expect(
      startAgentTask({ ...ids, provider: 'hermes', workspace: { real: 'C:\\approved', virtual: '/repo' } })
    ).rejects.toThrow(/not installed/i);
    expect(goalState(ids.goalId).goals[0]!.tasks[0]).toMatchObject({ status: 'queued', provider: null, runId: null });
  });
});

describe('reconciling provider tasks', () => {
  it('keeps a live task running, then records a proven Claude result exactly once', async () => {
    let status = processStatus();
    setAgentProcessOperationsForTests({
      start: async () => status,
      get: () => status,
      stop: async () => processStatus({ running: false, exitCode: 130 })
    });
    const ids = oneTask();
    await startAgentTask({
      ...ids,
      provider: 'claude-code',
      workspace: { real: 'C:\\approved', virtual: '/repo' }
    });

    expect((await refreshAgentTask(ids.goalId, ids.taskId)).status).toBe('running');
    status = processStatus({
      running: false,
      exitCode: 0,
      stdout: JSON.stringify({ type: 'result', is_error: false, result: 'Bridge audit passed.' })
    });
    expect(await refreshAgentTask(ids.goalId, ids.taskId)).toMatchObject({
      status: 'completed',
      result: 'Bridge audit passed.'
    });
    await expect(refreshAgentTask(ids.goalId, ids.taskId)).rejects.toThrow(/not running|terminal/i);
  });

  it('turns a nonzero provider exit or lost owned process into an explicit task failure', async () => {
    let mode: 'failed' | 'lost' = 'failed';
    setAgentProcessOperationsForTests({
      start: async () => processStatus(),
      get: () => {
        if (mode === 'lost') throw new Error('Unknown managed process id: p1');
        return processStatus({ running: false, exitCode: 2, stderr: 'provider failed' });
      },
      stop: async () => processStatus({ running: false, exitCode: 130 })
    });
    const failedIds = oneTask();
    await startAgentTask({
      ...failedIds,
      provider: 'hermes',
      workspace: { real: 'C:\\approved', virtual: '/repo' }
    });
    expect(await refreshAgentTask(failedIds.goalId, failedIds.taskId)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/exited 2/i)
    });

    resetGoalsForTests();
    resetAgentRunnerForTests();
    mode = 'lost';
    setAgentProcessOperationsForTests({
      start: async () => processStatus(),
      get: () => {
        throw new Error('Unknown managed process id: p1');
      },
      stop: async () => processStatus({ running: false, exitCode: 130 })
    });
    const lostIds = oneTask();
    await startAgentTask({
      ...lostIds,
      provider: 'hermes',
      workspace: { real: 'C:\\approved', virtual: '/repo' }
    });
    expect(await refreshAgentTask(lostIds.goalId, lostIds.taskId)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/lost|unknown managed process/i)
    });
  });
});

describe('cancellation and shutdown', () => {
  it('stops the owned process before marking its task cancelled', async () => {
    const stopped = vi.fn(async () => processStatus({ running: false, exitCode: 130, stopMode: 'forced' }));
    setAgentProcessOperationsForTests({ start: async () => processStatus(), get: () => processStatus(), stop: stopped });
    const ids = oneTask();
    await startAgentTask({ ...ids, provider: 'hermes', workspace: { real: 'C:\\approved', virtual: '/repo' } });

    const task = await cancelAgentTask(ids.goalId, ids.taskId);

    expect(stopped).toHaveBeenCalledWith('p1', 80);
    expect(task).toMatchObject({ status: 'cancelled', runId: null, error: null });
  });

  it('owns application shutdown for every provider process it launched', async () => {
    let next = 1;
    const stopped: string[] = [];
    setAgentProcessOperationsForTests({
      start: async (command) => processStatus({ id: `p${next++}`, command }),
      get: (id) => processStatus({ id }),
      stop: async (id) => {
        stopped.push(id);
        return processStatus({ id, running: false, exitCode: 130 });
      }
    });
    const first = oneTask();
    const second = createGoal({
      title: 'Second',
      objective: 'Second process',
      tasks: [{ title: 'Two', acceptance: 'Stopped on shutdown' }]
    });
    await startAgentTask({ ...first, provider: 'hermes', workspace: { real: 'C:\\approved', virtual: '/repo' } });
    await startAgentTask({
      goalId: second.id,
      taskId: second.tasks[0]!.id,
      provider: 'claude-code',
      workspace: { real: 'C:\\approved', virtual: '/repo' }
    });

    await stopAllAgentTasks();

    expect(stopped.sort()).toEqual(['p1', 'p2']);
    expect(goalState().goals.flatMap((goal) => goal.tasks).map((task) => task.status)).toEqual([
      'cancelled',
      'cancelled'
    ]);
  });
});
