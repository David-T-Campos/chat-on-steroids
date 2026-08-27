from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) < count:
        raise SystemExit(f"{path}: missing anchor {old[:140]!r}")
    p.write_text(text.replace(old, new, count))


# ---------------------------------------------------------------- fixed cron-like wall-clock cadence
anchor = '''function intervalLabel(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const value = seconds / 86_400;
    return `${value} day${value === 1 ? '' : 's'}`;
  }
  if (seconds % 3_600 === 0) {
    const value = seconds / 3_600;
    return `${value} hour${value === 1 ? '' : 's'}`;
  }
  const value = seconds / 60;
  return `${value} minute${value === 1 ? '' : 's'}`;
}
'''
addition = anchor + '''
/**
 * Fixed /loop is cron-shaped rather than an elapsed timer: minute cadences align to clean
 * minute marks, hour cadences to local wall-clock hours, and day cadences to local midnight.
 * This mirrors the observable CronCreate cadence without pretending to know Anthropic's
 * private deterministic-jitter hash. Dynamic one-shot wakeups deliberately do not use this.
 */
export function nextFixedFireAt(intervalSeconds: number, now = Date.now()): number {
  const seconds = Math.max(60, Math.floor(intervalSeconds));
  const base = new Date(now);
  if (seconds < 3_600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    base.setSeconds(0, 0);
    const nextMinute = Math.floor(base.getMinutes() / minutes) * minutes + minutes;
    base.setMinutes(nextMinute);
    return base.getTime();
  }
  if (seconds <= 86_400) {
    const hours = Math.max(1, Math.round(seconds / 3_600));
    base.setMinutes(0, 0, 0);
    const nextHour = Math.floor(base.getHours() / hours) * hours + hours;
    base.setHours(nextHour);
    return base.getTime();
  }
  const days = Math.max(1, Math.round(seconds / 86_400));
  base.setHours(0, 0, 0, 0);
  base.setDate(base.getDate() + 1);
  while ((base.getDate() - 1) % days !== 0) base.setDate(base.getDate() + 1);
  return base.getTime();
}
'''
replace('src/main/loop.ts', anchor, addition)
replace(
    'src/main/loop.ts',
    '  fallbackMisses: number;\n  generation: number;',
    '  fallbackMisses: number;\n  usesDefaultPrompt: boolean;\n  generation: number;',
)
replace(
    'src/main/loop.ts',
    "  fallbackMisses: 0,\n    generation: generation++",
    "  fallbackMisses: 0,\n    usesDefaultPrompt: parsed.usedDefaultPrompt,\n    generation: generation++",
)
replace(
    'src/main/loop.ts',
    "      reason: String(raw.reason || '').slice(0, MAX_REASON_CHARS),\n      generation:",
    "      reason: String(raw.reason || '').slice(0, MAX_REASON_CHARS),\n      usesDefaultPrompt: raw.usesDefaultPrompt === true,\n      generation:",
)
replace(
    'src/main/loop.ts',
    '''    nextAt:
      parsed.mode === 'fixed' && parsed.intervalSeconds
        ? now + parsed.intervalSeconds * 1000
        : now + DYNAMIC_FALLBACK_MS,''',
    '''    nextAt:
      parsed.mode === 'fixed' && parsed.intervalSeconds
        ? nextFixedFireAt(parsed.intervalSeconds, now)
        : now + DYNAMIC_FALLBACK_MS,''',
)
replace(
    'src/main/loop.ts',
    '    record.nextAt = now + seconds * 1000;',
    '    record.nextAt = nextFixedFireAt(seconds, now);',
)

# ---------------------------------------------------------------- loop.md project semantics + confirmation
old_sig = "function iterationPrompt(record: Pick<LoopRecord, 'mode' | 'prompt'>): string {"
new_sig = "function iterationPrompt(record: Pick<LoopRecord, 'mode' | 'prompt' | 'usesDefaultPrompt' | 'normalizedInterval' | 'expiresAt'>): string {"
replace('src/main/loop.ts', old_sig, new_sig)

