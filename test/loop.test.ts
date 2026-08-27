import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOOP_PROMPT,
  DYNAMIC_FALLBACK_MS,
  LOOP_TTL_MS,
  ackLoopDraft,
  claimPendingLoopNow,
  clearLoopNow,
  loopStateFor,
  loopViewFor,
  moveLoopConversation,
  normalizeFixedInterval,
  openPendingLoopNow,
  parseLoopCommand,
  resetLoopsForTests,
  restoreLoops,
  scheduleDynamicWakeup,
  snapshotLoops,
  startLoopNow
} from '../src/main/loop.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let temp = '';

beforeEach(async () => {
  vi.useRealTimers();
  resetLoopsForTests();
  resetDurableForTests();
  temp = await mkdtemp(path.join(os.tmpdir(), 'clf-loop-'));
  initDurableStore(temp);
});

afterEach(async () => {
  resetLoopsForTests();
  resetDurableForTests();
  if (temp) await rm(temp, { recursive: true, force: true });
});

describe('/loop parser', () => {
  it('uses a leading compact duration before any trailing every phrase', () => {
    const parsed = parseLoopCommand('/loop 5m inspect deploy every 2 hours');
    expect(parsed.mode).toBe('fixed');
    expect(parsed.intervalSeconds).toBe(5 * 60);
    expect(parsed.prompt).toBe('inspect deploy every 2 hours');
  });

  it('recognises a trailing every clause when no leading interval exists', () => {
    const parsed = parseLoopCommand('/loop check CI every 2 hours');
    expect(parsed.mode).toBe('fixed');
    expect(parsed.intervalSeconds).toBe(2 * 60 * 60);
    expect(parsed.prompt).toBe('check CI');
  });

  it('rounds seconds up to one minute and awkward cron cadences to clean intervals', () => {
    expect(parseLoopCommand('/loop 30s ping').intervalSeconds).toBe(60);
    expect(parseLoopCommand('/loop 7m ping').intervalSeconds).toBe(6 * 60);
    expect(parseLoopCommand('/loop 90m ping').intervalSeconds).toBe(2 * 60 * 60);
    expect(normalizeFixedInterval(13 * 60)).toBe(12 * 60);
  });

  it('uses self-paced mode when the interval is omitted', () => {
    const parsed = parseLoopCommand('/loop watch the rollout and react');
    expect(parsed.mode).toBe('dynamic');
    expect(parsed.intervalSeconds).toBeNull();
    expect(parsed.prompt).toBe('watch the rollout and react');
  });

  it('gives bare loop the conservative maintenance task and accepts proactive as an alias', () => {
    const bare = parseLoopCommand('/loop');
    const alias = parseLoopCommand('/proactive');
    expect(bare.mode).toBe('dynamic');
    expect(bare.usedDefaultPrompt).toBe(true);
    expect(bare.prompt).toBe(DEFAULT_LOOP_PROMPT);
    expect(alias.prompt).toBe(DEFAULT_LOOP_PROMPT);
  });

  it.each(['/loop clear', '/loop stop', '/loop off', '/loop cancel'])('%s clears', (command) => {
    expect(parseLoopCommand(command).action).toBe('clear');
  });
});

