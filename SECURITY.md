# Security policy

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security problem.** Use GitHub's private vulnerability reporting for this repository: **Security → Report a vulnerability**.

Include the smallest useful reproduction, the app version (**Settings → About**), Windows version/architecture, and whether the Chrome extension was connected. Redact personal file contents, usernames/paths, conversation text and account/workspace identifiers. Never post live API keys, connector URLs, tunnel tokens or other credentials. Rotate anything accidentally exposed.

This is a solo-maintained beta. There is no bug bounty or guaranteed response window.

Security fixes target the **latest published release**. If you can reproduce an issue safely on
the latest version, include that result in the private report.

## Security model

Chat On Steroids is a permission boundary between ChatGPT and the Windows user running the app:

- Filesystem tools validate paths against folders you explicitly approve.
- Read-only mode disables effective file writes, commands, desktop control and clipboard writes.
- `exec_command` is intentionally **not** confined to approved folders. It starts in an approved working directory, then runs with the normal privileges of your Windows account.
- Screen, mouse/keyboard and clipboard permissions are desktop-wide capabilities, not folder permissions.
- MCP servers bind to loopback and use secret tokenized paths. Public reachability comes only from the tunnel you configure.
- The companion-extension bridge is a separate loopback service and exposes no filesystem, command or settings-mutation route.
- Stored API/bridge credentials use Electron `safeStorage` on Windows; normal Activity logs are redacted, capped and memory-only.
- Session recording is separate durable local history. It is on for fresh installs and can be disabled.

## Expected limitations

These are properties of the current design, not vulnerability reports by themselves:

- **The installers are unsigned.** Windows SmartScreen can warn until releases are code-signed. Verify release SHA-256 checksums before running them.
- **Fresh installs start with all tool permissions enabled and read-only mode off.** Review permissions before connecting ChatGPT. Existing installs keep their explicit stored choices.
- **Application path checks are not a kernel/VM sandbox.** They substantially constrain the app's filesystem tools, but same-user filesystem races can still exist. Do not treat approved roots as isolation from a hostile local process.
- **Command and desktop capabilities are powerful by design.** If enabled, they can act wherever your Windows user can act, subject to normal Windows privilege boundaries.
- **Session recording is intentionally detailed and is not encrypted by `safeStorage`.** Recorded conversations/tool activity stay local to this app, but anyone with access to your Windows account may be able to read the session files.

## Scope

In scope: this repository's desktop app, MCP surfaces, local browser bridge and `extension/` companion.

Out of scope: ChatGPT/OpenAI infrastructure, Electron/Chromium upstream, `tunnel-client`, `cloudflared`, and other third-party dependencies. Report upstream vulnerabilities to the relevant project as well.
