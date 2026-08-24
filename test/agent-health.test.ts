import { describe, expect, it, vi } from 'vitest';
import {
  healthCheckForAgentProvider,
  probeAgentProviders,
  probeAgentProvider,
  type VersionRunner
} from '../src/main/agent-health.js';

describe('external agent health probes', () => {
  it('uses only a fixed shell-free --version invocation for each provider', async () => {
    const run = vi.fn<VersionRunner>(async (command) => ({
      stdout: command === 'claude' ? '2.1.123 (Claude Code)\n' : 'Hermes v0.15.1\n',
      stderr: ''
    }));

    const health = await probeAgentProviders(run);

    expect(health.map((entry) => [entry.provider, entry.state, entry.version])).toEqual([
      ['claude-code', 'installed', '2.1.123 (Claude Code)'],
      ['hermes', 'installed', 'Hermes v0.15.1']
    ]);
    expect(run).toHaveBeenNthCalledWith(
      1,
      'claude',
      ['--version'],
      expect.objectContaining({ shell: false, windowsHide: true, timeout: 3000 })
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      'hermes',
      ['--version'],
      expect.objectContaining({ shell: false, windowsHide: true, timeout: 3000 })
    );
  });

  it('distinguishes a missing CLI from an unavailable installed command', async () => {
    const missing = vi.fn<VersionRunner>(async () => {
      throw Object.assign(new Error('spawn missing'), { code: 'ENOENT' });
    });
    const unavailable = vi.fn<VersionRunner>(async () => {
      throw Object.assign(new Error('C:\\private\\provider crashed with provider-secret'), { code: 1 });
    });

    await expect(probeAgentProvider('claude-code', missing)).resolves.toMatchObject({ state: 'missing' });
    const failed = await probeAgentProvider('hermes', unavailable);
    expect(failed).toMatchObject({ state: 'unavailable' });
    expect(JSON.stringify(failed)).not.toMatch(/private|secret/i);
  });

  it('bounds and sanitizes version text and reports a timed-out probe explicitly', async () => {
    const noisy = vi.fn<VersionRunner>(async () => ({
      stdout: `v1\u001b[31m ${'x'.repeat(500)}\nProject: C:\\private\\provider`,
      stderr: ''
    }));
    const timedOut = vi.fn<VersionRunner>(async () => {
      throw Object.assign(new Error('timed out'), { killed: true, code: 'ETIMEDOUT' });
    });

    const installed = await probeAgentProvider('claude-code', noisy);
    expect(installed.version?.length).toBeLessThanOrEqual(120);
    expect(installed.version).not.toMatch(/\u001b/);
    expect(installed.version).not.toMatch(/private|project/i);
    await expect(probeAgentProvider('hermes', timedOut)).resolves.toMatchObject({
      state: 'unavailable',
      detail: 'Version probe timed out.'
    });
  });

  it('maps optional missing providers to guidance and broken probes to failures', () => {
    expect(
      healthCheckForAgentProvider({
        provider: 'claude-code',
        label: 'Claude Code',
        state: 'missing',
        version: null,
        detail: 'Not installed.',
        setupUrl: 'https://code.claude.com/docs/en/setup'
      })
    ).toMatchObject({ name: 'Claude Code agent', status: 'not-run', ok: null });
    expect(
      healthCheckForAgentProvider({
        provider: 'hermes',
        label: 'Hermes Agent',
        state: 'unavailable',
        version: null,
        detail: 'Version probe failed.',
        setupUrl: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation/'
      })
    ).toMatchObject({ name: 'Hermes Agent', status: 'fail', ok: false });
  });
});
