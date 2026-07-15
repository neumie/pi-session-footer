# pi-session-footer

A compact, animated two-row footer for [Pi](https://github.com/earendil-works/pi-mono).

```text
~/code/project · project trusted             agents 3 · GPT-5.6 Sol ×2, GPT-5.6 Terra · 128k tok · 1 shell
GPT-5.6 Sol · effort high · tok ↑412k ↓18k · ctx 61%/258k    2/3 · Review authentication · Running tests 18s
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
  - restoration of active runs and token totals after reload.
- Optional [`pi-background-jobs`](https://github.com/neumie/pi-background-jobs) integration:
  - active shell count and pulse;
  - current human-readable job label;
  - live elapsed time without a separate persistent widget.
- Long right-side content truncates before important left-side status.
- Useful third-party statuses remain visible; MCP status/authentication and routine LSP health indicators are intentionally omitted.
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

Requires Node.js 22 or newer. The extension is loaded directly from TypeScript; no build step is required.

## Notes

- This extension replaces Pi's complete footer. Another extension calling `ctx.ui.setFooter()` may override it depending on load order.
- Subagent token aggregation uses `pi-subagents` async status artifacts associated with the active Pi session.
- Smooth color interpolation requires truecolor terminal support; other color modes retain the normal accent color.

## License

[MIT](LICENSE)