describe('durable loop runtime', () => {
  it('runs fixed work immediately and offers only one due draft with no catch-up burst', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T10:00:00Z'));
    const started = await startLoopNow('chat-a', '/loop 5m check CI');
    expect(started.prompt).toContain('check CI');
    expect(started.view.runCount).toBe(1);
    expect(started.view.nextAt).toBe(Date.now() + 5 * 60_000);

    vi.setSystemTime(Date.now() + 50 * 60_000);
    const first = loopViewFor('chat-a', 'tab-1');
    expect(first.draft?.runCount).toBe(2);
    expect(first.nextAt).toBe(Date.now() + 5 * 60_000);
    expect(loopViewFor('chat-a', 'tab-2').draft).toBeNull();

    expect(await ackLoopDraft('chat-a', first.draft!.token, 'tab-1', true)).toBe(true);
    expect(loopViewFor('chat-a', 'tab-1').draft).toBeNull();
  });

  it('lets dynamic work replace the runtime fallback with one model-chosen wakeup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T10:00:00Z'));
    const started = await startLoopNow('chat-a', '/loop watch rollout');
    expect(started.view.mode).toBe('dynamic');
    expect(started.view.fallback).toBe(true);
    expect(started.view.nextAt).toBe(Date.now() + DYNAMIC_FALLBACK_MS);

    const scheduled = await scheduleDynamicWakeup('chat-a', 90, 'rollout usually updates within two minutes', false);
    expect(scheduled.fallback).toBe(false);
    expect(scheduled.nextAt).toBe(Date.now() + 90_000);

    vi.setSystemTime(Date.now() + 90_000);
    const due = loopViewFor('chat-a', 'tab-1');
    expect(due.draft?.mode).toBe('dynamic');
    expect(due.nextAt).toBeNull();
    await scheduleDynamicWakeup('chat-a', 600, 'next external update is expected later', true);
    expect(loopStateFor('chat-a').noOpStreak).toBe(1);
    await ackLoopDraft('chat-a', due.draft!.token, 'tab-1', true);
    expect(loopStateFor('chat-a').nextAt).toBe(Date.now() + 600_000);
  });

  it('gives one missing-reschedule fallback and then stops if that iteration also forgets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T10:00:00Z'));
    await startLoopNow('chat-a', '/loop inspect state');
    vi.setSystemTime(Date.now() + DYNAMIC_FALLBACK_MS);
    const fallback = loopViewFor('chat-a', 'tab-1');
    expect(fallback.draft).not.toBeNull();
    expect(fallback.nextAt).toBeNull();
    await ackLoopDraft('chat-a', fallback.draft!.token, 'tab-1', true);
    expect(loopStateFor('chat-a').active).toBe(false);
  });

  it('retries a due turn rather than spending it when the browser could not send', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T10:00:00Z'));
    await startLoopNow('chat-a', '/loop 1m tick');
    vi.setSystemTime(Date.now() + 60_000);
    const due = loopViewFor('chat-a', 'tab-1');
    await ackLoopDraft('chat-a', due.draft!.token, 'tab-1', false);
    expect(loopStateFor('chat-a').runCount).toBe(1);
    expect(loopStateFor('chat-a').nextAt).toBe(Date.now() + 30_000);
  });

  it('persists unexpired loops and drops expired ones on restore', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T10:00:00Z'));
    await startLoopNow('chat-a', '/loop 1h audit');
    const snapshot = snapshotLoops();
    resetLoopsForTests();
    restoreLoops(snapshot);
    expect(loopStateFor('chat-a').active).toBe(true);

    vi.setSystemTime(Date.now() + LOOP_TTL_MS + 1);
    expect(loopStateFor('chat-a').active).toBe(false);
  });

  it('binds a New Chat pending loop to the exact browser client', async () => {
    await openPendingLoopNow('tab-1', '/loop 10m inspect');
    expect(await claimPendingLoopNow('tab-2', 'chat-wrong')).toBe(false);
    expect(await claimPendingLoopNow('tab-1', 'chat-new')).toBe(true);
    expect(loopStateFor('chat-new').active).toBe(true);
    expect(loopStateFor('chat-new').mode).toBe('fixed');
  });

  it('moves an active loop with Compact & Resume and keeps a newer target loop authoritative', async () => {
    await startLoopNow('chat-a', '/loop 5m source');
    expect(moveLoopConversation('chat-a', 'chat-b')).toBe(true);
    expect(loopStateFor('chat-a').active).toBe(false);
    expect(loopStateFor('chat-b').prompt).toBe('source');

    await startLoopNow('chat-c', '/loop 10m old source');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await startLoopNow('chat-d', '/loop 10m newer target');
    expect(moveLoopConversation('chat-c', 'chat-d')).toBe(false);
    expect(loopStateFor('chat-d').prompt).toBe('newer target');
  });

  it('clear is durable and idempotent', async () => {
    await startLoopNow('chat-a', '/loop work');
    expect(await clearLoopNow('chat-a')).toBe(true);
    expect(await clearLoopNow('chat-a')).toBe(false);
    expect(loopStateFor('chat-a').active).toBe(false);
  });
});
