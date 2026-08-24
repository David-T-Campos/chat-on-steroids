const $ = (id) => document.getElementById(id);
const POLL_MS = 2500;
let painting = false;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function providerLabel(value) {
  if (value === 'claude-code') return 'Claude Code';
  if (value === 'hermes') return 'Hermes';
  if (value === 'chatgpt') return 'ChatGPT';
  return '';
}

function relativeTime(at) {
  if (!at) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function paintConnection(ready, text) {
  $('connection').className = ready ? 'connection is-ready' : 'connection';
  $('connection').querySelector('span').textContent = text;
}

function taskRow(task) {
  const row = node('article', `task is-${task.status}`);
  const top = node('div', 'task-top');
  top.append(node('strong', '', task.title), node('span', `badge is-${task.status}`, task.status));
  row.append(top);
  const meta = node('p', 'task-meta');
  const agent = providerLabel(task.provider);
  meta.textContent = [agent, relativeTime(task.updatedAt)].filter(Boolean).join(' · ');
  row.append(meta);
  return row;
}

function goalCard(goal) {
  const card = node('section', `goal is-${goal.status}`);
  const head = node('div', 'goal-head');
  const title = node('div');
  title.append(node('h3', '', goal.title), node('p', 'goal-time', relativeTime(goal.updatedAt)));
  head.append(title, node('span', `badge is-${goal.status}`, goal.status));
  card.append(head);

  const counts = node('p', 'goal-counts');
  counts.textContent = [
    goal.counts.running ? `${goal.counts.running} running` : '',
    goal.counts.queued ? `${goal.counts.queued} queued` : '',
    goal.counts.completed ? `${goal.counts.completed} done` : '',
    goal.counts.failed ? `${goal.counts.failed} failed` : ''
  ].filter(Boolean).join(' · ') || 'No tasks';
  card.append(counts);

  const tasks = node('div', 'tasks');
  for (const task of goal.tasks) tasks.append(taskRow(task));
  if (goal.tasks.length === 0) tasks.append(node('p', 'empty', 'No visible tasks.'));
  card.append(tasks);
  return card;
}

function paint(summary) {
  const totals = summary.totals || {};
  $('activeCount').textContent = String(totals.active || 0);
  $('runningCount').textContent = String(totals.running || 0);
  $('queuedCount').textContent = String(totals.queued || 0);
  $('doneCount').textContent = String(totals.completed || 0);
  const goals = Array.isArray(summary.goals) ? summary.goals : [];
  if (goals.length === 0) {
    $('goalList').replaceChildren(node('p', 'empty-state', 'No goals yet. Create one in the desktop app or from a ChatGPT conversation.'));
  } else {
    $('goalList').replaceChildren(...goals.map(goalCard));
  }
  $('goalState').textContent = summary.truncated
    ? `Showing a bounded view of ${totals.goals || goals.length} goals.`
    : `${totals.goals || goals.length} goal${(totals.goals || goals.length) === 1 ? '' : 's'} · updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

async function refresh() {
  if (painting) return;
  painting = true;
  try {
    const summary = await chrome.runtime.sendMessage({ type: 'goalSummary' });
    if (!summary || summary.ok !== true) {
      paintConnection(false, 'Offline');
      $('goalState').textContent = summary && summary.error === 'disconnected'
        ? 'The extension is disconnected from the desktop app.'
        : 'The desktop app is not available.';
      return;
    }
    paintConnection(true, 'Live');
    paint(summary);
  } catch {
    paintConnection(false, 'Offline');
    $('goalState').textContent = 'The desktop app is not available.';
  } finally {
    painting = false;
  }
}

$('refreshGoals').addEventListener('click', () => void refresh());
$('browserSync').addEventListener('click', async () => {
  const button = $('browserSync');
  button.disabled = true;
  $('syncState').textContent = 'Syncing browser activity…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'syncNow' });
    $('syncState').textContent = result && result.ok === true
      ? `Synced ${result.tabs || 0} ChatGPT tab${result.tabs === 1 ? '' : 's'}`
      : 'Browser sync did not complete';
  } catch {
    $('syncState').textContent = 'Browser sync did not complete';
  } finally {
    button.disabled = false;
  }
  await refresh();
});

void refresh();
setInterval(() => void refresh(), POLL_MS);
