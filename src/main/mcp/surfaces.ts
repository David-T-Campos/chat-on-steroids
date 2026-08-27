/**
 * The model-facing surfaces this app publishes, and what each one is for.
 *
 * ChatGPT connects to one MCP server per connector, and the *whole* of that server's
 * tool list is one discovery unit: `api_tool.list_resources(paths=["Name"])` with no
 * query returns every schema the server advertises. A query narrows it, but nothing
 * guarantees the harness will ask a narrow one, so the honest planning number for a
 * surface is its complete tools/list — not the subset a lucky query would return.
 *
 * That is the entire reason this file exists. Splitting into separate servers is the
 * only mechanism that actually bounds the worst case, because a separate server is a
 * separate discovery boundary that no query can cross.
 *
 * It is deliberately not a splitting free-for-all. Every extra surface is another
 * connector the user has to create, name, describe and keep connected, and on the
 * OpenAI tunnel it is another tunnel id as well (see `docs/tool-surface.md` §6.4).
 * A surface has to earn that. The test applied here is: a distinct capability boundary
 * the user already thinks in, plus enough schema weight that folding it into Core
 * would meaningfully raise Core's no-query cost.
 *
 * Two surfaces pass that test today.
 */

import type { Capabilities } from '../../shared/types.js';
import { desktopAutomationSupported } from '../platform.js';

export const SURFACE_IDS = ['core', 'desktop'] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

/**
 * Brand shown to the user and pasted into ChatGPT.
 *
 * One constant because it appears in the MCP server name, the suggested connector
 * name and the setup cards, and those three drifting apart is how a user ends up with
 * a connector whose name does not match the thing the instructions told them to type.
 */
export const CONNECTOR_BRAND = 'Chat On Steroids';

export interface SurfaceDefinition {
  id: SurfaceId;
  /** MCP server name. Stable; ChatGPT keys its cached metadata off it. */
  serverName: string;
  /** Exactly what the user should type as the connector name in ChatGPT. */
  connectorName: string;
  /** Exactly what the user should paste as the connector description. */
  description: string;
  /** Short line for the setup card, in the app's own voice. */
  cardSummary: string;
  /** Whether the app is usable without it. */
  required: boolean;
  /** Every tool this surface can ever advertise, in listing order. */
  tools: readonly string[];
}

/**
 * Core — the coding loop.
 *
 * `session` and `agents` live here rather than on surfaces of their own. Core declares 8 possible
 * tool names below, but at most 7 schemas are live at once. `find` and the exec pair are mutually
 * exclusive — `find` exists only when command execution is off — so no runtime tools/list reaches
 * all 8 declarations. /plan deliberately does not add another schema: it is a session directive
 * enforced in front of these same tools.
 */
const CORE: SurfaceDefinition = {
  id: 'core',
  serverName: 'chat-on-steroids-core',
  connectorName: `${CONNECTOR_BRAND} Core`,
  description:
    'Read and edit code and text files on this computer, and run commands in a real terminal. ' +
    'Use for: opening and reading files, searching a repository, applying patches, creating, renaming and deleting files, ' +
    'running builds, tests, linters, git, npm and shell commands, and continuing long-running or interactive terminal sessions. ' +
    'Also searches and reads local recordings of previous or concurrently running ChatGPT work, and — when the user has ' +
    'enabled it — spawns and coordinates worker agents, subagents or a parallel swarm across several ChatGPT conversations. ' +
    'Slash Plan Mode is built in: a user message beginning /plan starts a read-only planning phase; inspect and produce a decision-complete plan without editing, running shell commands, desktop input or workers. /plan run approves execution and /plan clear cancels the fence.',
  cardSummary: 'Files, patches and the terminal. Required — this is the coding connector.',
  required: true,
  tools: ['read', 'view_image', 'find', 'apply_patch', 'exec_command', 'write_stdin', 'session', 'agents']
};

/**
 * Desktop — seeing and driving Windows itself.
 *
 * This one earns its boundary twice over. It is gated on permissions the user grants
 * separately and can switch off independently; its two schemas are the largest we publish, since
 * `computer` alone carries thirteen action variants; and the majority of coding sessions
 * never touch the desktop at all. Folding it into Core would put its weight into every
 * no-query discovery of the coding surface, for a capability most conversations do not want.
 */
const DESKTOP: SurfaceDefinition = {
  id: 'desktop',
  serverName: 'chat-on-steroids-desktop',
  connectorName: `${CONNECTOR_BRAND} Desktop`,
  description:
    'See and control this Windows desktop, including its clipboard. ' +
    'Use for: taking a screenshot, reading what is on screen, listing and finding windows, inspecting buttons, fields and other UI controls, ' +
    'clicking, typing, pressing keys, scrolling and dragging in any Windows application, ' +
    'and reading the clipboard or copying and pasting text between programs. ' +
    'When the current recorded session is in /plan mode, observe remains available but computer input/control is hard-blocked until the user sends /plan run.',
  cardSummary:
    'Screenshots, windows, mouse/keyboard control and the clipboard. Optional — connect it only if you want desktop automation.',
  required: false,
  tools: ['observe', 'computer']
};

export const SURFACES: Record<SurfaceId, SurfaceDefinition> = { core: CORE, desktop: DESKTOP };

export const SURFACE_LIST: readonly SurfaceDefinition[] = [CORE, DESKTOP];

export function surfaceDefinition(id: SurfaceId): SurfaceDefinition {
  return SURFACES[id];
}

/**
 * Whether a surface has anything to offer under these capabilities.
 */
export function surfaceIsUseful(
  id: SurfaceId,
  caps: Capabilities,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (id === 'desktop') {
    return desktopAutomationSupported(platform) && (caps.screen || caps.control || caps.clipboardRead || caps.clipboardWrite);
  }
  return true;
}

/** Surfaces worth connecting under these capabilities, in setup order. */
export function usefulSurfaces(caps: Capabilities): SurfaceDefinition[] {
  return SURFACE_LIST.filter((surface) => surfaceIsUseful(surface.id, caps));
}
