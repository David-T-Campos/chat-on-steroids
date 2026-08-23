# Changelog

All notable changes to this project are documented here.

This project is in **beta** despite the 1.x version number. Behavior may still change between
releases.

The app and the `extension/` companion are versioned together. **Reload the
extension after updating the app**. If their bridge protocols are incompatible,
the app refuses the extension and asks you to reload the matching copy.

## [1.9.6] — 2026-08-23

### Fixed
- **A compaction turn is no longer declared finished while it is still working.** The end of a
  turn was decided by one signal — the stop control staying gone for four seconds — and a long
  agentic turn makes that control flicker between phases. On 2026-08-23 that closed a compaction
  turn 28 characters into its brief, stored `TASK\nContinue implementing ` as the whole handoff
  for a session holding 455 events and 318,422 tokens, and opened the replacement chat with it
  while the original went on making tool calls for another seven minutes. The brief is now held
  until four things agree and keep agreeing: the stop control is gone, the answer has stopped
  growing, the turn's tool rail has stopped moving, and the app reports no local call still
  running. An app that cannot be asked counts as busy rather than as idle.
- **A brief too short to have carried the session is refused instead of stored.** Nothing
  downstream can tell a truncated handoff from a complete one, so the check happens before it is
  written. A refused compaction leaves the session exactly where it was and says why.
- **A resume no longer races the recorder for its own replacement chat.** The recorder invents a
  session for any conversation it has not seen; the commit moves the existing session onto that
  same chat. The recorder won by 302 ms, the commit found its destination already owned and
  refused to rebind, and the session stayed behind while the swarm's prime role moved on without
  it. New chats now wait, briefly and boundedly, while a replacement chat is expected — including
  after a restart that recovered a continuation still holding its claim.
- **`rg pattern *_test.go` works on PowerShell without silently widening.** PowerShell does not
  expand globs for native programs, so the pattern reached ripgrep literally and the call failed.
  The glob is now expanded against the working directory the way the shell would have, rather
  than rewritten to `-g`, which is a recursive filter that would also have matched
  `sub/nested_test.go`. Only the first statement of a command line is touched, because anything
  after it may have changed the directory or the files in it.
- **A search that found nothing is no longer recorded as a failed tool call.** `rg`, `grep` and
  `findstr` spend exit 1 on "no matches" and reserve other codes for real errors. The exemption
  applies only when the program that set `$LASTEXITCODE` — the rightmost native stage of the
  pipeline, not its generator — is one of those, and only when it printed no error of its own.
- **`read` accepts several paths and a line range in one call**, and says outright when a file
  has no lines in that range, so a short file can never read as a complete one.
- **A child process inherits the environment it was given**, and `JAVA_HOME` / `GOROOT` are
  filled in from an installed toolchain when — and only when — the tool would otherwise be
  unreachable. Versioned install directories are now compared as version numbers, so `jdk-21`
  outranks `jdk-9`.
- **git run outside a repository says so**, and names how to find the root, instead of returning
  a bare failure.

## [1.9.5] — 2026-08-23

### Added
- **The extension requirement is explicit where sub-agents are configured.** Setup now says
  worker chats require the companion extension to be loaded and connected, Chat settings repeats
  that requirement, and Setup includes a direct download link for the standalone extension ZIP.

### Fixed
- **Sub-agents can be enabled without restarting Chat On Steroids.** Swarm persistence hooks are
  now wired for the lifetime of the main process instead of only when multi-agent was enabled at
  startup, so the first `spawn` after enabling the feature can cross its durable acceptance
  barrier normally.

## [1.9.4] — 2026-08-22

### Added
- **Native Windows x64 and ARM64 release packaging.** Release candidates build and smoke-test
  each architecture on a matching Windows runner, bundle the matching tunnel/search assets and
  Chrome extension, and assemble explicit installers plus an extension zip and SHA-256 manifest.

### Changed
- **Fresh installs start fully enabled.** All file, command and desktop permissions begin on,
  read-only mode begins off, and multi-agent starts enabled with the existing two-worker
  default. Existing configs keep their explicit choices, and a corrupt config still recovers
  conservatively rather than treating damage as permission consent.
- **The Home activity log starts shorter**, leaving more vertical room for permissions,
  folders and health without changing the activity view itself.
- **Public setup and security guidance was refreshed for release.** The landing page now calls
  out the separate x64/ARM64 installers, bundled-extension install path, unsigned SmartScreen
  warning, current ChatGPT MCP access limits, and the experimental browser-automation terms risk.

### Fixed
- **Compact & Resume and browser-command recovery are durable across failures and restarts.**
  Continuation transitions now persist before publication, queued/leased browser commands and
  final receipts survive restart, and a committed resume cannot be cancelled by a late timeout
  or lost HTTP response.
- **Multi-agent finish and recovery paths are deterministic.** Terminal worker retries can
  recover their final result without reviving the worker, critical broker state has an awaited
  durability barrier, and resume transfers repair only from durable recovery evidence.
