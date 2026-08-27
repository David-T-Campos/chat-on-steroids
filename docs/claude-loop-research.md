# Claude Code `/loop` research notes

This document records the externally verifiable behavior used to design Chat On Steroids' clean-room `/loop` implementation. It intentionally does **not** reproduce Anthropic's proprietary bundled source or prompt text.

## Source quality

The implementation was checked against:

1. Anthropic's current **Scheduled tasks** documentation for Claude Code.
2. Anthropic's current **Tools reference** and **Hooks reference**.
3. Claude Code's public changelog, including the original `/loop` release and later dynamic-wakeup changes.
4. Prompt/tool-description strings extracted from the publicly shipped Claude Code binary by the `Piebald-AI/claude-code-system-prompts` research project. Those strings are treated as binary-derived evidence, not as recoverable original TypeScript source.
5. Public Claude Code bug reports that contain current-version runtime errors and observed scheduling behavior.

Claude Code is now shipped as a native per-platform binary. Binary inspection can recover embedded strings and enough control-flow evidence to reconstruct behavior, but it cannot deterministically recover Anthropic's original source names, comments, formatting, or module boundaries. This implementation therefore mirrors behavior rather than claiming to be Anthropic source.

## Verified architecture

`/loop` is a bundled orchestration skill over a scheduler substrate. It is not merely a text macro that repeats a prompt.

### Fixed mode

Examples such as `/loop 5m check the deploy` or `/loop check the deploy every 5 minutes` create a recurring schedule and run the task immediately once. Claude converts the interval to a cron-compatible cadence. Seconds are rounded up to minute granularity, and awkward intervals that are not clean cron cadences are rounded and disclosed.

### Self-paced mode

When the interval is omitted, each iteration chooses its own next one-shot wakeup after observing the result of the current iteration. Current Claude Code exposes that decision through `ScheduleWakeup`:

- allowed delay: 60–3600 seconds;
- the same loop task is carried into the next iteration;
- a human-readable reason accompanies the timer;
- a no-op bit records whether the iteration observed meaningful change;
- `stop: true` ends the loop.

When useful, Claude may use a background monitor as the primary event wakeup and keep a longer timer as fallback. Chat On Steroids currently implements the one-shot timer mechanism but does not invent a generic background-event monitor that its runtime does not otherwise have.

If a dynamic iteration returns without scheduling or stopping, current Claude Code gives it one roughly twenty-minute fallback wakeup. If that fallback iteration also fails to make a pacing decision, the runtime ends the loop. Chat On Steroids implements the same two-step discipline.

### Bare `/loop`

A bare command uses a maintenance task instead of requiring an explicit prompt. Public Anthropic documentation describes its priority order as unfinished work in the conversation, maintenance of the current branch/PR, then conservative bug-hunting or simplification when the work is otherwise quiet. It must not use a timer as permission to invent unrelated initiatives, and irreversible actions still require authorization from the conversation.

The Chat On Steroids maintenance prompt is original wording that implements those public semantics.

### Lifetime and scheduling rules

Current Claude Code behavior includes:

- scheduled tasks are scoped to the session;
- recurring tasks automatically expire after seven days;
- the scheduler checks frequently but only injects due prompts between turns;
- a busy session is not interrupted;
- missed occurrences do not accumulate into catch-up bursts;
- tasks run in the local timezone;
- scheduled state can be listed and cancelled;
- resumed sessions restore unexpired scheduled tasks;
- the feature can be disabled globally with Claude Code's cron-disable environment switch.

Chat On Steroids mirrors the properties that map to a browser-backed conversation: seven-day expiry, idle-only delivery, no catch-up, durable restart recovery, per-conversation status/cancel, and transfer with Compact & Resume.

## Parsing rules mirrored here

The shipped `/loop` orchestration prompt gives a leading compact interval priority over a trailing `every …` phrase:

1. first token matching a compact duration such as `5m`, `2h`, `1d`;
2. otherwise a trailing phrase such as `every 5 minutes`;
3. otherwise self-paced mode.

The first iteration runs immediately in both fixed and self-paced modes.

`/proactive` is retained as an alias because Claude Code added that alias after `/loop` shipped.

## Deliberate Chat On Steroids adaptations

The mechanisms are mapped to this product's security and delivery architecture instead of copying implementation accidents from a terminal UI:

- The app, not the model, commits the fixed schedule before the first ChatGPT send. This avoids the class of Claude Code reports where the model failed to issue the scheduling tool at all.
- A scheduled browser turn is claimed by one exact conversation + browser client before it can be typed, using the same lost-ACK/idempotency principle as Goal Mode.
- The self-paced MCP tool can only alter an active dynamic loop belonging to the exact caller conversation. A model cannot create arbitrary timers in another chat.
- Dynamic loop tasks are immutable app state; the model chooses only delay/reason/no-op/stop. Claude's current tool asks the model to echo the prompt back, but storing the original prompt server-side is a stronger equivalent in this architecture.
- The browser composer is never overwritten while the user is typing. A due iteration is deferred and re-offered instead.
- Compact & Resume moves the loop's durable conversation binding with the rest of the session projections.
- Main-model token usage is not fabricated. Chat On Steroids can count iterations and no-op streaks, but ChatGPT Web does not expose authoritative per-turn token accounting equivalent to Claude Code's CLI usage telemetry.

## Compatibility notes

Claude Code's self-paced wakeup tool is feature/provider gated. On managed providers where it is unavailable, Anthropic documents a fixed ten-minute fallback for prompt-only `/loop`. Chat On Steroids has one local runtime and therefore does not need a provider-specific fallback: self-paced mode is always implemented by its own local scheduler.
