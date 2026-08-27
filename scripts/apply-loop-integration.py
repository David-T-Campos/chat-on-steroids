from pathlib import Path


def patch(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    found = text.count(old)
    if found < count:
        raise SystemExit(f"{path}: expected at least {count} occurrence(s), found {found}: {old[:140]!r}")
    p.write_text(text.replace(old, new, count))


def replace_all(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"{path}: anchor not found: {old[:140]!r}")
    p.write_text(text.replace(old, new))


# ---------------------------------------------------------------- MCP surface
patch(
    "src/main/mcp/tools-core.ts",
    "import { registerSessionTool as registerSessionSearchReadTool } from './session-tool.js';",
    "import { registerSessionTool as registerSessionSearchReadTool } from './session-tool.js';\nimport { registerLoopTool } from './loop-tool.js';",
)
patch(
    "src/main/mcp/tools-core.ts",
    "  // ---------------------------------------------------------------- session\n\n  if (reg.sessionToolsExposed) registerSessionSearchReadTool(reg);",
    "  // ------------------------------------------------------------------- loop\n\n  registerLoopTool(reg);\n\n  // ---------------------------------------------------------------- session\n\n  if (reg.sessionToolsExposed) registerSessionSearchReadTool(reg);",
)
patch(
    "src/main/mcp/surfaces.ts",
    "Core declares 8 possible tool names below, but at most 7 schemas are live at once. `find`",
    "Core declares 9 possible tool names below, but at most 8 schemas are live at once. `find`",
)
patch(
    "src/main/mcp/surfaces.ts",
    "off — so no runtime tools/list reaches all 8 declarations.",
    "off — so no runtime tools/list reaches all 9 declarations. `loop` is the one small scheduler control used only by active self-paced /loop turns.",
)
patch(
    "src/main/mcp/surfaces.ts",
    "tools: ['read', 'view_image', 'find', 'apply_patch', 'exec_command', 'write_stdin', 'session', 'agents']",
    "tools: ['read', 'view_image', 'find', 'apply_patch', 'exec_command', 'write_stdin', 'loop', 'session', 'agents']",
)

# ---------------------------------------------------------------- startup restore
patch(
    "src/main/index.ts",
    "import { GOAL_OBJECTIVES_STATE, restoreGoalObjectives, type GoalObjectivesSnapshot } from './goal.js';",
    "import { GOAL_OBJECTIVES_STATE, restoreGoalObjectives, type GoalObjectivesSnapshot } from './goal.js';\nimport { LOOPS_STATE, restoreLoops, type LoopsSnapshot } from './loop.js';",
)
patch(
    "src/main/index.ts",
    "  restoreGoalObjectives(savedGoalObjectives);\n  // Request ownership must exist before either side of the bridge can race in.",
    "  restoreGoalObjectives(savedGoalObjectives);\n  const savedLoops = await readDurable<LoopsSnapshot>(LOOPS_STATE);\n  if (windowActivation.isDisabled()) return;\n  restoreLoops(savedLoops);\n  // Request ownership must exist before either side of the bridge can race in.",
)

# ---------------------------------------------------------------- Compact & Resume
patch(
    "src/main/session/continuation.ts",
    "import { clearGoalObjective, goalObjectiveFor, moveGoalObjective } from '../goal.js';",
    "import { clearGoalObjective, goalObjectiveFor, moveGoalObjective } from '../goal.js';\nimport { moveLoopConversation } from '../loop.js';",
)
replace_all(
    "src/main/session/continuation.ts",
    "  moveGoalObjective(entry.from, toConversationId);",
    "  moveGoalObjective(entry.from, toConversationId);\n  moveLoopConversation(entry.from, toConversationId);",
)
replace_all(
    "src/main/session/continuation.ts",
    "        moveGoalObjective(entry.from, entry.to);",
    "        moveGoalObjective(entry.from, entry.to);\n        moveLoopConversation(entry.from, entry.to);",
)
# Historical resume-shadow repair also moves missing per-chat projections.
replace_all(
    "src/main/session/continuation.ts",
    "    goalChanged = moveGoalObjective(fromConversationId, conversationId);",
    "    goalChanged = moveGoalObjective(fromConversationId, conversationId);\n    moveLoopConversation(fromConversationId, conversationId);",
)

# ---------------------------------------------------------------- bridge
patch(
    "src/main/bridge.ts",
    "} from './goal.js';\nimport { logInfo, logWarn } from './logger.js';",
    "} from './goal.js';\nimport {\n  ackLoopDraft,\n  claimPendingLoopNow,\n  loopStateFor,\n  loopViewFor,\n  openPendingLoopNow,\n  startLoopNow\n} from './loop.js';\nimport { logInfo, logWarn } from './logger.js';",
)
patch(
    "src/main/bridge.ts",
    "    const goalClient = (url.searchParams.get('goalClient') ?? '').slice(0, 100);",
    "    const goalClient = (url.searchParams.get('goalClient') ?? '').slice(0, 100);\n    const loopClient = (url.searchParams.get('loopClient') ?? '').slice(0, 100);",
)
patch(
    "src/main/bridge.ts",
    "          draft: goalViewFor(id, goalClient)\n        },\n        // Local calls still executing",
    "          draft: goalViewFor(id, goalClient)\n        },\n        // Scheduled recurring work is conversation-scoped. Reading /activity may claim one\n        // due draft for this exact browser client; a second tab never receives the same turn.\n        loop: workerBlocked ? { ...loopStateFor(id), active: false, draft: null } : loopViewFor(id, loopClient),\n        // Local calls still executing",
)

LOOP_ROUTES = r'''
  /**
   * `/loop` control plane. Fixed cadence and self-paced state are committed before the
   * browser crosses the send boundary, so the model cannot forget to create the schedule.
   * New Chat has no conversation id yet, so it is fenced by the exact browser client until
   * the page binds the id ChatGPT creates after the first send.
   */
  if (route === '/loop/start' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    const input = typeof body['input'] === 'string' ? body['input'] : '';
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    if (goalWorkerChat(id)) {
      return json(
        res,
        409,
        { error: 'worker_loop_disabled', message: 'Recurring user turns belong to the prime chat, not a worker chat.' },
        origin
      );
    }
    try {
      const result = await startLoopNow(id, input);
      return json(res, 200, result, origin);
    } catch (err) {
      logWarn(`bridge: could not durably update /loop for ${id} — ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 503, { error: 'loop_not_durable', retryable: true }, origin);
    }
  }

  if (route === '/loop/open' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const clientId = typeof body['clientId'] === 'string' ? body['clientId'].slice(0, 100) : '';
    const input = typeof body['input'] === 'string' ? body['input'] : '';
    if (!clientId) return json(res, 400, { error: 'bad_client_id' }, origin);
    try {
      const result = await openPendingLoopNow(clientId, input);
      return json(res, 200, result, origin);
    } catch (err) {
      logWarn(`bridge: could not durably prepare New Chat /loop — ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 503, { error: 'loop_not_durable', retryable: true }, origin);
    }
  }

  if (route === '/loop/claim' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    const clientId = typeof body['clientId'] === 'string' ? body['clientId'].slice(0, 100) : '';
    if (!id || !clientId) return json(res, 400, { error: 'bad_loop_claim' }, origin);
    try {
      const claimed = await claimPendingLoopNow(clientId, id);
      return json(res, 200, { claimed, loop: loopStateFor(id) }, origin);
    } catch (err) {
      logWarn(`bridge: could not durably bind New Chat /loop for ${id} — ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 503, { error: 'loop_not_durable', retryable: true }, origin);
    }
  }

  if (route === '/loop/ack' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    const draftToken = typeof body['token'] === 'string' ? body['token'] : '';
    const clientId = typeof body['clientId'] === 'string' ? body['clientId'].slice(0, 100) : '';
    const sent = body['sent'] === true;
    if (!id || !draftToken || !clientId) return json(res, 400, { error: 'bad_loop_ack' }, origin);
    try {
      const acknowledged = await ackLoopDraft(id, draftToken, clientId, sent);
      return json(res, 200, { acknowledged }, origin);
    } catch (err) {
      logWarn(`bridge: could not durably acknowledge /loop draft for ${id} — ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 503, { error: 'loop_not_durable', retryable: true }, origin);
    }
  }

'''
patch(
    "src/main/bridge.ts",
    "  /**\n   * The goal loop, from the page's side.",
    LOOP_ROUTES + "  /**\n   * The goal loop, from the page's side.",
)

# ---------------------------------------------------------------- extension worker
patch(
    "extension/background.js",
    "      `&goalClient=${encodeURIComponent(String(source.tab))}`;",
    "      `&goalClient=${encodeURIComponent(String(source.tab))}` +\n      `&loopClient=${encodeURIComponent(String(source.tab))}`;",
)
LOOP_HANDLERS = r'''
  async loop_start(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, status: 400, error: 'bad_conversation_id' };
    await noteTabConversation(source, conversationId);
    const result = await call('/loop/start', {
      method: 'POST',
      body: JSON.stringify({ conversationId, input: String(message.input || ''), clientId: String(source.tab) })
    });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  async loop_open(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const result = await call('/loop/open', {
      method: 'POST',
      body: JSON.stringify({ input: String(message.input || ''), clientId: String(source.tab) })
    });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  async loop_claim(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, status: 400, error: 'bad_conversation_id' };
    await noteTabConversation(source, conversationId);
    const result = await call('/loop/claim', {
      method: 'POST',
      body: JSON.stringify({ conversationId, clientId: String(source.tab) })
    });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  async loop_ack(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, status: 400, error: 'bad_conversation_id' };
    const result = await call('/loop/ack', {
      method: 'POST',
      body: JSON.stringify({
        conversationId,
        token: String(message.token || ''),
        sent: message.sent === true,
        clientId: String(source.tab)
      })
    });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
'''
patch(
    "extension/background.js",
    "  async goal_draft(message, _sender, source) {",
    LOOP_HANDLERS + "  async goal_draft(message, _sender, source) {",
)
patch(
    "extension/background.js",
    "    'goal_draft',",
    "    'loop_start',\n    'loop_open',\n    'loop_claim',\n    'loop_ack',\n    'goal_draft',",
)

# ---------------------------------------------------------------- DOM helper
patch(
    "extension/chatgpt-dom.js",
    "  /** Sends the current composer text, after verifying ChatGPT accepted it. */",
    r'''  /** Replaces the current composer draft through the native editing path. */
  function replacePrompt(value) {
    return safe(() => {
      const box = composer();
      if (!box) return false;
      box.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, String(value || ''));
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value || '') }));
      return (box.textContent || '').trim() === String(value || '').trim();
    }, false);
  }

  /** Sends the current composer text, after verifying ChatGPT accepted it. */''',
)
patch(
    "extension/chatgpt-dom.js",
    "    insertPrompt,\n    send",
    "    insertPrompt,\n    replacePrompt,\n    send",
)

# ---------------------------------------------------------------- content script
patch(
    "extension/content.js",
    "  let goalConfig = null;\n  let goalDraft = null;",
    "  let goalConfig = null;\n  let goalDraft = null;\n  let loopConfig = null;\n  let loopDraft = null;\n  let loopBusy = false;",
)
patch(
    "extension/content.js",
    "    const reply = await ask({ type: 'bind', conversationId: id });\n    if (reply && reply.ok === true) boundId = id;",
    "    const reply = await ask({ type: 'bind', conversationId: id });\n    if (reply && reply.ok === true) {\n      boundId = id;\n      // A /loop started from New Chat was fenced by this exact tab until ChatGPT minted id.\n      void ask({ type: 'loop_claim', conversationId: id }).catch(() => undefined);\n    }",
)
patch(
    "extension/content.js",
    "      goalConfig = data.goal && typeof data.goal === 'object' ? data.goal : null;\n      if (goalConfig) goalDraft = goalConfig.draft || null;",
    "      goalConfig = data.goal && typeof data.goal === 'object' ? data.goal : null;\n      if (goalConfig) goalDraft = goalConfig.draft || null;\n      loopConfig = data.loop && typeof data.loop === 'object' ? data.loop : null;\n      loopDraft = loopConfig && loopConfig.draft ? loopConfig.draft : null;",
)

LOOP_CONTENT = r'''  /** Sends one app-owned due loop turn, and only while the user's composer is free. */
  async function maybeSendLoopReply() {
    const draft = loopDraft;
    if (!draft || !conversationId || draft.conversationId !== conversationId || loopBusy) return;
    if (goalWasSpent(conversationId, draft.token)) {
      loopDraft = null;
      await ask({ type: 'loop_ack', conversationId, token: draft.token, sent: true }).catch(() => undefined);
      return;
    }
    if (generating || CLF_DOM.generating() || compactCapture || nativeBusy || goalBusy || (job && job.busy)) return;
    const box = CLF_DOM.composer();
    if (!box || (box.textContent || '').trim() !== '') return;
    loopBusy = true;
    try {
      if (!CLF_DOM.insertPrompt(String(draft.prompt || ''))) return;
      await sleep(120);
      const sent = await CLF_DOM.send();
      loopDraft = null;
      if (sent) rememberGoalSpent(conversationId, draft.token);
      await ask({ type: 'loop_ack', conversationId, token: draft.token, sent }).catch(() => undefined);
    } finally {
      loopBusy = false;
    }
  }

  let loopSlashBusy = false;

  async function runLoopSlash(input) {
    if (loopSlashBusy) return;
    loopSlashBusy = true;
    const beforeId = CLF_DOM.conversationId();
    try {
      const reply = await ask(
        beforeId
          ? { type: 'loop_start', conversationId: beforeId, input }
          : { type: 'loop_open', input }
      );
      if (!reply || reply.ok !== true || !reply.data) return;
      const prompt = typeof reply.data.prompt === 'string' ? reply.data.prompt : null;
      if (prompt === null) {
        // Status/clear is handled locally and should not consume a ChatGPT turn.
        CLF_DOM.replacePrompt('');
        return;
      }
      if (!CLF_DOM.replacePrompt(prompt)) return;
      await sleep(120);
      const sent = await CLF_DOM.send();
      if (!sent) {
        // Schedule creation happened before the irreversible browser send. Roll it back if
        // ChatGPT refused that matching first iteration.
        if (beforeId) {
          await ask({ type: 'loop_start', conversationId: beforeId, input: '/loop clear' }).catch(() => undefined);
        } else {
          await ask({ type: 'loop_open', input: '/loop clear' }).catch(() => undefined);
        }
      }
    } finally {
      loopSlashBusy = false;
    }
  }

  function wireLoopSlash() {
    listen(document, 'keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const box = CLF_DOM.composer();
      if (!box) return;
      const target = event.target;
      if (target !== box && !(box.contains && target && box.contains(target))) return;
      const input = (box.textContent || '').trim();
      if (!/^\/(?:loop|proactive)(?:\s|$)/i.test(input)) return;
      event.preventDefault();
      event.stopPropagation();
      void runLoopSlash(input);
    }, true);
  }

'''
patch(
    "extension/content.js",
    "    if (current() && CLF_DOM.conversationId() === forId) await maybeSendGoalReply();\n  }\n\n  // ------------------------------------------------------- composer control",
    "    if (current() && CLF_DOM.conversationId() === forId) await maybeSendGoalReply();\n    if (current() && CLF_DOM.conversationId() === forId) await maybeSendLoopReply();\n  }\n\n" + LOOP_CONTENT + "  // ------------------------------------------------------- composer control",
)
patch(
    "extension/content.js",
    "  wireTips();\n  wireMenu();",
    "  wireTips();\n  wireMenu();\n  wireLoopSlash();",
)

# ---------------------------------------------------------------- tests and docs
replace_all(
    "test/mcp.test.ts",
    "['read', 'view_image', 'apply_patch', 'exec_command', 'write_stdin', 'session', 'agents']",
    "['read', 'view_image', 'apply_patch', 'exec_command', 'write_stdin', 'loop', 'session', 'agents']",
)
replace_all(
    "test/feature-parity.test.ts",
    "      'write_stdin',\n      'session',",
    "      'write_stdin',\n      'loop',\n      'session',",
)
p = Path("test/mcp.test.ts")
text = p.read_text().replace("toBeLessThanOrEqual(7)", "toBeLessThanOrEqual(8)")
p.write_text(text)
patch(
    "test/loop.test.ts",
    "import { beforeEach, describe, expect, it, vi } from 'vitest';",
    "import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';",
)

p = Path("docs/tool-surface.md")
text = p.read_text()
text = text.replace(
    "`read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `session`, `agents`",
    "`read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `loop`, `session`, `agents`",
)
text = text.replace("advertises seven schemas", "advertises eight schemas")
text = text.replace(
    "`read`, `view_image`, `apply_patch`, `exec_command`, `write_stdin`, `session`, and `agents`",
    "`read`, `view_image`, `apply_patch`, `exec_command`, `write_stdin`, `loop`, `session`, and `agents`",
)
if "### `loop`" not in text:
    marker = "### `session`"
    section = """### `loop`\n\nA small scheduler-control schema used only by an active self-paced `/loop`. `schedule_wakeup` chooses the next one-shot delay (60–3600 seconds), reason and no-op signal; `stop` ends the loop. The handler resolves the exact ChatGPT conversation from request-id evidence and refuses calls outside an active dynamic loop. Fixed loops never use it because the app owns their cadence.\n\n"""
    if marker not in text:
        raise SystemExit("docs/tool-surface.md: session section anchor missing")
    text = text.replace(marker, section + marker, 1)
p.write_text(text)
