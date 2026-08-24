/** Fixed, credential-blind health probes for optional local agent providers. */

import { execFile } from 'node:child_process';
import type { Check } from '../shared/types.js';
import type { ExternalAgentProvider } from './agent-providers.js';

const VERSION_TIMEOUT_MS = 3_000;
const VERSION_BUFFER_BYTES = 16 * 1024;
const MAX_VERSION_CHARS = 120;

export interface VersionRunOptions {
  shell: false;
  windowsHide: true;
  timeout: number;
  maxBuffer: number;
  encoding: 'utf8';
}

export type VersionRunner = (
  command: string,
  args: readonly string[],
  options: VersionRunOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface AgentProviderHealth {
  provider: ExternalAgentProvider;
  label: string;
  state: 'installed' | 'missing' | 'unavailable';
  version: string | null;
  /** Fixed diagnostic text only. Raw process errors and paths never cross this boundary. */
  detail: string;
  setupUrl: string;
}

const PROVIDERS: ReadonlyArray<{
  provider: ExternalAgentProvider;
  label: string;
  command: string;
  setupUrl: string;
}> = [
  {
    provider: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    setupUrl: 'https://code.claude.com/docs/en/setup'
  },
  {
    provider: 'hermes',
    label: 'Hermes Agent',
    command: 'hermes',
    setupUrl: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation/'
  }
];

const VERSION_OPTIONS: VersionRunOptions = {
  shell: false,
  windowsHide: true,
  timeout: VERSION_TIMEOUT_MS,
  maxBuffer: VERSION_BUFFER_BYTES,
  encoding: 'utf8'
};

const defaultVersionRunner: VersionRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });

function definition(provider: ExternalAgentProvider): (typeof PROVIDERS)[number] {
  const found = PROVIDERS.find((candidate) => candidate.provider === provider);
  if (!found) throw new Error(`Unsupported external agent provider: ${provider}`);
  return found;
}

function cleanVersion(value: string): string {
  const firstLine = value.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  return firstLine
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_VERSION_CHARS);
}

export async function probeAgentProvider(
  provider: ExternalAgentProvider,
  run: VersionRunner = defaultVersionRunner
): Promise<AgentProviderHealth> {
  const item = definition(provider);
  try {
    const output = await run(item.command, ['--version'], VERSION_OPTIONS);
    const version = cleanVersion(output.stdout) || cleanVersion(output.stderr);
    if (!version) {
      return {
        provider,
        label: item.label,
        state: 'unavailable',
        version: null,
        detail: 'Version probe returned no readable version.',
        setupUrl: item.setupUrl
      };
    }
    return {
      provider,
      label: item.label,
      state: 'installed',
      version,
      detail: 'Installed. Provider sign-in remains external and is checked only when a task is run.',
      setupUrl: item.setupUrl
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    if (failure.code === 'ENOENT') {
      return {
        provider,
        label: item.label,
        state: 'missing',
        version: null,
        detail: 'Not found on PATH.',
        setupUrl: item.setupUrl
      };
    }
    const timedOut = failure.killed === true || failure.code === 'ETIMEDOUT';
    return {
      provider,
      label: item.label,
      state: 'unavailable',
      version: null,
      detail: timedOut ? 'Version probe timed out.' : 'Version probe failed.',
      setupUrl: item.setupUrl
    };
  }
}

export function probeAgentProviders(run: VersionRunner = defaultVersionRunner): Promise<AgentProviderHealth[]> {
  return Promise.all(PROVIDERS.map((provider) => probeAgentProvider(provider.provider, run)));
}

export function healthCheckForAgentProvider(health: AgentProviderHealth): Check {
  const name = health.label.endsWith('Agent') ? health.label : `${health.label} agent`;
  if (health.state === 'installed') {
    return {
      name,
      status: 'pass',
      ok: true,
      detail: `${health.version}. ${health.detail}`
    };
  }
  if (health.state === 'missing') {
    return {
      name,
      status: 'not-run',
      ok: null,
      detail: `${health.detail} Setup: ${health.setupUrl}`
    };
  }
  return {
    name,
    status: 'fail',
    ok: false,
    detail: `${health.detail} Setup: ${health.setupUrl}`
  };
}
