from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) < count:
        raise SystemExit(f"{path}: missing anchor {old[:120]!r}")
    p.write_text(text.replace(old, new, count))


# Clean cron-cadence ties round upward: 90m -> 2h rather than 1h.
replace(
    'src/main/loop.ts',
    'Math.abs(value - target) < Math.abs(best - target) ? value : best',
    'Math.abs(value - target) <= Math.abs(best - target) ? value : best',
)

# A fallback turn must get to finish before the runtime decides it forgot to pace.
replace(
    'src/main/loop.ts',
    '// decision. If the fallback iteration itself later forgets too, ackLoopDraft stops it.',
    '// decision. If the fallback iteration itself later forgets too, settleDynamicLoop stops it after the browser reports that turn finished.',
)
old = '''  if (record.mode === 'dynamic' && record.nextAt === null) {
    if (record.fallbackMisses >= 1) {
      // This was already the one runtime fallback and it still produced no pacing decision.
      loops.delete(conversationId);
      await changedNow();
      return true;
    }
    record.nextAt = Date.now() + DYNAMIC_FALLBACK_MS;
    record.reason = 'runtime fallback because the previous iteration did not schedule its next wakeup';
    record.fallbackArmed = true;
  }
'''
new = '''  if (record.mode === 'dynamic' && record.nextAt === null) {
    if (record.fallbackMisses >= 1) {
      // This is the one recovery iteration. Do not end it at the user-message ACK: the
      // assistant has not run yet and must still be allowed to call the loop pacing tool.
      // finishGeneration reports the completed turn through /loop/settle instead.
      changed();
      return true;
    }
    record.nextAt = Date.now() + DYNAMIC_FALLBACK_MS;
    record.reason = 'runtime fallback because the previous iteration did not schedule its next wakeup';
    record.fallbackArmed = true;
  }
'''
replace('src/main/loop.ts', old, new)

anchor = '''export async function stopDynamicLoop(conversationId: string): Promise<boolean> {
  const record = loopForConversation(conversationId);
  if (!record) return false;
  if (record.mode !== 'dynamic') throw new Error('LOOP_NOT_DYNAMIC');
  return clearLoopNow(conversationId);
}
'''
addition = anchor + '''
/**
 * Called after a browser turn genuinely settles. It only has work to do for the single
 * recovery iteration that was fired because the preceding dynamic iteration forgot to
 * schedule or stop. A pacing tool call during that recovery resets fallbackMisses/nextAt,
 * so this becomes a no-op when the model did make a valid decision.
 */
export async function settleDynamicLoop(conversationId: string): Promise<boolean> {
  const record = loopForConversation(conversationId);
  if (!record || record.mode !== 'dynamic' || record.fallbackMisses < 1 || record.nextAt !== null) return false;
  loops.delete(conversationId);
  drafts.delete(conversationId);
  await changedNow();
  return true;
}
'''
replace('src/main/loop.ts', anchor, addition)

# Keep the pacing schema semantically Core-only: no Desktop marker substrings.
replace('src/main/mcp/loop-tool.ts', 'after observing this iteration', 'after reviewing this iteration')
replace('src/main/mcp/loop-tool.ts', 'this iteration observed no meaningful change', 'this iteration found no meaningful change')

# Live read-only / empty-Core transitions fail closed even after a cached schema exists.
replace(
    'src/main/mcp/loop-tool.ts',
    "      guard('loop', async () => {\n        const conversationId = await exactConversation();",
    "      guard('loop', async () => {\n        const anyCoreLive =\n          reg.caps.browse ||\n          reg.caps.search ||\n          reg.caps.read ||\n          reg.caps.metadata ||\n          reg.caps.create ||\n          reg.caps.edit ||\n          reg.caps.move ||\n          reg.caps.deleteFile ||\n          reg.caps.command ||\n          reg.sessionToolsLive ||\n          reg.agentToolsLive;\n        if (reg.ctx.readOnly || !anyCoreLive) {\n          return fail('LOOP_DISABLED: loop pacing is unavailable while Core is read-only or has no live capability.');\n        }\n        const conversationId = await exactConversation();",
)

