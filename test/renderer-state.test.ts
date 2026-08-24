import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

it('does not overwrite a focused dirty settings field on an unsolicited state push', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  let stateListener: (state: any) => void = () => undefined;
  const baseConfig = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: true,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: false, edit: false, move: false, deleteFile: false, command: false,
      screen: false, control: false, clipboardRead: false, clipboardWrite: false
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2 },
    goal: { enabled: false, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' as const }
  };
  const state = {
    config: baseConfig,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, lastSeenAt: null }
  };
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const api: any = new Proxy({
    getState: () => ok(state),
    getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onStateChanged: (fn: any) => { stateListener = fn; return () => undefined; },
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const field = w.document.getElementById('tunnelId') as HTMLInputElement;
  expect(field.value).toBe(baseConfig.tunnel.tunnelId);
  field.focus();
  field.value = 'tunnel_USER_IS_STILL_TYPING';

  stateListener(structuredClone(state));

  expect(w.document.activeElement).toBe(field);
  expect(field.value).toBe('tunnel_USER_IS_STILL_TYPING');

  const multiAgent = w.document.getElementById('homeMaEnabled') as HTMLInputElement;
  multiAgent.focus();
  multiAgent.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(multiAgent);
  expect(multiAgent.checked).toBe(true);

  // The settings sheet used to bypass the dirty-field guard used by Home. An unrelated
  // status push therefore erased this value while the user was still typing it.
  const compactionThreshold = w.document.getElementById('autoCompactTokens') as HTMLInputElement;
  compactionThreshold.focus();
  compactionThreshold.value = '355000';
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(compactionThreshold);
  expect(compactionThreshold.value).toBe('355000');

  compactionThreshold.blur();
  const updatedThreshold = structuredClone(state) as any;
  updatedThreshold.config.compaction.autoTokens = 320000;
  stateListener(updatedThreshold);
  expect(compactionThreshold.value).toBe('320000');

  // The health card reports the live surface projection rather than a hand-maintained
  // denominator. Tool consolidation/additions should never leave the UI saying "of 9"
  // when nine is no longer the product's actual maximum.
  const withTools = structuredClone(state) as any;
  withTools.status.surfaces = [
    {
      id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
      available: true, localUrl: null, publicUrl: null, tools: ['read', 'apply_patch'],
      state: 'off', detail: '', lastRequestAt: null, lastToolCallAt: null
    },
    {
      id: 'desktop', connectorName: 'Desktop', description: '', cardSummary: '', optional: true,
      available: true, localUrl: null, publicUrl: null, tools: ['observe'],
      state: 'off', detail: '', lastRequestAt: null, lastToolCallAt: null
    }
  ];
  stateListener(withTools);
  expect(w.document.getElementById('facts')!.textContent).toContain('3 available');
  expect(w.document.getElementById('facts')!.textContent).not.toContain('of 9');
});

