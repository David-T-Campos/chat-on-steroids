# Model-facing tool surface

This is the current public reference for the tool surface. The implementation and tests are
authoritative; `src/main/mcp/surfaces.ts`, `src/main/mcp/tools-core.ts`, `src/main/mcp/tools-power.ts`,
`src/main/mcp/tools-desktop.ts` and `test/mcp.test.ts` should agree with this file.

## Connectors

Chat On Steroids publishes two independent MCP connectors. They are separate discovery and
permission boundaries and use separate secret tokenized local paths.

| Connector | Purpose | Possible tools |
| --- | --- | --- |
| **Chat On Steroids Core** | Approved files, patches, terminal, bounded host operations, recorded-session lookup, workers | `read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `power`, `session`, `agents` |
| **Chat On Steroids Desktop** | Screen, windows, mouse/keyboard and clipboard | `observe`, `computer` |

The Desktop connector is optional. Core is the main connector.

On a fresh config, all tool permissions, session recording and multi-agent mode are
enabled, while read-only mode is off. Existing configs keep explicit choices during upgrades;
missing legacy permissions are not silently widened.

With the fresh all-on capability snapshot, Core advertises eight schemas:
`read`, `view_image`, `apply_patch`, `exec_command`, `write_stdin`, `power`, `session`, and `agents`.
`find` is the search fallback for a snapshot where search is enabled and command execution is
unavailable. Tool exposure is monotonic within a running connector instance, so a permission
changed mid-conversation can leave a previously exposed name listed; its handler still enforces
the current permission.

## Core tools

### `read`

Reads approved paths. It accepts one or more paths, lists a directory one level deep, expands
bounded globs, supports line ranges for one text file, and can return supported image content.
Path resolution and result-size limits are enforced by the app.

### `view_image`

The dedicated Codex-compatible image tool. It is a real Core tool, separate from `read`, and
is gated by the read capability. Image transport and decode checks remain bounded.

### `find`

Search fallback used when search is enabled and command execution was unavailable when the
surface snapshot was built. It covers filename/glob and text search without granting a shell.

### `apply_patch`

The text mutation primitive. It uses the V4A patch envelope and preflights a multi-file patch
before writing. Create, edit, move and delete-file permissions are checked independently.
Directory deletion and arbitrary binary writes are deliberately not hidden patch operations.

### `exec_command`

Runs a command in a real Windows shell. This permission is **not** confined to approved
folders. Long-running commands return an opaque `session_id` that `write_stdin` can continue.

### `write_stdin`

Writes to or polls a live command session by `session_id`, with optional yield time and output
budget. A blank `chars` value is a poll rather than a separate process-status tool.

### `power`

One composite host-operations schema, available only with the command permission. Its bounded
actions are `system_info`, `process_list`, and `process_kill`. System information excludes the
hostname and environment; the process snapshot excludes command lines and is capped at 100
rows; termination rejects the app's own PID and direct parent before using the existing
process-tree terminator. A live permission guard runs on every action even when ChatGPT retained
an older schema snapshot.

`power` is deliberately not a catalogue of product-specific procedures. Repository workflows,
including Project Inmersion conventions, belong in skills and project instructions over the
general file/command primitives rather than in permanently exposed MCP schemas.

### `session`

Available while session recording is enabled. It has exactly two actions:

- `history` reads a bounded slice of recorded session history, optionally by query or call id.
- `status` reports the current recorded-session state and estimates used by the app.

Compact & Resume is app/browser orchestration. There is no model-visible `save_handoff` or
`resume_session` tool.

### `agents`

Available while multi-agent mode is enabled. It remains one composite schema with nine actions:

- `spawn` creates worker chats from one shared context plus per-worker tasks.
- `message` sends one message or an all-or-nothing batch.
- `status` reports the run and workers.
- `finish` is the worker's terminal handoff to the prime.
- `goal_create` creates a durable objective with bounded, acceptance-tested tasks.
- `goal_add_tasks` adds bounded tasks to the creating conversation's active goal.
- `goal_assign` assigns one queued task to a ChatGPT worker, Claude Code, or Hermes Agent.
- `goal_status` reconciles provider processes and returns the durable goal state.
- `task_cancel` stops one running task and records the cancellation.

There is no model-supplied agent credential or `agent_key`. Worker/prime identity is bound to
the ChatGPT conversation using extension evidence; control calls fail closed when that identity
cannot be proven. Goal ownership uses that same exact conversation evidence and is omitted from
all public goal projections. Claude Code and Hermes are launched as fixed, shell-free argv only
when command permission is live, read-only mode is off and the workdir resolves inside an approved
root; each CLI keeps its own authentication, so no provider credential enters MCP or the extension.

## Desktop tools

### `observe`

Reads desktop state without moving focus: screenshots, windows and UI-control information.
Screen access is independent from mouse/keyboard control.

### `computer`

Executes a bounded batch of desktop actions. The current action set is:
`click_ref`, `set_value`, `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`,
`focus`, `wait`, `read_clipboard`, and `write_clipboard`.

Each step is checked against the current screen/control/clipboard permissions. Read-only mode
can keep observation available while disabling state-changing desktop actions.

## Permission and discovery invariants

- A tool call is checked against current permissions even if its schema was exposed earlier.
- Core and Desktop do not forward or alias each other's tools.
- A connector token for one surface does not authorize the other surface.
- Read-only mode removes effective file-write, command, control and clipboard-write permissions
  without pretending the underlying configuration was changed.
- Approved filesystem roots do not sandbox command execution or desktop control.
- Tool results and validation errors are bounded; large structured or binary payloads must not
  grow without an explicit cap.
- `power` shares the command permission and privilege boundary: its conveniences are not a new
  elevation path, and approved filesystem roots do not contain them.

## Compatibility notes

Older conversations can retain a cached MCP schema after an upgrade. Refresh/review the app in
ChatGPT, or recreate it if your workspace requires that, then start a new conversation when the
connector's exposed tool shape changes. The current extension pairs automatically with the local
bridge; there is no pairing code to enter.

## Tests that protect the surface

`test/mcp.test.ts` checks exact surface membership, cross-surface rejection, discovery-size
budgets, permission gating, retired names and schema shape. Native image parity has additional
coverage in `test/codex-view-image-parity.test.ts`.

When changing the public tool surface, update the implementation, the surface declarations,
the tests and this document together. Do not add a permanently exposed tool for a workflow
that can be expressed safely through the existing primitives.
