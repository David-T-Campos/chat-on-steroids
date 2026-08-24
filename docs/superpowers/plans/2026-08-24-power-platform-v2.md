# Power Platform v2 Implementation Plan

> **For Codex:** Execute this plan task-by-task with the `executing-plans` workflow and TDD red/green checks.

**Goal:** Strengthen Chat On Steroids with a compact, permission-safe system MCP tool and a Chrome extension operations console without weakening the existing surface, identity, lifecycle, or sandbox guarantees.

**Architecture:** Add one composite Core tool, `power`, behind the existing `command` capability. Its first actions expose bounded host facts and process inspection/termination while reusing the app's child-process and evidence infrastructure. Keep Desktop unchanged and preserve monotonic schema exposure with live permission checks. Extend the authenticated browser bridge with an operations snapshot and let the extension explicitly flush its outboxes and refresh eligible ChatGPT tabs; render those signals in a restrained popup console.

**Tech Stack:** Electron, TypeScript, Node.js, MCP SDK, Zod, Chrome Manifest V3, Vitest, HTML/CSS/JavaScript.

**Status (2026-08-24):** Implementation, targeted tests, typecheck, production build and popup visual review are complete. The repository-wide `npm run verify` remains blocked only by four existing Windows UI Automation `RPC_E_SERVERFAULT` failures; a detached clean `origin/main` control reproduces the same failures.

---

## Task 1: Lock the MCP surface contract with failing tests

**Files:**
- Modify: `test/mcp.test.ts`

- [x] Expect `power` only on Core when command permission was exposed.
- [x] Keep Desktop's exact two-tool contract unchanged.
- [x] Prove a cached `power` schema fails closed after live command revocation.
- [x] Prove `system_info` returns structured, bounded host facts.
- [x] Update the Core schema-count and serialized-size assertions.
- [x] Run `npm test -- test/mcp.test.ts` and confirm the new assertions fail for the missing tool.

## Task 2: Implement the single-schema Power tool

**Files:**
- Create: `src/main/mcp/tools-power.ts`
- Modify: `src/main/mcp/tools-core.ts`
- Modify: `src/main/mcp/surfaces.ts`
- Modify: `src/main/mcp/instructions.ts`

- [x] Define a strict discriminated union with `system_info`, `process_list`, and `process_kill` actions.
- [x] Return structured content with explicit bounds; do not expose environment variables or secrets.
- [x] Reuse direct, shell-free process execution and the existing process-tree terminator.
- [x] Reject invalid/protected PIDs and record concise call evidence.
- [x] Register the tool only from Core when command was exposed; wrap every invocation in the live command guard.
- [x] Run the MCP test file until green, then typecheck.

## Task 3: Lock the Chrome operations contract with failing tests

**Files:**
- Modify: `test/extension.test.ts`

- [x] Add a worker test for authenticated `opsStatus` normalization.
- [x] Add a worker test proving `syncNow` drains queued bridge work and refreshes known/discovered ChatGPT tabs.
- [x] Add a popup contract test for live conversation, command, local queue, acknowledgement, and sync controls.
- [x] Run `npm test -- test/extension.test.ts` and confirm the new assertions fail before implementation.

## Task 4: Implement the extension operations console

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`

- [x] Factor the existing eligible-tab overwrite operation into a reusable helper.
- [x] Add `opsStatus` using only the authenticated loopback `/status` bridge response plus local queue counts.
- [x] Add `syncNow` that awaits command acknowledgements, events, close notices, and tab refresh; return per-stage evidence.
- [x] Render a compact operations rail in the popup with honest unavailable/error states and a disabled/busy sync button.
- [x] Keep the existing disconnect, pairing, and exact-conversation ownership behavior unchanged.
- [x] Run the extension tests until green.

## Task 5: Document and verify the product boundary

**Files:**
- Modify: `README.md`
- Modify: `docs/tool-surface.md`
- Modify: `AGENTS.md`

- [x] Document the new Core tool, permission gate, process safety limits, and extension operations evidence.
- [x] Explain why `power` stays one schema and why Project Inmersion-specific procedures remain skills/workflows rather than hard-coded MCP tools.
- [x] Run `npm test -- test/mcp.test.ts test/extension.test.ts`.
- [ ] Run `npm run verify` and `npm run build`. Build passes; verify is blocked by the upstream-reproducible Windows UIA failure noted above.
- [x] Inspect the popup at its real extension dimensions and capture a visual artifact if practical.
- [x] Review `git diff` and `git status`; do not commit, push, or open a PR without explicit user approval.
