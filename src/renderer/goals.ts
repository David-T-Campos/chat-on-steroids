/** Desktop Mission Control for durable goals and local external-agent tasks. */

import type { Goal, GoalsState, GoalTask } from '../shared/goals.js';
import type { AppState } from '../shared/types.js';
import { $, el, run, toast } from './dom.js';

const api = window.api;

interface GoalsDeps {
  state: () => AppState | null;
}

let deps: GoalsDeps;
let current: GoalsState = { goals: [] };

function setStatus(text: string, bad = false): void {
  const node = $('goalsState');
  node.textContent = text;
  node.classList.toggle('is-warn', bad);
}

function progress(goal: Goal): string {
  const counts = new Map<string, number>();
  for (const task of goal.tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  const order: GoalTask['status'][] = ['running', 'queued', 'completed', 'failed', 'cancelled'];
  return order
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => `${counts.get(status)} ${status}`)
    .join(' · ');
}

function taskRow(goal: Goal, task: GoalTask): HTMLElement {
  const row = el('article', `goal-task is-${task.status}`);
  row.dataset.goal = goal.id;
  row.dataset.task = task.id;

  const head = el('div', 'goal-task-head');
  head.append(el('b', '', task.title), el('span', `chip is-${task.status}`, task.status));
  if (task.provider) head.append(el('span', 'chip', task.provider === 'claude-code' ? 'Claude Code' : task.provider));
  row.append(head, el('p', 'hint', `Acceptance: ${task.acceptance}`));

  if (task.status === 'queued') {
    const controls = el('div', 'goal-task-controls');
    const provider = document.createElement('select');
    provider.dataset.provider = '';
    provider.setAttribute('aria-label', `Provider for ${task.title}`);
    for (const [value, label] of [
      ['claude-code', 'Claude Code'],
      ['hermes', 'Hermes Agent']
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      provider.append(option);
    }
    const root = document.createElement('select');
    root.dataset.root = '';
    root.setAttribute('aria-label', `Approved folder for ${task.title}`);
    for (const approved of deps.state()?.config.roots ?? []) {
      const option = document.createElement('option');
      option.value = approved.name;
      // Never paint the native path. The virtual root is the public security boundary.
      option.textContent = `/${approved.name}`;
      root.append(option);
    }
    const start = el('button', 'btn btn-solid', 'Run task') as HTMLButtonElement;
    start.type = 'button';
    start.dataset.start = '';
    const config = deps.state()?.config;
    start.disabled =
      root.options.length === 0 ||
      config?.multiAgent.enabled !== true ||
      config?.capabilities.command !== true ||
      config?.readOnly === true;
    controls.append(provider, root, start);
    row.append(controls);
  } else if (task.status === 'running') {
    const controls = el('div', 'goal-task-controls');
    controls.append(el('span', 'goal-run', task.runId ? `Run ${task.runId}` : 'Running'));
    const cancel = el('button', 'btn', 'Cancel') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.dataset.cancel = '';
    controls.append(cancel);
    row.append(controls);
  }

  if (task.result) row.append(el('p', 'goal-result', task.result));
  if (task.error) row.append(el('p', 'goal-result is-error', task.error));
  return row;
}

function goalCard(goal: Goal): HTMLElement {
  const card = el('section', `goal-card is-${goal.status}`);
  card.dataset.goal = goal.id;
  const head = el('div', 'goal-head');
  const title = el('div');
  title.append(el('h3', '', goal.title), el('p', 'goal-progress', progress(goal) || 'No tasks yet'));
  head.append(title, el('span', `chip is-${goal.status}`, goal.status));
  card.append(head, el('p', 'goal-objective', goal.objective));

  const tasks = el('div', 'goal-tasks');
  tasks.append(...goal.tasks.map((task) => taskRow(goal, task)));
  card.append(tasks);

  if (goal.status === 'active') {
    const form = el('form', 'goal-add-task');
    form.dataset.addTask = '';
    const titleInput = document.createElement('input');
    titleInput.name = 'title';
    titleInput.maxLength = 120;
    titleInput.required = true;
    titleInput.placeholder = 'New task';
    titleInput.setAttribute('aria-label', `New task for ${goal.title}`);
    const acceptance = document.createElement('input');
    acceptance.name = 'acceptance';
    acceptance.maxLength = 4000;
    acceptance.required = true;
    acceptance.placeholder = 'Acceptance criteria';
    acceptance.setAttribute('aria-label', `Acceptance criteria for ${goal.title}`);
    const add = el('button', 'btn', 'Add task') as HTMLButtonElement;
    add.type = 'submit';
    form.append(titleInput, acceptance, add);
    card.append(form);
  }
  return card;
}

function paintGoals(state: GoalsState): void {
  current = state;
  const list = $('goalsList');
  if (state.goals.length === 0) {
    list.replaceChildren(el('p', 'empty', 'No goals yet. Create one here, or ask ChatGPT to use agents action=goal_create.'));
    return;
  }
  list.replaceChildren(...state.goals.map(goalCard));
}

export async function refreshGoals(): Promise<void> {
  const state = await run(api.listGoals());
  if (state) paintGoals(state);
}

async function createFromForm(form: HTMLFormElement): Promise<void> {
  const title = $<HTMLInputElement>('goalTitle').value.trim();
  const objective = $<HTMLTextAreaElement>('goalObjective').value.trim();
  const taskTitle = $<HTMLInputElement>('goalTaskTitle').value.trim();
  const acceptance = $<HTMLTextAreaElement>('goalAcceptance').value.trim();
  if ((taskTitle && !acceptance) || (!taskTitle && acceptance)) {
    setStatus('First task and its acceptance criteria must be filled together.', true);
    return;
  }
  setStatus('Creating goal…');
  const created = await run(
    api.createGoal({
      title,
      objective,
      tasks: taskTitle ? [{ title: taskTitle, acceptance }] : []
    })
  );
  if (!created) {
    setStatus('Goal could not be created.', true);
    return;
  }
  form.reset();
  setStatus(`Created ${created.title}.`);
  toast('Goal created');
  await refreshGoals();
}

async function addTask(form: HTMLFormElement): Promise<void> {
  const goalId = form.closest<HTMLElement>('[data-goal]')?.dataset.goal;
  if (!goalId) return;
  const data = new FormData(form);
  const title = String(data.get('title') ?? '').trim();
  const acceptance = String(data.get('acceptance') ?? '').trim();
  const updated = await run(api.addGoalTasks(goalId, [{ title, acceptance }]));
  if (!updated) return;
  toast('Task added');
  await refreshGoals();
}

async function actOnTask(button: HTMLElement): Promise<void> {
  const row = button.closest<HTMLElement>('[data-task]');
  const goalId = row?.dataset.goal;
  const taskId = row?.dataset.task;
  if (!row || !goalId || !taskId) return;
  const control = button as HTMLButtonElement;
  control.disabled = true;
  try {
    if (button.hasAttribute('data-start')) {
      const provider = row.querySelector<HTMLSelectElement>('[data-provider]')?.value as 'claude-code' | 'hermes';
      const root = row.querySelector<HTMLSelectElement>('[data-root]')?.value ?? '';
      const started = await run(api.startGoalTask({ goalId, taskId, provider, root }));
      if (started) toast(`Task started with ${provider === 'claude-code' ? 'Claude Code' : 'Hermes Agent'}`);
    } else if (button.hasAttribute('data-cancel')) {
      const cancelled = await run(api.cancelGoalTask(goalId, taskId));
      if (cancelled) toast('Task cancelled');
    }
    await refreshGoals();
  } finally {
    control.disabled = false;
  }
}

export function initGoals(next: GoalsDeps): void {
  deps = next;
  $('goalCreateForm').addEventListener('submit', (event) => {
    event.preventDefault();
    void createFromForm(event.currentTarget as HTMLFormElement);
  });
  $('goalsList').addEventListener('submit', (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-add-task]');
    if (!form) return;
    event.preventDefault();
    void addTask(form);
  });
  $('goalsList').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-start], [data-cancel]');
    if (button) void actOnTask(button);
  });
  api.onGoalsChanged((state) => paintGoals(state));
}

