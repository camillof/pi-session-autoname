import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getConfigPaths,
  loadConfig,
  parseModelReference,
  persistModelSetting,
} from "../src/config.ts";

function fixture(t: test.TestContext): { root: string; agentDir: string; cwd: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-session-autoname-config-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, agentDir, cwd };
}

test("project configuration overrides global configuration", (t) => {
  const { agentDir, cwd } = fixture(t);
  const paths = getConfigPaths(agentDir, cwd);
  writeFileSync(
    paths.global,
    JSON.stringify({ model: "anthropic/claude-haiku", timeoutMs: 12_000, debug: true }),
  );
  writeFileSync(paths.project, JSON.stringify({ model: "openrouter/vendor/model", debug: false }));

  const snapshot = loadConfig(agentDir, cwd);

  assert.deepEqual(snapshot.config, {
    enabled: true,
    model: "openrouter/vendor/model",
    timeoutMs: 12_000,
    debug: false,
  });
  assert.deepEqual(snapshot.present, { global: true, project: true });
  assert.deepEqual(snapshot.warnings, []);
});

test("invalid fields fall back independently and produce warnings", (t) => {
  const { agentDir, cwd } = fixture(t);
  const paths = getConfigPaths(agentDir, cwd);
  writeFileSync(
    paths.global,
    JSON.stringify({ enabled: "yes", model: "missing-slash", timeoutMs: 10, debug: 1 }),
  );

  const snapshot = loadConfig(agentDir, cwd);

  assert.deepEqual(snapshot.config, {
    enabled: true,
    model: null,
    timeoutMs: 10_000,
    debug: false,
  });
  assert.equal(snapshot.warnings.length, 4);
});

test("malformed project JSON does not discard valid global configuration", (t) => {
  const { agentDir, cwd } = fixture(t);
  const paths = getConfigPaths(agentDir, cwd);
  writeFileSync(paths.global, JSON.stringify({ model: "google/gemini-flash" }));
  writeFileSync(paths.project, "{");

  const snapshot = loadConfig(agentDir, cwd);

  assert.equal(snapshot.config.model, "google/gemini-flash");
  assert.equal(snapshot.warnings.length, 1);
  assert.match(snapshot.warnings[0], /session-autoname\.json/);
});

test("model references split only at the first slash", () => {
  assert.deepEqual(parseModelReference("openrouter/anthropic/claude-haiku"), {
    provider: "openrouter",
    modelId: "anthropic/claude-haiku",
  });
  assert.equal(parseModelReference("missing-provider"), null);
  assert.equal(parseModelReference("/missing"), null);
  assert.equal(parseModelReference("provider/"), null);
});

test("persistModelSetting preserves other fields and supports reset", (t) => {
  const { agentDir, cwd } = fixture(t);
  const filePath = getConfigPaths(agentDir, cwd).project;
  writeFileSync(filePath, `${JSON.stringify({ enabled: false, debug: true })}\n`);

  persistModelSetting(filePath, "openai/gpt-title");
  assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), {
    enabled: false,
    debug: true,
    model: "openai/gpt-title",
  });

  persistModelSetting(filePath, undefined);
  assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), {
    enabled: false,
    debug: true,
  });
});
