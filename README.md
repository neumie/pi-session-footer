# pi-session-footer

A compact, animated two-row footer for [Pi](https://github.com/earendil-works/pi-mono).

```text
~/code/project · trusted             agents 3 · GPT-5.6 Sol ×2, GPT-5.6 Terra · 128k · 1 shell
GPT-5.6 Sol · high · 61%/258k · ↑412k ↓18k    2/3 · Review authentication · Running tests 18s
```

## Features

- Two compact rows that preserve project and model information.
- Current directory and project trust state.
- Model, reasoning effort, context usage, and session input/output tokens.
- Main-session token totals include async subagents invoked during the session.
- Optional [`pi-subagents`](https://github.com/nicobailon/pi-subagents) integration:
  - active and queued agent counts;
  - concise model mix;
  - live subagent token usage;
  - workflow goal and logical progress;
  - smooth, theme-aware pulse while agents are active;
  - restoration of active runs and durable token totals after reload.
- Long right-side content truncates before important left-side status.
- By product choice, background-job, MCP connection/authentication, and LSP status indicators are omitted; other extension statuses remain visible.
- No monetary-cost display.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/neumie/pi-session-footer
```

Then run `/reload` in Pi.

For local development:

```bash
git clone https://github.com/neumie/pi-session-footer.git
pi install /absolute/path/to/pi-session-footer
```

Pi packages execute with your full system permissions. Review extension source before installing.

## pi-subagents setup

The integration activates automatically when `pi-subagents` emits async lifecycle events. It only renders activity in this footer and does not modify `pi-subagents` widgets or statuses.

## Development

```bash
npm install
npm run check
```

Requires Node.js 22.19.0 or newer. The extension is loaded directly from TypeScript; no build step is required.

## Notes

- This extension replaces Pi's complete footer. Another extension calling `ctx.ui.setFooter()` may override it depending on load order.
- Background-job activity is intentionally left to `pi-background-jobs`' above-editor label row so it is not duplicated in the footer.
- Live subagent activity uses `pi-subagents` async status artifacts associated with the active Pi session. Completed token totals are stored as custom session entries that are not sent to the model, so temporary artifact cleanup does not reset the counter.
- Existing sessions created before durable snapshots are migrated from up to 256 contained child session files across the async run directories referenced by `subagent-notify` entries on the active branch. The migration snapshot is persisted only after every discovered transcript parses successfully; otherwise the next reload retries it. Reads are bounded to 64 MiB, 200,000 lines, and 100,000 entries per transcript, with an 8 MiB line limit.
- Smooth color interpolation requires truecolor terminal support; other color modes retain the normal accent color.

## License

[MIT](LICENSE)