- **The extension no longer drops recoverable work on transient/protocol failures.** 426 keeps
  the observation journal for retry, command acknowledgements use a storage-backed outbox, and
  retry alarms are kept stable until durable work drains.
- **Browser/Fiber attribution is stricter under navigation and reused UI state.** Scan identity,
  request ownership and chronology stay fail-closed when ChatGPT reuses rows, ids or documents.
- **Session/catalog races no longer resurrect stale ownership.** Conversation attachment lookup,
  first-sight initialization and asset accounting now preserve the durable session as authority.

### Performance
- Reduced repeated filesystem scans and metadata calls in `read`, glob expansion and fallback
  search; reused already-read bytes for binary/encoding detection and reduced ripgrep buffer
  copying.
- Removed repeated browser journal/chronology scans and batched request-correlation persistence;
  streaming session messages now compare their fixed stored-text shape without repeatedly
  serializing large prose.

## [1.9.3] — 2026-08-21

### Changed
- **The app is now called Chat On Steroids.** The installer, the window, the connector
  names and the extension all use the new name. Two consequences on upgrade: the new
  build installs alongside the old one rather than over it, and settings live in a new
  folder (`%APPDATA%\chat-on-steroids\`), so the stored API key and recorded sessions
  do not carry across. **Reload the extension** — the bridge handshake changed with the
  name, and an old extension is refused with a visible error rather than failing quietly.
- **`spawn` takes a shared `context`.** The repository, the conventions file, what not to
  touch, how to validate, what to report — written once for the batch, and put in front
  of every worker's own task. Each `task` now carries only that worker's objective.
- **`message` sends a batch.** `action='message'` accepts a `messages` array as well as a
  single `to`/`text`: three redirected workers are one tool call instead of three, and
  the batch is delivered in full or not at all.
- **Every `agents` reply carries machine-readable state** beside its sentence of prose —
  the run, the caller, each agent and anything queued — so the model reads state rather
  than parsing English.
- **Workers are asked for a structured handoff**: RESULT, CHANGES, VALIDATION, BLOCKERS.
- **The preamble typed into a worker's chat is three lines shorter**, saying only who it
  is and how to report.
- **A closed tab no longer ends a worker.** A ChatGPT turn runs on OpenAI's servers, so
  closing the tab loses this app's view of the worker rather than stopping it. Such a
  worker shows as *no tab*, keeps its slot, and rejoins the moment it calls again; it is
  given up on only once it has also gone quiet.

### Removed
- **`agents(action='join')` and its recovery key, entirely.** It was the last credential
  in the app and the only field a model could present as identity. A worker is the chat
  the app opened for it; a binding that goes missing is restored by the extension
  reporting the chat, not by pasting a key. The desktop window's recovery-key button is
  gone with it.

## [1.9.2] — 2026-08-21

Pre-public beta milestone.

### Fixed
- Harvest the request id before ChatGPT's safety check releases it. The id used to
  correlate a tool call with the turn that caused it could be gone by the time it
  was read, which surfaced as calls landing under the wrong turn or under
  *Unattributed activity*.

## [1.9.1] — 2026-08-21

### Fixed
- Attribute MCP calls that arrive without a `data-turn-id`. ChatGPT does not always
  stamp the attribute; those calls previously fell through to *Unattributed*.

## [1.9.0] — 2026-08-21

### Fixed
- Live transcript ownership and chronology. Turn identity could leak from an older
  generation into a newer one, progress ids could be reused across generations, and
  the same semantic tool row could be recorded two or three times under
  index-derived ids. Identity is now scoped per generation rather than trusting a
  DOM attribute that survives React node reuse.

## [1.8.9] — 2026-08-21

### Changed
- Hardening pass across MCP lifecycle, path handling and process control.
- The test suite terminates reliably instead of leaving stray workers behind.

## [1.8.4] — 2026-08-20

### Added
- Refreshed application icon.
- Current Codex-derived base tools ported to Core.

### Fixed
- Turn-killer bug; session identity now survives a reload.
- Live transcript capture and attribution repair.

## [1.7.6] — 2026-08-18

### Changed
- Reduced model-facing tool surface from 45 tools / ~60 kB to 12.5 kB across six
  core tools and 7.9 kB across two desktop tools, with those sizes held as test
  budgets. See [`docs/tool-surface.md`](docs/tool-surface.md).

## [1.5.1] — 2026-08-15

### Changed
- Hardened MCP workflows and process control.
- Corrected the documented Electron user-data path.

## [1.5.0] — 2026-08-15

### Added
- Transactional batch edits and process output cursors.

[1.9.5]: https://github.com/totec448-spec/chat-on-steroids/releases/tag/v1.9.5
[1.9.4]: https://github.com/totec448-spec/chat-on-steroids/releases/tag/v1.9.4
