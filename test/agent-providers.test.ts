import { describe, expect, it } from 'vitest';

const {
  MAX_AGENT_PROMPT_CHARS,
  buildAgentInvocation,
  parseAgentResult,
  providerDisplayName
} = await import('../src/main/agent-providers.js');

describe('external agent invocations', () => {
  it('builds a bounded, non-interactive Claude Code argv without a shell command string', () => {
    const prompt = 'Audit src/main/bridge.ts; do not edit. && echo should-not-run';
    const invocation = buildAgentInvocation({
      provider: 'claude-code',
      prompt,
      maxTurns: 7,
      maxBudgetUsd: 3.25
    });

    expect(invocation).toEqual({
      command: 'claude',
      args: [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--max-turns',
        '7',
        '--max-budget-usd',
        '3.25',
        '--no-session-persistence'
      ],
      displayName: 'Claude Code'
    });
    expect(invocation.args.filter((arg) => arg === prompt)).toHaveLength(1);
    expect(invocation.command).not.toMatch(/[;&|]/);
    expect(invocation.displayName).not.toContain(prompt);
  });

  it('builds a quiet, single-query Hermes invocation without enabling yolo mode', () => {
    const prompt = 'Review the goal ledger and report only.';
    const invocation = buildAgentInvocation({ provider: 'hermes', prompt });

    expect(invocation).toEqual({
      command: 'hermes',
      args: ['chat', '-q', prompt, '-Q', '--source', 'chat-on-steroids'],
      displayName: 'Hermes Agent'
    });
    expect(invocation.args).not.toContain('--yolo');
  });

  it('rejects unknown providers, empty prompts and out-of-range limits before launch', () => {
    expect(() => buildAgentInvocation({ provider: 'unknown' as never, prompt: 'work' })).toThrow(/provider/i);
    expect(() => buildAgentInvocation({ provider: 'hermes', prompt: ' ' })).toThrow(/prompt/i);
    expect(() => buildAgentInvocation({ provider: 'claude-code', prompt: 'work', maxTurns: 0 })).toThrow(/turn/i);
    expect(() => buildAgentInvocation({ provider: 'claude-code', prompt: 'work', maxBudgetUsd: 1_001 })).toThrow(
      /budget/i
    );
    expect(() => buildAgentInvocation({ provider: 'hermes', prompt: 'x'.repeat(MAX_AGENT_PROMPT_CHARS + 1) })).toThrow(
      /prompt/i
    );
  });

  it('does not accept Claude-only spending controls for Hermes', () => {
    expect(() => buildAgentInvocation({ provider: 'hermes', prompt: 'work', maxTurns: 3 })).toThrow(/Claude/i);
    expect(() => buildAgentInvocation({ provider: 'hermes', prompt: 'work', maxBudgetUsd: 2 })).toThrow(/Claude/i);
  });
});

describe('external agent results', () => {
  it('extracts only Claude Code result text from its JSON envelope', () => {
    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'The audit passed.',
      session_id: 'private-session-id',
      total_cost_usd: 0.12
    });

    expect(parseAgentResult('claude-code', { exitCode: 0, stdout: output, stderr: '', truncated: false })).toBe(
      'The audit passed.'
    );
  });

  it('returns bounded Hermes text and rejects malformed or failed provider output', () => {
    expect(
      parseAgentResult('hermes', { exitCode: 0, stdout: '\nHermes report\n', stderr: '', truncated: false })
    ).toBe('Hermes report');
    expect(() =>
      parseAgentResult('claude-code', { exitCode: 0, stdout: 'not json', stderr: '', truncated: false })
    ).toThrow(/JSON/i);
    expect(() =>
      parseAgentResult('hermes', {
        exitCode: 2,
        stdout: '',
        stderr: `provider failed ${'x'.repeat(5_000)}`,
        truncated: false
      })
    ).toThrow(/exited 2/i);
    try {
      parseAgentResult('hermes', {
        exitCode: 2,
        stdout: '',
        stderr: `provider failed ${'x'.repeat(5_000)}`,
        truncated: false
      });
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(2_200);
    }
    expect(() =>
      parseAgentResult('hermes', { exitCode: 0, stdout: 'partial', stderr: '', truncated: true })
    ).toThrow(/truncated/i);
  });

  it('keeps the public provider labels stable and secret-free', () => {
    expect(providerDisplayName('claude-code')).toBe('Claude Code');
    expect(providerDisplayName('hermes')).toBe('Hermes Agent');
  });
});