it('serializes full settings snapshots so a second UI change cannot undo the first save', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const baseConfig = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as const },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2 },
    goal: { enabled: false, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' as const }
  };
  const appState = (config: typeof baseConfig) => ({
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, lastSeenAt: null }
  });
  let current = appState(baseConfig);
  const calls: any[] = [];
  const pending: Array<(reply: any) => void> = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const saveSettings = (patch: any) => {
    calls.push(structuredClone(patch));
    return new Promise<any>((resolve) => pending.push(resolve));
  };
  const api: any = new Proxy({
    getState: () => ok(current),
    getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    saveSettings,
    onStateChanged: () => () => undefined,
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  // First save toggles a value that has no form control of its own. Keep the IPC unresolved,
  // matching a real save that is waiting for bridge/tunnel lifecycle work in the main process.
  (w.document.getElementById('readOnlyBtn') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].readOnly).toBe(true);

  // While that save is in flight, change an unrelated checkbox. The old implementation sent
  // this immediately with readOnly=false from stale renderer state, so main-process serialization
  // made the stale snapshot win *after* the user's first click.
  const auto = w.document.getElementById('autoConnect') as HTMLInputElement;
  auto.checked = true;
  auto.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toHaveLength(1);

  current = appState({ ...baseConfig, readOnly: true });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1].readOnly).toBe(true);
  expect(calls[1].ui.autoConnect).toBe(true);

  current = appState({ ...baseConfig, readOnly: true, ui: { ...baseConfig.ui, autoConnect: true } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/**
 * The goal loop's settings panel.
 *
 * Three things are worth pinning here and the rest is layout: the key never travels with the
 * settings, the catalogue is only fetched when somebody asks for it, and an install with no
 * key says so in the words the extension says it in.
 */

interface GoalMount {
  window: JSDOM['window'];
  calls: any[];
  keys: Array<{ method: string; value: string }>;
  modelPages: any[];
  push(state: any): void;
  state: any;
}

async function mountChat(overrides: Record<string, unknown> = {}, models: any[] = []): Promise<GoalMount> {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const config = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as const },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2 },
    goal: { enabled: false, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' as const }
  };
  const state: any = {
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, lastSeenAt: null },
    ...overrides
  };
  let listener: (next: any) => void = () => undefined;
  const calls: any[] = [];
  const keys: Array<{ method: string; value: string }> = [];
  const modelPages: any[] = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getLog: () => ok([]),
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onStateChanged: (fn: any) => {
        listener = fn;
        return () => undefined;
      },
      onLogEntry: () => () => undefined,
      onSwarmChanged: () => () => undefined,
      onSessionChanged: () => () => undefined,
      listSessions: () => ok({ sessions: [], activeId: null, pressure: [] }),
      // Answers with the config it just stored, the way the real handler does. The panel
      // paints from the app's answer rather than from what it just clicked, so a fake that
      // replied with the old config would be testing a revert.
      saveSettings: (patch: any) => {
        calls.push(structuredClone(patch));
        state.config = { ...state.config, ...structuredClone(patch) };
        return ok(state);
      },
      setGoalKey: (value: string) => {
        keys.push({ method: 'setGoalKey', value });
        return ok({ ...state, hasGoalKey: value !== '' });
      },
      setApiKey: (value: string) => {
        keys.push({ method: 'setApiKey', value });
        return ok(state);
      },
      listGoalModels: (offset: number) => {
        const page = { models: models.slice(offset, offset + 20), total: models.length, offset };
        modelPages.push(page);
        return ok(page);
      }
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return (..._args: any[]) => ok(null);
      }
    }
  );
  Object.defineProperty(w, 'api', { value: api, configurable: true });
  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { window: w, calls, keys, modelPages, state, push: (next) => listener(next) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Fake OpenRouter catalogue, already in the order the app is expected to keep. */
const catalogue = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `vendor${index}/model-${index}`,
    name: `Model ${index}`,
    created: 1_800_000_000 - index * 86_400,
    contextLength: 128_000
  }));

/**
 * The exact sentence, because it is the same sentence the composer's settings sheet shows
 * and the two are meant to be recognisably one message rather than two paraphrases.
 */
it('says an OpenRouter key is needed before the goal loop can do anything', async () => {
  const mounted = await mountChat();
  const hint = mounted.window.document.getElementById('goalHint')!;
  expect(hint.textContent).toBe('OpenRouter API key essential for goal feature.');
  expect(hint.classList.contains('is-warn')).toBe(true);

  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();
  expect(mounted.window.document.getElementById('goalHint')!.classList.contains('is-warn')).toBe(false);
});

/**
 * The key goes to the one channel that encrypts it and never to the settings file. This is
 * the whole reason the goal request is made by the app and not by the extension, so it is
 * worth an assertion rather than a comment.
 */