# Do not advertise a state-changing scheduler in a fresh read-only or empty Core endpoint.
replace(
    'src/main/mcp/tools-core.ts',
    '''  // ------------------------------------------------------------------- loop

  registerLoopTool(reg);

  // ---------------------------------------------------------------- session
''',
    '''  // ------------------------------------------------------------------- loop

  const loopSurfaceExposed =
    !ctx.readOnly &&
    (exposedCaps.browse ||
      exposedCaps.search ||
      exposedCaps.read ||
      exposedCaps.metadata ||
      exposedCaps.create ||
      exposedCaps.edit ||
      exposedCaps.move ||
      exposedCaps.deleteFile ||
      exposedCaps.command ||
      reg.sessionToolsExposed ||
      reg.agentToolsExposed);
  if (loopSurfaceExposed) registerLoopTool(reg);

  // ---------------------------------------------------------------- session
''',
)

# Browser reports a genuinely settled dynamic recovery turn. This is intentionally
# idempotent and no-ops for fixed, normal dynamic, and already-rescheduled turns.
replace(
    'src/main/bridge.ts',
    '  loopStateFor,\n  loopViewFor,\n  openPendingLoopNow,',
    '  loopStateFor,\n  loopViewFor,\n  openPendingLoopNow,\n  settleDynamicLoop,',
)
route_anchor = "  if (route === '/loop/ack' && req.method === 'POST') {"
settle_route = '''  if (route === '/loop/settle' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    try {
      const stopped = await settleDynamicLoop(id);
      return json(res, 200, { stopped }, origin);
    } catch (err) {
      logWarn(`bridge: could not durably settle /loop turn for ${id} — ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 503, { error: 'loop_not_durable', retryable: true }, origin);
    }
  }

'''
replace('src/main/bridge.ts', route_anchor, settle_route + route_anchor)

handlers_anchor = '  async loop_ack(message, _sender, source) {'
settle_handler = '''  async loop_settle(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, status: 400, error: 'bad_conversation_id' };
    const result = await call('/loop/settle', {
      method: 'POST',
      body: JSON.stringify({ conversationId, clientId: String(source.tab) })
    });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
'''
replace('extension/background.js', handlers_anchor, settle_handler + handlers_anchor)
replace('extension/background.js', "    'loop_ack',", "    'loop_ack',\n    'loop_settle',")

turn_end = "    if (endedTurnId) emit({ kind: 'turn_end', turnId: endedTurnId, ...result });"
turn_end_new = turn_end + '''
    // Dynamic /loop's one recovery iteration is allowed to run to completion before the
    // runtime decides it failed to pace itself. The endpoint is idempotent and ignores every
    // ordinary turn, so reload/adoption can report the same settlement safely.
    if (endedTurnId && conversationId && loopConfig && loopConfig.active && loopConfig.mode === 'dynamic') {
      void ask({ type: 'loop_settle', conversationId }).catch(() => undefined);
    }'''
replace('extension/content.js', turn_end, turn_end_new)

# Update regression test to prove fallback stays alive at send ACK and stops only on settle.
replace(
    'test/loop.test.ts',
    '  scheduleDynamicWakeup,\n  snapshotLoops,',
    '  scheduleDynamicWakeup,\n  settleDynamicLoop,\n  snapshotLoops,',
)
replace(
    'test/loop.test.ts',
    '''    await ackLoopDraft('chat-a', fallback.draft!.token, 'tab-1', true);
    expect(loopStateFor('chat-a').active).toBe(false);
''',
    '''    await ackLoopDraft('chat-a', fallback.draft!.token, 'tab-1', true);
    expect(loopStateFor('chat-a').active).toBe(true);
    expect(await settleDynamicLoop('chat-a')).toBe(true);
    expect(loopStateFor('chat-a').active).toBe(false);
''',
)

# Document read-only behavior on the public surface.
p = Path('docs/tool-surface.md')
text = p.read_text()
text = text.replace(
    'Fixed loops never use it because the app owns their cadence.',
    'Fixed loops never use it because the app owns their cadence. A fresh read-only or otherwise empty Core endpoint does not advertise this state-changing scheduler control.',
)
p.write_text(text)