old_body = '''  if (record.mode === 'fixed') {
    return [
      '[Chat On Steroids /loop — scheduled iteration]',
      '',
      'Execute the recurring task below now, using the current conversation and current machine state:',
      '',
      record.prompt,
      '',
      'The app already owns the fixed schedule. Do not create another timer or duplicate schedule. Complete this iteration normally.'
    ].join('\\n');
  }
  return [
      '[Chat On Steroids /loop — self-paced iteration]',
      '',
      'Execute the recurring task below now, using the current conversation and current machine state:',
      '',
      record.prompt,
      '',
      'At the end of this iteration, make an explicit pacing decision with the `loop` tool.',
'''
new_body = '''  const defaultResolution = record.usesDefaultPrompt
    ? [
        'This loop was started without an explicit prompt. At the beginning of EVERY iteration, first try to read `.claude/loop.md` from the current learned project workspace.',
        'If that project file exists, treat its current Markdown contents (up to 25,000 bytes) as the loop task for this iteration. Re-read it next iteration so edits or deletion take effect.',
        'If the project file is absent, unreadable, or there is not yet a learned project workspace, use the built-in maintenance task below instead.',
        'The app intentionally does not auto-read `~/.claude/loop.md` outside approved roots; do not route around that filesystem boundary.',
        '',
        'Built-in maintenance fallback:',
        record.prompt
      ].join('\\n')
    : record.prompt;
  if (record.mode === 'fixed') {
    return [
      '[Chat On Steroids /loop — scheduled iteration]',
      '',
      `This recurring loop is already scheduled on a fixed ${record.normalizedInterval ?? 'cadence'} and expires automatically after seven days. Briefly acknowledge that schedule in your response.`,
      'Execute the recurring task below now, using the current conversation and current machine state:',
      '',
      defaultResolution,
      '',
      'The app already owns the fixed schedule. Do not create another timer or duplicate schedule. Complete this iteration normally.'
    ].join('\\n');
  }
  return [
      '[Chat On Steroids /loop — self-paced iteration]',
      '',
      'This loop is self-paced and expires automatically after seven days. Briefly acknowledge that you are self-pacing and that you ran this iteration now.',
      'Execute the recurring task below now, using the current conversation and current machine state:',
      '',
      defaultResolution,
      '',
      'At the end of this iteration, make an explicit pacing decision with the `loop` tool.',
'''
replace('src/main/loop.ts', old_body, new_body)

replace(
    'src/main/loop.ts',
    "    prompt: iterationPrompt({ mode: parsed.mode, prompt: parsed.prompt }),",
    "    prompt: iterationPrompt({\n      mode: parsed.mode,\n      prompt: parsed.prompt,\n      usesDefaultPrompt: parsed.usedDefaultPrompt,\n      normalizedInterval: parsed.normalizedInterval,\n      expiresAt: now + LOOP_TTL_MS\n    }),",
)

# ---------------------------------------------------------------- tests for wall-clock cadence and loop.md task refresh instruction
replace(
    'test/loop.test.ts',
    '  moveLoopConversation,\n  normalizeFixedInterval,',
    '  moveLoopConversation,\n  nextFixedFireAt,\n  normalizeFixedInterval,',
)
insert_after = '''  it('rounds seconds up to one minute and awkward cron cadences to clean intervals', () => {
    expect(parseLoopCommand('/loop 30s ping').intervalSeconds).toBe(60);
    expect(parseLoopCommand('/loop 7m ping').intervalSeconds).toBe(6 * 60);
    expect(parseLoopCommand('/loop 90m ping').intervalSeconds).toBe(2 * 60 * 60);
    expect(normalizeFixedInterval(13 * 60)).toBe(12 * 60);
  });
'''
extra = insert_after + '''
  it('aligns fixed runs to cron-shaped local wall-clock boundaries', () => {
    const now = new Date(2026, 7, 27, 10, 3, 17, 0).getTime();
    expect(new Date(nextFixedFireAt(5 * 60, now)).getMinutes()).toBe(5);
    const twoHours = new Date(nextFixedFireAt(2 * 60 * 60, now));
    expect(twoHours.getHours()).toBe(12);
    expect(twoHours.getMinutes()).toBe(0);
  });
'''
replace('test/loop.test.ts', insert_after, extra)

anchor_test = '''  it('gives bare loop the conservative maintenance task and accepts proactive as an alias', () => {
    const bare = parseLoopCommand('/loop');
    const alias = parseLoopCommand('/proactive');
    expect(bare.mode).toBe('dynamic');
    expect(bare.usedDefaultPrompt).toBe(true);
    expect(bare.prompt).toBe(DEFAULT_LOOP_PROMPT);
    expect(alias.prompt).toBe(DEFAULT_LOOP_PROMPT);
  });
'''
extra_test = anchor_test + '''
  it('asks default loops to re-read the project loop.md on each iteration but ignores it for explicit tasks', async () => {
    const bare = await startLoopNow('chat-default', '/loop');
    const explicit = await startLoopNow('chat-explicit', '/loop check CI');
    expect(bare.prompt).toContain('.claude/loop.md');
    expect(bare.prompt).toContain('25,000 bytes');
    expect(explicit.prompt).not.toContain('.claude/loop.md');
  });
'''
replace('test/loop.test.ts', anchor_test, extra_test)

# ---------------------------------------------------------------- browser notice + Escape cancellation
loop_content_anchor = '''  let loopSlashBusy = false;

  async function runLoopSlash(input) {'''
