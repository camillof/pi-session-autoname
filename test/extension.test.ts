import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSessionAutonameExtension } from "../src/extension.ts";

type Handler = (event: unknown, context: any) => unknown;
type CommandHandler = (args: string, context: any) => Promise<void>;

function message(role: string, text: string): unknown {
  return {
    type: "message",
    message: { role, content: [{ type: "text", text }] },
  };
}

function response(title: string): unknown {
  return { content: [{ type: "text", text: title }] };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness(
  t: test.TestContext,
  options: {
    config?: Record<string, unknown>;
    initialName?: string;
    complete?: (model: unknown, context: any, options: any) => Promise<unknown>;
  } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-session-autoname-extension-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  if (options.config) {
    writeFileSync(path.join(agentDir, "session-autoname.json"), JSON.stringify(options.config));
  }

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandHandler>();
  const notifications: Array<{ message: string; level: string }> = [];
  let sessionName = options.initialName;
  let branch: unknown[] = [];
  let completeCalls = 0;
  let findCalls = 0;
  let prompt = "";

  const model = { provider: "test", id: "title-model" };
  const complete = options.complete ?? (async () => response("Fix message retries"));
  const context = {
    cwd,
    model: { provider: "active", id: "conversation-model" },
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      find(provider: string, modelId: string) {
        findCalls++;
        return provider === "test" && modelId === "title-model" ? model : undefined;
      },
      async complete(selectedModel: unknown, completionContext: any, completionOptions: any) {
        completeCalls++;
        prompt = completionContext.messages[0].content[0].text;
        return complete(selectedModel, completionContext, completionOptions);
      },
    },
    ui: {
      notify(messageText: string, level: string) {
        notifications.push({ message: messageText, level });
      },
    },
  };

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      commands.set(name, definition.handler);
    },
    getSessionName() {
      return sessionName;
    },
    setSessionName(value: string) {
      sessionName = value;
    },
  };

  createSessionAutonameExtension({ getAgentDir: () => agentDir })(pi as any);

  return {
    agentDir,
    cwd,
    context,
    notifications,
    setBranch(value: unknown[]) {
      branch = value;
    },
    setName(value: string | undefined) {
      sessionName = value;
    },
    get name() {
      return sessionName;
    },
    get completeCalls() {
      return completeCalls;
    },
    get findCalls() {
      return findCalls;
    },
    get prompt() {
      return prompt;
    },
    emit(event: string) {
      return handlers.get(event)?.({}, context);
    },
    command(args: string) {
      const command = commands.get("autoname");
      assert.ok(command);
      return command(args, context);
    },
  };
}

const firstExchange = [
  message("user", "Implement AIR-4933 retry handling"),
  message("assistant", "Implemented resilient message retries"),
];

test("automatic naming starts only after the first settled event and does not block it", async (t) => {
  let resolveCompletion!: (value: unknown) => void;
  const completion = new Promise<unknown>((resolve) => {
    resolveCompletion = resolve;
  });
  const app = harness(t, {
    config: { model: "test/title-model" },
    complete: async () => completion,
  });

  app.emit("session_start");
  app.setBranch(firstExchange);
  assert.equal(app.emit("agent_end"), undefined);
  assert.equal(app.completeCalls, 0);

  assert.equal(app.emit("agent_settled"), undefined);
  assert.equal(app.completeCalls, 1);
  assert.equal(app.name, undefined);

  resolveCompletion(response("Improve retry handling"));
  await flush();
  assert.equal(app.name, "AIR-4933: Improve retry handling");

  app.emit("agent_settled");
  await flush();
  assert.equal(app.completeCalls, 1);
});

test("automatic naming does not use the active model when no dedicated model is configured", (t) => {
  const app = harness(t);
  app.emit("session_start");
  app.setBranch(firstExchange);
  app.emit("agent_settled");

  assert.equal(app.findCalls, 0);
  assert.equal(app.completeCalls, 0);
  assert.equal(app.name, undefined);
});

test("resumed and already named sessions are not automatically renamed", async (t) => {
  const resumed = harness(t, { config: { model: "test/title-model" } });
  resumed.setBranch(firstExchange);
  resumed.emit("session_start");
  resumed.emit("agent_settled");

  const named = harness(t, {
    config: { model: "test/title-model" },
    initialName: "Manual name",
  });
  named.emit("session_start");
  named.setBranch(firstExchange);
  named.emit("agent_settled");
  await flush();

  assert.equal(resumed.completeCalls, 0);
  assert.equal(named.completeCalls, 0);
  assert.equal(named.name, "Manual name");
});

test("manual regeneration always uses the original completed exchange", async (t) => {
  const app = harness(t, {
    config: { model: "test/title-model" },
    initialName: "Old name",
  });
  app.setBranch([
    ...firstExchange,
    message("user", "Thanks, now do a tiny unrelated follow-up"),
    message("assistant", "Done"),
  ]);
  app.emit("session_start");

  await app.command("");

  assert.equal(app.name, "AIR-4933: Fix message retries");
  assert.match(app.prompt, /Implement AIR-4933 retry handling/);
  assert.match(app.prompt, /Implemented resilient message retries/);
  assert.doesNotMatch(app.prompt, /tiny unrelated follow-up/);
});

test("a manual name added during automatic generation wins", async (t) => {
  let resolveCompletion!: (value: unknown) => void;
  const app = harness(t, {
    config: { model: "test/title-model" },
    complete: () =>
      new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
  });
  app.emit("session_start");
  app.setBranch(firstExchange);
  app.emit("agent_settled");
  app.setName("User-owned name");

  resolveCompletion(response("Late automatic title"));
  await flush();

  assert.equal(app.name, "User-owned name");
});

test("late responses from a previous session are discarded", async (t) => {
  let resolveCompletion!: (value: unknown) => void;
  const app = harness(t, {
    config: { model: "test/title-model" },
    complete: () =>
      new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
  });
  app.emit("session_start");
  app.setBranch(firstExchange);
  app.emit("agent_settled");

  app.setBranch([]);
  app.emit("session_start");
  resolveCompletion(response("Stale title"));
  await flush();

  assert.equal(app.name, undefined);
});

test("failed manual generation preserves the existing name", async (t) => {
  const app = harness(t, {
    config: { model: "test/title-model" },
    initialName: "Keep me",
    complete: async () => {
      throw new Error("provider unavailable");
    },
  });
  app.setBranch(firstExchange);
  app.emit("session_start");

  await app.command("");

  assert.equal(app.name, "Keep me");
  assert.match(app.notifications.at(-1)?.message ?? "", /provider unavailable/);
});

test("model configuration commands persist global and project settings", async (t) => {
  const app = harness(t);
  app.emit("session_start");

  await app.command("model test/title-model");
  await app.command("model openrouter/vendor/title --local");

  const statusBeforeReset = app.notifications.at(-1)?.message ?? "";
  assert.match(statusBeforeReset, /openrouter\/vendor\/title/);

  await app.command("model reset --local");
  await app.command("status");
  assert.match(app.notifications.at(-1)?.message ?? "", /test\/title-model \(available\)/);
});
