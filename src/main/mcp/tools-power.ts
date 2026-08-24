/**
 * Bounded host operations that are useful beside, but not worth duplicating as, shell
 * recipes. They share one schema so a conversation pays one discovery cost for the whole
 * host-control vocabulary. Command permission is the authority: exec_command can already
 * do everything here, while this tool makes common inspection deterministic and structured.
 */

import os from 'node:os';
import { z } from 'zod';
import { runPowerShell, terminateProcessTree } from '../exec.js';
import { logInfo } from '../logger.js';
import { noteCount, noteDetail, noteExec } from './call-context.js';
import { fail, type SurfaceRegistrar, type ToolResult } from './kernel.js';

const MAX_PROCESSES = 100;
const PROCESS_QUERY_CHARS = 80;
const PROCESS_TIMEOUT_MS = 10_000;

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('system_info') }).strict(),
  z
    .object({
      type: z.literal('process_list'),
      query: z
        .string()
        .max(PROCESS_QUERY_CHARS)
        .optional()
        .describe('Optional case-insensitive process-name filter.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PROCESSES)
        .optional()
        .describe(`Maximum rows. Default 25; limit ${MAX_PROCESSES}.`)
    })
    .strict(),
  z
    .object({
      type: z.literal('process_kill'),
      pid: z.number().int().min(5).describe('Process id to terminate, including its child-process tree.'),
      force: z.boolean().optional().describe('Force termination. Defaults to true.')
    })
    .strict()
]);

const systemInfoOutputSchema = z
  .object({
    action: z.literal('system_info'),
    platform: z.string(),
    architecture: z.string(),
    release: z.string(),
    cpu_count: z.number().int().nonnegative(),
    total_memory_bytes: z.number().nonnegative(),
    free_memory_bytes: z.number().nonnegative(),
    uptime_seconds: z.number().nonnegative(),
    node_version: z.string()
  })
  .strict();

const processSchema = z
  .object({
    pid: z.number().int().nonnegative(),
    name: z.string(),
    cpu_seconds: z.number().nonnegative(),
    memory_bytes: z.number().nonnegative()
  })
  .strict();

const processListOutputSchema = z
  .object({
    action: z.literal('process_list'),
    processes: z.array(processSchema).max(MAX_PROCESSES),
    returned: z.number().int().nonnegative(),
    truncated: z.boolean()
  })
  .strict();

const processKillOutputSchema = z
  .object({ action: z.literal('process_kill'), pid: z.number().int().positive(), terminated: z.literal(true) })
  .strict();

const outputSchema = z.discriminatedUnion('action', [
  systemInfoOutputSchema,
  processListOutputSchema,
  processKillOutputSchema
]);

interface ProcessRow {
  pid: number;
  name: string;
  cpu_seconds: number;
  memory_bytes: number;
}

function result(structuredContent: Record<string, unknown>, summary: string): ToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent };
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

function parseProcesses(stdout: string): ProcessRow[] {
  const decoded = JSON.parse(stdout.trim() || '[]') as unknown;
  const rows = Array.isArray(decoded) ? decoded : decoded && typeof decoded === 'object' ? [decoded] : [];
  return rows.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const pid = Math.trunc(finiteNumber(row.pid));
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (pid <= 0 || !name) return [];
    return [
      {
        pid,
        name: name.slice(0, 160),
        cpu_seconds: Math.round(finiteNumber(row.cpu_seconds) * 100) / 100,
        memory_bytes: Math.trunc(finiteNumber(row.memory_bytes))
      }
    ];
  });
}

async function processList(query: string | undefined, limit: number): Promise<ToolResult> {
  // This script is constant: query filtering happens after JSON parsing and the only
  // interpolated value is a Zod-bounded integer. No model text reaches PowerShell syntax.
  const fetchLimit = MAX_PROCESSES + 1;
  const script =
    `$rows = @(Get-Process -ErrorAction SilentlyContinue | Sort-Object CPU -Descending | ` +
    `Select-Object -First ${fetchLimit} @{Name='pid';Expression={$_.Id}},` +
    `@{Name='name';Expression={$_.ProcessName}},` +
    `@{Name='cpu_seconds';Expression={if ($null -eq $_.CPU) { 0 } else { [math]::Round($_.CPU, 2) }}},` +
    `@{Name='memory_bytes';Expression={$_.WorkingSet64}}); ConvertTo-Json -Compress -InputObject $rows`;
  const execution = await runPowerShell(script, process.cwd(), PROCESS_TIMEOUT_MS);
  noteExec({
    running: false,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    durationMs: execution.durationMs
  });
  if (execution.timedOut) return fail('process_list timed out before Windows returned a process snapshot.');
  if (execution.exitCode !== 0) {
    return fail(`process_list failed with exit code ${execution.exitCode ?? 'unknown'}.`);
  }
  const needle = query?.trim().toLocaleLowerCase('en-US') ?? '';
  const matching = parseProcesses(execution.stdout).filter(
    (row) => !needle || row.name.toLocaleLowerCase('en-US').includes(needle)
  );
  const processes = matching.slice(0, limit);
  const structuredContent = {
    action: 'process_list',
    processes,
    returned: processes.length,
    truncated: matching.length > processes.length || execution.truncated
  };
  noteCount(processes.length);
  noteDetail(`${processes.length} process${query ? ` matching ${query.slice(0, 40)}` : ''}`);
  return result(structuredContent, JSON.stringify(structuredContent, null, 2));
}

export function registerPowerTool(reg: SurfaceRegistrar): void {
  reg.register(
    'power',
    {
      title: 'Inspect and control this PC',
      description:
        'Perform bounded Windows host operations with structured results. Use system_info for non-secret OS, CPU and memory facts; ' +
        'process_list for a capped process snapshot; and process_kill to terminate one process tree by PID. ' +
        'This tool uses the same Run commands permission as exec_command and never returns environment variables, command lines or hostnames.',
      inputSchema: z.object({ action: actionSchema }).strict(),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ action }) =>
      reg.guarded('command', 'power', async () => {
        switch (action.type) {
          case 'system_info': {
            const structuredContent = {
              action: 'system_info' as const,
              platform: process.platform,
              architecture: process.arch,
              release: os.release(),
              cpu_count: os.cpus().length,
              total_memory_bytes: os.totalmem(),
              free_memory_bytes: os.freemem(),
              uptime_seconds: Math.floor(os.uptime()),
              node_version: process.version
            };
            noteDetail(`${structuredContent.platform} ${structuredContent.architecture}`);
            return result(structuredContent, JSON.stringify(structuredContent, null, 2));
          }
          case 'process_list':
            return processList(action.query, action.limit ?? 25);
          case 'process_kill': {
            if (action.pid === process.pid || action.pid === process.ppid) {
              return fail('PROTECTED_PROCESS: Chat On Steroids refuses to terminate itself or its direct parent.');
            }
            if (!processExists(action.pid)) {
              return fail(`PROCESS_NOT_FOUND_OR_DENIED: PID ${action.pid} is not available to this user.`);
            }
            await terminateProcessTree(action.pid, action.force ?? true);
            if (!(await waitForProcessExit(action.pid))) {
              return fail(`PROCESS_TERMINATION_UNCONFIRMED: PID ${action.pid} still appears to be running.`);
            }
            logInfo(`tool power process_kill ${action.pid}`);
            noteDetail(`terminated PID ${action.pid}`);
            return result(
              { action: 'process_kill', pid: action.pid, terminated: true },
              `Terminated process tree ${action.pid}.`
            );
          }
        }
      })
  );
}
