/** Model-facing pacing control for an active self-paced /loop. */

import { z } from 'zod';
import {
  DYNAMIC_MAX_DELAY_SECONDS,
  DYNAMIC_MIN_DELAY_SECONDS,
  scheduleDynamicWakeup,
  stopDynamicLoop
} from '../loop.js';
import { awaitFreshCallOrigin } from '../session/recorder.js';
import { currentCall, currentCaller, noteDetail } from './call-context.js';
import { fail, guard, IDENTITY_EVIDENCE_MS, type SurfaceRegistrar, type ToolResult } from './kernel.js';

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

async function exactConversation(): Promise<string | null> {
  const caller = currentCaller();
  if (caller.conversationId) return caller.conversationId;
  const call = currentCall();
  if (!call?.caller.requestId) return null;
  const resolved = await awaitFreshCallOrigin('loop', call.startedAt, IDENTITY_EVIDENCE_MS, {
    exact: true,
    requestId: call.caller.requestId
  });
  if (resolved) call.caller.conversationId = resolved;
  return resolved;
}

export function registerLoopTool(reg: SurfaceRegistrar): void {
  reg.register(
    'loop',
    {
      title: 'Pace active loop',
      description:
        'Control the next one-shot wakeup for an active self-paced /loop in this exact ChatGPT conversation. ' +
        'Use only when the current user turn was started by /loop or is continuing one. ' +
        `schedule_wakeup chooses one next delay from ${DYNAMIC_MIN_DELAY_SECONDS} to ${DYNAMIC_MAX_DELAY_SECONDS} seconds after reviewing this iteration; ` +
        'stop ends the self-paced loop. Fixed-interval loops are owned by the app and must not call this tool. ' +
        'Do not busy-poll background work: choose a delay that reflects when new information can realistically exist.',
      inputSchema: z.discriminatedUnion('action', [
        z
          .object({
            action: z.literal('schedule_wakeup'),
            delay_seconds: z
              .number()
              .int()
              .min(DYNAMIC_MIN_DELAY_SECONDS)
              .max(DYNAMIC_MAX_DELAY_SECONDS)
              .describe('Seconds until the next one-shot loop iteration.'),
            reason: z
              .string()
              .min(1)
              .max(600)
              .describe('Specific one-sentence explanation of why this delay is appropriate; shown in loop status.'),
            noop: z
              .boolean()
              .optional()
              .default(false)
              .describe('True only when this iteration found no meaningful change; consecutive no-op runs are counted.')
          })
          .strict(),
        z.object({ action: z.literal('stop') }).strict()
      ]),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (input) =>
      guard('loop', async () => {
        const anyCoreLive =
          reg.caps.browse ||
          reg.caps.search ||
          reg.caps.read ||
          reg.caps.metadata ||
          reg.caps.create ||
          reg.caps.edit ||
          reg.caps.move ||
          reg.caps.deleteFile ||
          reg.caps.command ||
          reg.sessionToolsLive ||
          reg.agentToolsLive;
        if (reg.ctx.readOnly || !anyCoreLive) {
          return fail('LOOP_DISABLED: loop pacing is unavailable while Core is read-only or has no live capability.');
        }
        const conversationId = await exactConversation();
        if (!conversationId) {
          return fail(
            'LOOP_IDENTITY_UNKNOWN: this pacing call could not be tied to one exact ChatGPT conversation, so no timer was changed.'
          );
        }
        try {
          if (input.action === 'stop') {
            const stopped = await stopDynamicLoop(conversationId);
            noteDetail(stopped ? 'self-paced loop stopped' : 'no active loop');
            return text(stopped ? 'Self-paced /loop stopped.' : 'No active self-paced /loop was found for this chat.');
          }
          const view = await scheduleDynamicWakeup(
            conversationId,
            input.delay_seconds,
            input.reason,
            input.noop === true
          );
          const next = view.nextAt ? new Date(view.nextAt).toLocaleString() : 'not scheduled';
          noteDetail(`next wake ${input.delay_seconds}s${input.noop ? ', no-op' : ''}`);
          return text(`Next /loop wakeup scheduled in ${input.delay_seconds} seconds (${next}). Reason: ${input.reason}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === 'LOOP_NOT_ACTIVE') {
            return fail('LOOP_NOT_ACTIVE: /loop is not active in this chat. Do not schedule a wakeup outside an active loop.');
          }
          if (message === 'LOOP_NOT_DYNAMIC') {
            return fail('LOOP_FIXED_INTERVAL: this chat has a fixed-interval /loop; the app owns its cadence and no dynamic wakeup is allowed.');
          }
          throw error;
        }
      })
  );
}
