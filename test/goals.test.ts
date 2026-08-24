import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addGoalTasks,
  assignGoalTask,
  completeGoalTask,
  createGoal,
  failGoalTask,
  goalState,
  onGoalsChange,
  resetGoalsForTests,
  restoreGoals,
  snapshotGoals
} = await import('../src/main/goals.js');

beforeEach(() => resetGoalsForTests());

describe('goal creation', () => {
  it('normalizes one objective and creates bounded queued tasks', () => {
    const goal = createGoal({
      title: '  Release control plane  ',
      objective: '  Ship a durable multi-provider orchestration layer.  ',
      tasks: [
        { title: '  Build ledger  ', acceptance: 'All state survives a restart.' },
        { title: 'Wire providers', acceptance: 'Claude and Hermes are fixed adapters.' }
      ]
    });

    expect(goal).toMatchObject({
      title: 'Release control plane',
      objective: 'Ship a durable multi-provider orchestration layer.',
      status: 'active'
    });
    expect(goal.id).toMatch(/^goal_[0-9a-f-]{36}$/);
    expect(goal.tasks).toHaveLength(2);
    expect(goal.tasks[0]).toMatchObject({
      title: 'Build ledger',
      acceptance: 'All state survives a restart.',
      status: 'queued',
      provider: null,
      runId: null,
      result: null,
      error: null
    });
    expect(goal.tasks[0]!.id).toMatch(/^task_[0-9a-f-]{36}$/);
  });

  it('rejects empty fields and an unbounded task list before mutating state', () => {
    expect(() => createGoal({ title: ' ', objective: 'x' })).toThrow(/title/i);
    expect(() =>
      createGoal({
        title: 'Too many',
        objective: 'Bound the ledger',
        tasks: Array.from({ length: 33 }, (_, index) => ({ title: `Task ${index}`, acceptance: 'Done' }))
      })
    ).toThrow(/32/);
    expect(goalState().goals).toEqual([]);
  });

  it('notifies listeners once per accepted mutation and returns defensive clones', () => {
    const listener = vi.fn();
    const off = onGoalsChange(listener);
    const created = createGoal({ title: 'Control plane', objective: 'Coordinate work' });
    addGoalTasks(created.id, [{ title: 'One', acceptance: 'One is done' }]);
    off();

    expect(listener).toHaveBeenCalledTimes(2);
    created.title = 'mutated outside';
    expect(goalState(created.id).goals[0]!.title).toBe('Control plane');
  });
});

describe('task lifecycle', () => {
  it('assigns a fixed provider, records completion, and derives goal completion', () => {
    const goal = createGoal({
      title: 'Provider run',
      objective: 'Prove one run',
      tasks: [{ title: 'Claude audit', acceptance: 'Return a report' }]
    });
    const task = goal.tasks[0]!;

    assignGoalTask(goal.id, task.id, { provider: 'claude-code', runId: 'p1' });
    expect(goalState(goal.id).goals[0]!.tasks[0]).toMatchObject({
      provider: 'claude-code',
      status: 'running',
      runId: 'p1'
    });

    completeGoalTask(goal.id, task.id, 'Audit complete');
    const finished = goalState(goal.id).goals[0]!;
    expect(finished.status).toBe('completed');
    expect(finished.tasks[0]).toMatchObject({ status: 'completed', result: 'Audit complete', error: null });
  });

  it('records an explicit provider failure and refuses to rewrite a terminal task', () => {
    const goal = createGoal({
      title: 'Provider failure',
      objective: 'Keep failure evidence',
      tasks: [{ title: 'Hermes audit', acceptance: 'Return a report' }]
    });
    const task = goal.tasks[0]!;
    assignGoalTask(goal.id, task.id, { provider: 'hermes', runId: 'p2' });
    failGoalTask(goal.id, task.id, 'Provider exited 2');

    expect(goalState(goal.id).goals[0]!.tasks[0]).toMatchObject({
      status: 'failed',
      provider: 'hermes',
      error: 'Provider exited 2'
    });
    expect(() => completeGoalTask(goal.id, task.id, 'pretend success')).toThrow(/terminal|failed/i);
  });
});

describe('durable recovery', () => {
  it('round-trips completed work and marks an in-flight process interrupted after restart', () => {
    const goal = createGoal({
      title: 'Restart recovery',
      objective: 'Never claim a vanished child is still running',
      tasks: [
        { title: 'Finished', acceptance: 'Persist result' },
        { title: 'In flight', acceptance: 'Fail honestly after restart' }
      ]
    });
    assignGoalTask(goal.id, goal.tasks[0]!.id, { provider: 'claude-code', runId: 'p1' });
    completeGoalTask(goal.id, goal.tasks[0]!.id, 'done');
    assignGoalTask(goal.id, goal.tasks[1]!.id, { provider: 'hermes', runId: 'p2' });
    const saved = snapshotGoals();

    resetGoalsForTests();
    restoreGoals(saved);

    const restored = goalState(goal.id).goals[0]!;
    expect(restored.tasks[0]).toMatchObject({ status: 'completed', result: 'done' });
    expect(restored.tasks[1]).toMatchObject({ status: 'failed', runId: null });
    expect(restored.tasks[1]!.error).toMatch(/restart|interrupted/i);
  });

  it('rejects corrupt or future snapshots without partially restoring them', () => {
    restoreGoals({ version: 99, goals: [] } as never);
    expect(goalState().goals).toEqual([]);

    restoreGoals({ version: 1, goals: [{ id: 'not-valid' }] } as never);
    expect(goalState().goals).toEqual([]);
  });
});
