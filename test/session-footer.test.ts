import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../extensions/session-footer.ts";

test("renders and clears compact background shell activity", async () => {
  const lifecycle = new Map<string, Function[]>();
  const events = new Map<string, Function[]>();
  let footerFactory: Function | undefined;
  const pi = {
    on(name: string, handler: Function) {
      lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
    },
    events: {
      on(name: string, handler: Function) {
        events.set(name, [...(events.get(name) ?? []), handler]);
        return () => {};
      },
      emit(name: string, payload: unknown) {
        for (const handler of events.get(name) ?? []) handler(payload);
      },
    },
    getThinkingLevel: () => "high",
  };
  extension(pi as never);

  const ctx = {
    cwd: "/tmp/project",
    model: { id: "gpt-5.6-sol" },
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => "footer-test-session",
      getSessionId: () => "footer-test-session",
    },
    ui: {
      setStatus() {},
      setWidget() {},
      setFooter(factory: Function) {
        footerFactory = factory;
      },
    },
  };
  for (const handler of lifecycle.get("session_start") ?? []) {
    await handler({ type: "session_start" }, ctx);
  }
  assert.ok(footerFactory);

  const theme = {
    fg: (_name: string, value: string) => value,
    bold: (value: string) => value,
    getFgAnsi: () => undefined,
  };
  const footer = footerFactory?.({}, theme, {
    getExtensionStatuses: () => new Map(),
  });

  pi.events.emit("background-jobs:changed", {
    runningCount: 1,
    terminalRecentCount: 0,
    oldestStart: Date.now() - 20_000,
    primary: {
      id: "01",
      label: "Run unit tests",
      command: "npm test",
      startedAt: Date.now() - 5_000,
    },
  });
  const active = footer.render(120) as string[];
  assert.match(active.join("\n"), /1 shell/);
  assert.match(active.join("\n"), /Running Run unit tests 5s/);
  assert.ok(active.every((line) => visibleWidth(line) <= 120));

  pi.events.emit("background-jobs:changed", {
    runningCount: 0,
    terminalRecentCount: 1,
  });
  const idle = footer.render(120) as string[];
  assert.doesNotMatch(idle.join("\n"), /shell|Running Run unit tests/);

  for (const handler of lifecycle.get("session_shutdown") ?? []) {
    await handler({ type: "session_shutdown", reason: "quit" }, ctx);
  }
});
