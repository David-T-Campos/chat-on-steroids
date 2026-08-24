# Agent Orchestration Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Chat On Steroids into a durable, multi-provider agent control plane that can coordinate ChatGPT conversations, Claude Code, and Hermes Agent while keeping the Chrome extension observational and every local mutation behind the desktop app's existing permissions.

**Architecture:** Keep the existing `agents` MCP tool as the single orchestration schema and add goal-oriented actions to it rather than adding a ninth Core tool. A durable goal ledger owns task state; fixed provider adapters translate approved tasks into shell-free Claude/Hermes argv; a runner owns process lifecycle and reconciles results. The Electron UI is the authority for starting/cancelling external work, while the extension receives only bounded, secret-free summaries and remains unable to execute local tools.

**Tech Stack:** Electron, TypeScript, Zod, MCP SDK, Vitest, Chrome Extension Manifest V3, Playwright, Windows process management

---

## File map

- Create `src/shared/goals.ts`: renderer-safe goal, task, provider and status types.
- Create `src/main/goals.ts`: validated in-memory ledger, durable snapshots, transitions and listeners.
- Create `src/main/agent-providers.ts`: fixed Claude Code and Hermes command/argv builders plus output parsers.
- Create `src/main/agent-runner.ts`: launch, refresh, cancel and shutdown ownership for external task processes.
- Modify `src/main/index.ts`: restore/persist the goal ledger and stop owned provider runs on quit.
- Modify `src/main/mcp/tools-core.ts`: extend the existing `agents` composite with goal actions and live permission guards.
- Modify `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.ts`, `src/renderer/styles.css`: desktop Mission Control.
- Modify `src/main/bridge.ts`: authenticated, bounded read-only goal summary route.
- Create `extension/sidepanel.html`, `extension/sidepanel.js`, `extension/sidepanel.css`: extension Mission Control mirror.
- Modify `extension/manifest.json`, `extension/background.js`, `extension/popup.html`, `extension/popup.js`, `extension/popup.css`: side-panel entry point and summary counts.
- Create `test/goals.test.ts`, `test/agent-providers.test.ts`, `test/agent-runner.test.ts`: domain and provider tests.
- Modify `test/mcp.test.ts`, `test/bridge.test.ts`, `test/extension.test.ts`, `test/ipc.test.ts`, `test/renderer-*.test.ts`: boundary tests.
- Modify `README.md`, `docs/tool-surface.md`, `AGENTS.md`: user setup, security model, provider contracts and invariants.

### Task 1: Durable goal and task ledger

- [ ] Write `test/goals.test.ts` first with tests proving normalized creation, bounded task counts, legal transitions, terminal-state protection, derived goal completion, restart interruption, defensive clones and corrupt snapshot rejection.
- [ ] Run `npx vitest run test/goals.test.ts`; expect failure because `src/main/goals.ts` does not exist.
- [ ] Add renderer-safe types in `src/shared/goals.ts` and the minimal state machine in `src/main/goals.ts`.
- [ ] Run `npx vitest run test/goals.test.ts`; expect all goal tests to pass.
- [ ] Wire `goals-state` persistence in `src/main/index.ts`, then run `npx vitest run test/goals.test.ts test/durable.test.ts`.
- [ ] Commit as `feat: add durable goal and task ledger`.

### Task 2: Fixed external-agent provider adapters

- [ ] Write `test/agent-providers.test.ts` first. Assert Claude uses `claude -p ... --output-format json --max-turns ... --no-session-persistence`, Hermes uses `hermes chat -q ... -Q --source chat-on-steroids`, provider values are an enum, prompt text stays one argv item, secrets are not rendered in display labels, and malformed output fails explicitly.
- [ ] Run the test and observe the missing-module failure.
- [ ] Implement `src/main/agent-providers.ts` with fixed executable names, fixed flag vocabulary, bounded prompt construction and provider-specific result parsers.
- [ ] Run `npx vitest run test/agent-providers.test.ts` and then `npm run typecheck`.
- [ ] Commit as `feat: add Claude and Hermes provider adapters`.

### Task 3: Owned provider runner

- [ ] Write `test/agent-runner.test.ts` first using injected process operations. Cover launch, refresh-to-completed, nonzero failure, cancellation, duplicate-run refusal, process loss after restart and stop-all shutdown.
- [ ] Run the test and observe the expected missing behavior.
- [ ] Implement `src/main/agent-runner.ts` over `startManagedProcess`, `getManagedProcess`, `stopManagedProcess` and bounded result parsing.
- [ ] Require an approved virtual workspace, multi-agent enabled, read-only off and the command capability live before launch.
- [ ] Register the runner's shutdown owner in `src/main/index.ts` and prove no child remains after shutdown.
- [ ] Run `npx vitest run test/agent-runner.test.ts test/process-manager.test.ts`.
- [ ] Commit as `feat: run owned external agent tasks`.