it('sends the key to the secret store and never into the settings patch', async () => {
  const mounted = await mountChat();
  const field = mounted.window.document.getElementById('goalKey') as HTMLInputElement;
  field.value = 'sk-or-v1-not-a-real-key';
  field.dispatchEvent(new mounted.window.Event('blur'));
  await settle();

  expect(mounted.keys).toEqual([{ method: 'setGoalKey', value: 'sk-or-v1-not-a-real-key' }]);
  // Cleared from the input as well: a stored key has no reason to stay on screen.
  expect(field.value).toBe('');
  expect(JSON.stringify(mounted.calls)).not.toContain('sk-or-v1');
});

/**
 * The catalogue is a network request to somebody else's service, so it happens when a person
 * asks for it and not when the settings tab is opened.
 */
it('loads the model catalogue only when the picker is opened, twenty at a time', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  expect(mounted.modelPages).toEqual([]);

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
  // Newest first, which is the whole point of the ordering.
  expect((doc.querySelector('.goal-model .goal-model-name') as HTMLElement).textContent).toBe('Model 0');
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('45');

  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  // Nothing left to page, so the control stops offering.
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);
});

/**
 * "Load 20 more" is the deliberate way to ask for the next page. Scrolling to the bottom of
 * the list is the way people actually ask, and it did nothing at all: the list simply ended
 * at twenty with four hundred still to come and no sign that there was a button below it.
 *
 * The repaint is the other half. The list is rebuilt whole on every page, and emptying an
 * element scrolls it back to the top — so even once it paged, the reader was thrown back to
 * the newest model, which is the one they had just scrolled away from.
 */
it('pages the catalogue in as the list is scrolled, without losing the reader\'s place', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // jsdom does no layout, so the box has to be described: a 260px window onto a list whose
  // height follows the number of rows actually in it, the way the real one does.
  const list = doc.getElementById('goalModelList')!;
  Object.defineProperty(list, 'clientHeight', { value: 260, configurable: true });
  Object.defineProperty(list, 'scrollHeight', {
    get: () => list.querySelectorAll('.goal-model').length * 50,
    configurable: true
  });
  Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true });
  const scroll = (top: number): void => {
    (list as unknown as { scrollTop: number }).scrollTop = top;
    list.dispatchEvent(new mounted.window.Event('scroll'));
  };

  // Halfway down twenty rows: nothing is asked for.
  scroll(300);
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // At the end of them: the next twenty arrive without the button being touched.
  scroll(740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  // And the list is still where it was left, not back at the newest model.
  expect(list.scrollTop).toBe(740);

  // Forty rows is 2000px now, so arriving at the end again pages in the last five.
  scroll(1740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);

  // Nothing left to page: scrolling on does not ask OpenRouter again.
  const spent = mounted.modelPages.length;
  scroll(2200);
  await settle();
  expect(mounted.modelPages).toHaveLength(spent);
});

/**
 * A closed picker measures zero in every direction, which reads as "scrolled to the end".
 * Left unguarded, every repaint of the settings sheet would page the whole catalogue in
 * behind a panel nobody has open — hundreds of models, on somebody else's service.
 */
it('never pages the catalogue while the picker is closed', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);

  // Close it again, then push a fresh state through: applyGoal repaints the list.
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  expect(doc.getElementById('goalModels')!.hidden).toBe(true);
  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();

  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
});

/** Choosing one stores it verbatim: the id is what OpenRouter wants, not a display name. */
it('saves the chosen model id', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(3));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  (doc.querySelectorAll('.goal-model')[1] as HTMLButtonElement).click();
  await settle();

  expect(doc.getElementById('goalModelName')!.textContent).toBe('vendor1/model-1');
  expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: 'vendor1/model-1' });
});

/** A provider that cannot be reached says so and changes nothing about what is in use. */
it('keeps the model in use when OpenRouter cannot be reached', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(2));
  const doc = mounted.window.document;
  (mounted.window as any).api.listGoalModels = () => Promise.resolve({ ok: false, error: 'offline' });

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('unchanged');
  expect(doc.getElementById('goalModelName')!.textContent).toBe('deepseek/deepseek-v4-flash');
});
