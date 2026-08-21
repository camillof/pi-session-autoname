import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface SessionAutonameConfig {
  enabled: boolean;
  model: string | null;
  timeoutMs: number;
  debug: boolean;
}

export interface ConfigPaths {
  global: string;
  project: string;
}

export interface ConfigSnapshot {
  config: SessionAutonameConfig;
  paths: ConfigPaths;
  present: {
    global: boolean;
    project: boolean;
  };
  warnings: string[];
}

export interface ModelReference {
  provider: string;
  modelId: string;
}

export const DEFAULT_CONFIG: Readonly<SessionAutonameConfig> = Object.freeze({
  enabled: true,
  model: null,
  timeoutMs: 10_000,
  debug: false,
});

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseModelReference(value: string): ModelReference | null {
  const reference = value.trim();
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return null;

  const provider = reference.slice(0, separator).trim();
  const modelId = reference.slice(separator + 1).trim();
  if (!provider || !modelId || /\s/.test(provider) || /\s/.test(modelId)) return null;
  return { provider, modelId };
}

export function getConfigPaths(agentDir: string, cwd: string): ConfigPaths {
  return {
    global: path.join(agentDir, "session-autoname.json"),
    project: path.join(cwd, ".pi", "session-autoname.json"),
  };
}

function readConfigObject(filePath: string, warnings: string[]): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;

  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isRecord(parsed)) {
      warnings.push(`${filePath}: configuration must be a JSON object`);
      return null;
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${filePath}: ${message}`);
    return null;
  }
}

function applyConfig(
  target: SessionAutonameConfig,
  input: Record<string, unknown> | null,
  source: string,
  warnings: string[],
): void {
  if (!input) return;

  if ("enabled" in input) {
    if (typeof input.enabled === "boolean") target.enabled = input.enabled;
    else warnings.push(`${source}: "enabled" must be a boolean`);
  }

  if ("model" in input) {
    if (input.model === null) target.model = null;
    else if (typeof input.model === "string" && parseModelReference(input.model)) {
      target.model = input.model.trim();
    } else {
      warnings.push(`${source}: "model" must be null or "provider/model-id"`);
    }
  }

  if ("timeoutMs" in input) {
    if (
      typeof input.timeoutMs === "number" &&
      Number.isInteger(input.timeoutMs) &&
      input.timeoutMs >= MIN_TIMEOUT_MS &&
      input.timeoutMs <= MAX_TIMEOUT_MS
    ) {
      target.timeoutMs = input.timeoutMs;
    } else {
      warnings.push(
        `${source}: "timeoutMs" must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      );
    }
  }

  if ("debug" in input) {
    if (typeof input.debug === "boolean") target.debug = input.debug;
    else warnings.push(`${source}: "debug" must be a boolean`);
  }
}

export function loadConfig(agentDir: string, cwd: string): ConfigSnapshot {
  const paths = getConfigPaths(agentDir, cwd);
  const warnings: string[] = [];
  const config: SessionAutonameConfig = { ...DEFAULT_CONFIG };
  const globalConfig = readConfigObject(paths.global, warnings);
  const projectConfig = readConfigObject(paths.project, warnings);

  applyConfig(config, globalConfig, paths.global, warnings);
  applyConfig(config, projectConfig, paths.project, warnings);

  return {
    config,
    paths,
    present: {
      global: existsSync(paths.global),
      project: existsSync(paths.project),
    },
    warnings,
  };
}

function readWritableConfig(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};

  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${filePath}: configuration must be a JSON object`);
  return parsed;
}

function writeJsonAtomically(filePath: string, value: Record<string, unknown>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

export function persistModelSetting(filePath: string, model: string | undefined): void {
  if (model !== undefined && !parseModelReference(model)) {
    throw new Error("Model must use the form provider/model-id");
  }

  const config = readWritableConfig(filePath);
  if (model === undefined) delete config.model;
  else config.model = model.trim();
  writeJsonAtomically(filePath, config);
}
