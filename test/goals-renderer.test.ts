import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

let dom: JSDOM | null = null;

afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

describe('desktop Mission Control renderer', () => {
  it('renders safe goal state and sends creation through the named API', async () => {
    const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
    dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
    const w = dom.window;
    Object.assign(globalThis, {
      window: w,
      document: w.document,
      HTMLElement: w.HTMLElement,
      HTMLInputElement: w.HTMLInputElement,
      HTMLTextAreaElement: w.HTMLTextAreaElement,
      HTMLSelectElement: w.HTMLSelectElement,
      HTMLButtonElement: w.HTMLButtonElement,
      Element: w.Element,
      Node: w.Node,
      DocumentFragment: w.DocumentFragment
    });

    const state = {
      goals: [
        {
          id: 'goal_11111111-1111-4111-8111-111111111111',
          title: 'Release mission',
          objective: 'Ship the provider control plane',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
          completedAt: null,
          tasks: [
            {
              id: 'task_22222222-2222-4222-8222-222222222222',
              title: 'Audit bridge',
              acceptance: 'Return exact findings',
              status: 'queued',
              provider: null,
              runId: null,
              result: null,
              error: null,
              createdAt: 1,
              updatedAt: 1,
              startedAt: null,
              finishedAt: null
            }
          ]
        }
      ]
    };
    const ok = (data: unknown) => Promise.resolve({ ok: true, data });
    const createGoal = vi.fn(async (input: unknown) => ({ ok: true, data: { ...state.goals[0], ...(input as object) } }));
    const startGoalTask = vi.fn(async () => ({ ok: true, data: { ...state.goals[0]!.tasks[0], status: 'running' } }));
    const api = {
      listGoals: () => ok(state),
      createGoal,
      addGoalTasks: vi.fn(async () => ({ ok: true, data: state.goals[0] })),
      startGoalTask,
      cancelGoalTask: vi.fn(async () => ({ ok: true, data: state.goals[0]!.tasks[0] })),
      onGoalsChanged: () => () => undefined
    };
    Object.defineProperty(w, 'api', { value: api, configurable: true });

    const { initGoals, refreshGoals } = await import('../src/renderer/goals.js');
    initGoals({
      state: () =>
        ({
          config: {
            roots: [{ name: 'repo', path: 'C:\\private\\repo' }],
            readOnly: false,
            capabilities: { command: true },
            multiAgent: { enabled: true }
          }
        }) as never
    });
    await refreshGoals();

    const list = w.document.getElementById('goalsList')!;
    expect(list.textContent).toContain('Release mission');
    expect(list.textContent).toContain('1 queued');
    expect(list.textContent).toContain('/repo');
    expect(list.textContent).not.toContain('C:\\private\\repo');

    (w.document.getElementById('goalTitle') as HTMLInputElement).value = 'New mission';
    (w.document.getElementById('goalObjective') as HTMLTextAreaElement).value = 'Coordinate it';
    (w.document.getElementById('goalTaskTitle') as HTMLInputElement).value = 'First task';
    (w.document.getElementById('goalAcceptance') as HTMLTextAreaElement).value = 'It is verified';
    w.document.getElementById('goalCreateForm')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createGoal).toHaveBeenCalledWith({
      title: 'New mission',
      objective: 'Coordinate it',
      tasks: [{ title: 'First task', acceptance: 'It is verified' }]
    });
  });
});