loop_content_replacement = '''  let loopSlashBusy = false;
  let loopNoticeTimer = 0;

  function showLoopNotice(message) {
    const text = String(message || '').trim();
    if (!text) return;
    let node = document.getElementById('clf-loop-notice');
    if (!node) {
      node = document.createElement('div');
      node.id = 'clf-loop-notice';
      node.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:420px;padding:9px 12px;border-radius:10px;background:rgba(30,30,30,.92);color:#fff;font:12px/1.35 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.25);pointer-events:none';
      document.documentElement.appendChild(node);
    }
    node.textContent = text;
    if (loopNoticeTimer) clearTimeout(loopNoticeTimer);
    loopNoticeTimer = setTimeout(() => {
      const current = document.getElementById('clf-loop-notice');
      if (current) current.remove();
      loopNoticeTimer = 0;
    }, 4000);
  }

  function adoptLoopReply(data) {
    if (!data || typeof data !== 'object') return;
    if (data.view && typeof data.view === 'object') {
      loopConfig = data.view;
      loopDraft = data.view.draft || null;
    }
    showLoopNotice(data.message || '');
  }

  async function runLoopSlash(input) {'''
replace('extension/content.js', loop_content_anchor, loop_content_replacement)
replace(
    'extension/content.js',
    '''      if (!reply || reply.ok !== true || !reply.data) return;
      const prompt = typeof reply.data.prompt === 'string' ? reply.data.prompt : null;
      if (prompt === null) {
        // Status/clear is handled locally and should not consume a ChatGPT turn.
        CLF_DOM.replacePrompt('');
        return;
      }
''',
    '''      if (!reply || reply.ok !== true || !reply.data) return;
      adoptLoopReply(reply.data);
      const prompt = typeof reply.data.prompt === 'string' ? reply.data.prompt : null;
      if (prompt === null) {
        // Status/clear is handled locally and should not consume a ChatGPT turn.
        CLF_DOM.replacePrompt('');
        return;
      }
''',
)

wire_anchor = '''  function wireLoopSlash() {
    listen(document, 'keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const box = CLF_DOM.composer();
      if (!box) return;
      const target = event.target;
      if (target !== box && !(box.contains && target && box.contains(target))) return;
      const input = (box.textContent || '').trim();
      if (!/^\\/(?:loop|proactive)(?:\\s|$)/i.test(input)) return;
      event.preventDefault();
      event.stopPropagation();
      void runLoopSlash(input);
    }, true);
  }
'''
wire_replacement = wire_anchor + '''
  function wireLoopEscape() {
    // Claude Code's Esc-while-waiting behavior maps to an idle browser page. Do not steal
    // Escape while a turn is running or while the user has a draft; the key keeps its normal
    // ChatGPT/browser meaning and cancellation happens as an additional local side effect.
    listen(document, 'keydown', (event) => {
      if (event.key !== 'Escape' || event.isComposing || !conversationId || !loopConfig || !loopConfig.active) return;
      if (generating || CLF_DOM.generating() || nativeBusy || compactCapture || (job && job.busy)) return;
      const box = CLF_DOM.composer();
      if (box && (box.textContent || '').trim() !== '') return;
      void ask({ type: 'loop_start', conversationId, input: '/loop clear' })
        .then((reply) => {
          if (reply && reply.ok === true && reply.data) adoptLoopReply(reply.data);
        })
        .catch(() => undefined);
    }, true);
  }
'''
replace('extension/content.js', wire_anchor, wire_replacement)
replace(
    'extension/content.js',
    '  wireMenu();\n  wireLoopSlash();',
    '  wireMenu();\n  wireLoopSlash();\n  wireLoopEscape();',
)

# ---------------------------------------------------------------- research note: exact current behavior vs product-bound adaptations
p = Path('docs/claude-loop-research.md')
text = p.read_text()
if '### `loop.md` refresh and Esc cancellation' not in text:
    marker = '## Deliberate Chat On Steroids adaptations\n'
    section = '''### `loop.md` refresh and Esc cancellation\n\nCurrent Claude Code re-reads `.claude/loop.md` (then `~/.claude/loop.md`) on each default-loop iteration, caps it at 25,000 bytes, and falls back to the built-in maintenance task when it is absent. Pressing `Esc` while a loop is waiting cancels that loop's pending wakeup.\n\nChat On Steroids mirrors project-level refresh by making a default iteration read `.claude/loop.md` from the conversation's learned approved workspace every time before using the built-in fallback. It deliberately does not auto-read `~/.claude/loop.md` outside approved roots: that would silently bypass this product's filesystem security boundary. `Esc` while the browser chat is idle and its composer is empty clears the active conversation loop.\n\n### Current cloud-first offer\n\nBinary-derived current `/loop` skill text contains an additional cloud-first decision: for parsed intervals of at least one hour, or daily phrasing, eligible Claude Code sessions offer a cloud schedule before creating the local session cron. Chat On Steroids has no Anthropic Routines/cloud scheduler backend, so it does not fake that branch; all loops in this PR are explicitly local conversation loops.\n\n### Fixed-time jitter\n\nClaude's generic recurring scheduler applies a deterministic task-ID-derived offset (bounded by 30 minutes, or half the interval for sub-hour tasks). The public docs specify the bounds but not Anthropic's exact task-ID hash/offset derivation. Chat On Steroids aligns fixed fires to the same cron-shaped local wall-clock boundaries but does not invent an unverified jitter algorithm.\n\n'''
    if marker not in text:
        raise SystemExit('research note adaptation anchor missing')
    text = text.replace(marker, section + marker, 1)
p.write_text(text)
