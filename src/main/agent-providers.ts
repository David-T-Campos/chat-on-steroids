/** Fixed, shell-free adapters for locally installed external agent CLIs. */

import { z } from 'zod';

export const EXTERNAL_AGENT_PROVIDERS = ['claude-code', 'hermes'] as const;
export type ExternalAgentProvider = (typeof EXTERNAL_AGENT_PROVIDERS)[number];
export const MAX_AGENT_PROMPT_CHARS = 16_000;
export const MAX_AGENT_RESULT_CHARS = 16_000;
const MAX_PROVIDER_ERROR_CHARS = 2_000;

const providerSchema = z.enum(EXTERNAL_AGENT_PROVIDERS);
const launchSchema = z
  .object({
    provider: providerSchema,
    prompt: z.string().trim().min(1).max(MAX_AGENT_PROMPT_CHARS),
    maxTurns: z.number().int().min(1).max(100).optional(),
    maxBudgetUsd: z.number().finite().min(0.01).max(1_000).optional()
  })
  .strict();

const claudeResultSchema = z
  .object({
    type: z.literal('result'),
    is_error: z.boolean().optional(),
    result: z.string().max(MAX_AGENT_RESULT_CHARS)
  })
  .passthrough();

export interface AgentLaunchRequest {
  provider: ExternalAgentProvider;
  prompt: string;
  /** Claude Code print-mode agentic turn ceiling. */
  maxTurns?: number;
  /** Claude Code print-mode spend ceiling in US dollars. */
  maxBudgetUsd?: number;
}

export interface AgentInvocation {
  command: string;
  args: string[];
  /** Safe for logs and UI. Contains neither prompt nor command-line arguments. */
  displayName: string;
}

export interface AgentProcessOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export function providerDisplayName(provider: ExternalAgentProvider): string {
  switch (providerSchema.parse(provider)) {
    case 'claude-code':
      return 'Claude Code';
    case 'hermes':
      return 'Hermes Agent';
  }
}

export function buildAgentInvocation(request: AgentLaunchRequest): AgentInvocation {
  const input = launchSchema.parse(request);
  if (input.provider === 'hermes' && (input.maxTurns !== undefined || input.maxBudgetUsd !== undefined)) {
    throw new Error('maxTurns and maxBudgetUsd are Claude Code controls and cannot be used with Hermes Agent.');
  }

  if (input.provider === 'claude-code') {
    const args = ['-p', input.prompt, '--output-format', 'json'];
    if (input.maxTurns !== undefined) args.push('--max-turns', String(input.maxTurns));
    if (input.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(input.maxBudgetUsd));
    // Task prompts and their outputs belong to this app's bounded ledger. Avoid also leaving
    // a second, provider-owned transcript behind unless a future explicit resume feature
    // needs it.
    args.push('--no-session-persistence');
    return { command: 'claude', args, displayName: providerDisplayName(input.provider) };
  }

  // Deliberately no --yolo. Hermes keeps its own dangerous-command approval policy.
  return {
    command: 'hermes',
    args: ['chat', '-q', input.prompt, '-Q', '--source', 'chat-on-steroids'],
    displayName: providerDisplayName(input.provider)
  };
}

function cleanVisibleText(text: string): string {
  return text.replace(/\0/g, '').replace(/\r\n/g, '\n').trim();
}

function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  const suffix = '\n…[truncated by Chat On Steroids]';
  return `${text.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

function providerFailure(provider: ExternalAgentProvider, output: AgentProcessOutput): Error {
  const details = cleanVisibleText(output.stderr) || cleanVisibleText(output.stdout) || 'no diagnostic output';
  const code = output.exitCode === null ? 'without an exit code' : String(output.exitCode);
  return new Error(`${providerDisplayName(provider)} exited ${code}: ${bounded(details, MAX_PROVIDER_ERROR_CHARS)}`);
}

/** Convert provider-specific envelopes into the only value persisted as a task result. */
export function parseAgentResult(provider: ExternalAgentProvider, output: AgentProcessOutput): string {
  const checkedProvider = providerSchema.parse(provider);
  if (output.exitCode !== 0) throw providerFailure(checkedProvider, output);
  if (output.truncated) {
    throw new Error(`${providerDisplayName(checkedProvider)} output was truncated, so task completion cannot be proven.`);
  }

  if (checkedProvider === 'hermes') {
    const result = cleanVisibleText(output.stdout);
    if (!result) throw new Error('Hermes Agent exited successfully but returned no result.');
    return bounded(result, MAX_AGENT_RESULT_CHARS);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(output.stdout);
  } catch {
    throw new Error('Claude Code returned malformed JSON, so task completion cannot be proven.');
  }
  const parsed = claudeResultSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error('Claude Code returned an invalid JSON result envelope, so task completion cannot be proven.');
  }
  const result = cleanVisibleText(parsed.data.result);
  if (parsed.data.is_error === true) {
    throw new Error(`Claude Code reported an error: ${bounded(result || 'no diagnostic output', MAX_PROVIDER_ERROR_CHARS)}`);
  }
  if (!result) throw new Error('Claude Code exited successfully but returned an empty result.');
  return result;
}
