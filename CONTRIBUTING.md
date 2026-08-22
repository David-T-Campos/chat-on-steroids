# Contributing

Chat On Steroids is a Windows beta maintained by one person. Bug reports, focused fixes and concrete improvements are welcome.

## Before a pull request

For anything non-trivial, open an issue first so the intended behavior is clear. Security problems must be reported privately through [`SECURITY.md`](SECURITY.md), not as an issue or PR.

Keep changes narrow. Preserve existing permission, identity and recovery behavior unless the issue specifically requires changing it. Avoid unrelated formatting, generated output, local debugging material and private data. In screenshots, logs and examples, replace real usernames, local paths, chat text, IDs and credentials with obvious placeholders such as `C:\Users\you\project`.

## Development setup

Development is Windows-only and requires Node 22+.

```sh
npm ci
npm run verify     # typecheck + full test suite
npm run dev        # Electron development build
```

A behavior change should include a deterministic regression test where practical. Run the nearest focused tests while working and `npm run verify` before submitting.

## Packaging

Release installers are architecture-specific:

```sh
npm run dist:x64
npm run dist:arm64
```

The ARM64 release is built and smoke-tested on native Windows ARM64. Packaging downloads/stages pinned external assets and verifies their checksums, so the first packaging run needs network access.

## Pull requests

Explain the root cause, the smallest behavior change that fixes it, and exactly how you validated it. Packaging/runtime changes should include a packaged-runtime smoke check where relevant.

Contributions are accepted under the MIT licence in [`LICENSE`](LICENSE).