### Task 4: One MCP orchestration surface

- [ ] Add failing MCP tests for `goal_create`, `goal_add_tasks`, `goal_assign`, `goal_status`, `task_cancel` and goal-linked ChatGPT workers.
- [ ] Assert every mutating action is live-guarded, stranger chats cannot inspect an active private run, external providers require command permission, and no schema field contains a token/key/secret.
- [ ] Extend the existing `agents` schema and handler; do not register a new Core tool.
- [ ] Link `goal_assign provider=chatgpt` to broker workers and link `finish` reports back to the matching task.
- [ ] Keep `tools/list` within the measured Core byte budget; update the per-tool budget only to the smallest proven value.
- [ ] Run `npx vitest run test/mcp.test.ts test/agents.test.ts test/swarm.test.ts`.
- [ ] Commit as `feat: orchestrate goals across agent providers`.

### Task 5: Desktop Mission Control

- [ ] Add failing IPC/preload/renderer contract tests for list, create, run, cancel and clear-completed operations.
- [ ] Add typed IPC methods; validate every payload with Zod in the main process.
- [ ] Build a Goals panel showing objective, progress, provider, task state, bounded output/error and explicit Run/Cancel controls.
- [ ] Never send real approved-root paths, environment variables, provider credentials or raw command lines to the renderer.
- [ ] Add keyboard focus, 44px controls, live status announcements, reduced-motion handling and light/dark contrast.
- [ ] Run `npx vitest run test/ipc.test.ts test/renderer-html.test.ts test/renderer-layout.test.ts test/renderer-state.test.ts`.
- [ ] Commit as `feat: add desktop agent mission control`.

### Task 6: Chrome extension Mission Control

- [ ] Add failing extension tests proving the side panel is declared, exposes bounded goal/task counts, and contains no local execution, provider credential, filesystem or arbitrary fetch API.
- [ ] Add an authenticated `GET /goals/summary` bridge route returning only IDs, labels, states, providers, timestamps and counts with strict response caps.
- [ ] Add Manifest V3 side-panel files and a popup entry button. The panel may observe and request ChatGPT-tab coordination; it must not start Claude/Hermes or execute local tools.
- [ ] Preserve the bridge token solely in extension service-worker storage and never pass it into page or side-panel DOM.
- [ ] Run `npx vitest run test/bridge.test.ts test/extension.test.ts test/content-script.test.ts`.
- [ ] Load the unpacked extension at 348px popup width and side-panel width, then capture and inspect light/dark screenshots.
- [ ] Commit as `feat: add extension mission control side panel`.

### Task 7: Provider setup and health

- [ ] Add failing diagnostics tests for missing CLI, version probe failure and authenticated-but-unavailable states without reading credential files.
- [ ] Add shell-free `--version` probes for `claude` and `hermes` with short timeouts and bounded output.
- [ ] Surface installation/status guidance in the desktop app, using allowlisted official links only.
- [ ] Document that Claude/Hermes remain separately installed and authenticated products and that Chat On Steroids stores no provider credential.
- [ ] Validate a harmless real task with installed Claude Code and Hermes Agent in a temporary approved workspace; cancel any run exceeding its bound.
- [ ] Commit as `feat: add external agent health checks`.

### Task 8: Release and contribution evidence

- [ ] Run `npm run format:check`, `npm run typecheck`, the full deterministic Vitest suite, `npm run build`, `npm audit --omit=dev`, extension contract tests and package smoke tests.
- [ ] Re-run the real Windows UI Automation suite separately. If the known `RPC_E_SERVERFAULT` persists, retain clean-`origin/main` control evidence and do not describe it as caused by this branch.
- [ ] Run `git diff --check`, secret scan, schema-size assertions and a final security boundary review.
- [ ] Create a fork under the authenticated GitHub account, push `feat/power-platform-v2`, open a PR against `totec448-spec/chat-on-steroids:main`, and include exact local/CI evidence and the environmental UIA note.
- [ ] Watch CI, repair branch-caused failures, and leave the original user checkout unchanged.

## Self-review

- Spec coverage: whole-system MCP power, Chrome extension, multi-chat goals, Claude/Hermes control, security, verification and upstream contribution each have an implementation task.
- Boundary check: the extension remains observational; local execution stays in Electron and requires existing user permissions.
- Surface check: orchestration extends `agents`, preserving the eight-tool Core ceiling.
- Lifecycle check: every external process has a task owner, cancellation route, bounded output and application-shutdown owner.
- Secret check: provider CLIs authenticate themselves; no API key crosses MCP, IPC, bridge or extension surfaces.

