import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  getConfigPaths,
  loadConfig,
  parseModelReference,
  persistModelSetting,
  type ConfigSnapshot,
  type SessionAutonameConfig,
} from "./config.ts";
import {
  buildNamingPrompt,
  composeTitle,
  extractFirstExchange,
  extractResponseText,
  findTicketReference,
  hasUserMessage,
  redactSecrets,
  type FirstExchange,
} from "./naming.ts";

export interface ExtensionDependencies {
  getAgentDir(): string;
}

class NamingError extends Error {}

function errorMessage(error: unknown): string {
  if (error instanceof NamingError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "Naming request was cancelled";
  return error instanceof Error ? error.message : String(error);
}

function modelStatus(snapshot: ConfigSnapshot, ctx: ExtensionContext): string[] {
  const reference = snapshot.config.model;
  if (!reference) {
    return [
      "Model: not configured",
      "Catalog: not checked",
      "Provider authentication: not checked",
      "Status: not ready",
    ];
  }
  const parsed = parseModelReference(reference);
  if (!parsed) {
    return [
      `Model: ${reference}`,
      "Catalog: invalid reference",
      "Provider authentication: not checked",
      "Status: not ready",
    ];
  }

  const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
  if (!model) {
    return [
      `Model: ${reference}`,
      "Catalog: not found",
      "Provider authentication: not checked",
      "Status: not ready",
    ];
  }

  const authenticated = ctx.modelRegistry.hasConfiguredAuth(model);
  return [
    `Model: ${reference}`,
    "Catalog: found",
    `Provider authentication: ${authenticated ? "configured" : "not configured"}`,
    `Status: ${authenticated ? "ready" : "not ready"}`,
  ];
}

function completionFailure(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const candidate = response as { stopReason?: unknown; errorMessage?: unknown };
  if (candidate.stopReason !== "error" && candidate.stopReason !== "aborted") return null;

  if (typeof candidate.errorMessage === "string" && candidate.errorMessage.trim()) {
    const safeMessage = redactSecrets(candidate.errorMessage)
      .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    if (safeMessage) return `Naming model failed: ${safeMessage}`;
  }

  return candidate.stopReason === "aborted"
    ? "Naming model request was aborted"
    : "Naming model request failed";
}

export function createSessionAutonameExtension(dependencies: ExtensionDependencies) {
  return function sessionAutoname(pi: ExtensionAPI): void {
    let sessionGeneration = 0;
    let requestGeneration = 0;
    let autoEligible = false;
    let autoAttempted = false;
    let autoSucceeded = false;
    let activeController: AbortController | null = null;

    const refreshConfig = (cwd: string): ConfigSnapshot => {
      return loadConfig(dependencies.getAgentDir(), cwd);
    };

    const abortActiveRequest = (): void => {
      if (activeController && !activeController.signal.aborted) {
        activeController.abort(new DOMException("Superseded", "AbortError"));
      }
      activeController = null;
      requestGeneration++;
    };

    const generateTitle = async (
      exchange: FirstExchange,
      ctx: ExtensionContext,
      config: SessionAutonameConfig,
      controller: AbortController,
    ): Promise<string> => {
      if (!config.model) {
        throw new NamingError("No naming model configured. Use /autoname model provider/model-id");
      }

      const reference = parseModelReference(config.model);
      if (!reference) throw new NamingError("Configured naming model is invalid");
      const model = ctx.modelRegistry.find(reference.provider, reference.modelId);
      if (!model) throw new NamingError(`Naming model not found: ${config.model}`);
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        throw new NamingError(`Naming provider is not authenticated: ${reference.provider}`);
      }

      const timer = setTimeout(() => {
        controller.abort(new DOMException("Naming request timed out", "TimeoutError"));
      }, config.timeoutMs);
      timer.unref();

      try {
        const response = await ctx.modelRegistry.complete(
          model,
          {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: buildNamingPrompt(exchange) }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            maxTokens: 64,
            signal: controller.signal,
            cacheRetention: "none",
          },
        );

        const failure = completionFailure(response);
        if (failure) throw new NamingError(failure);

        const output = extractResponseText(response);
        if (!output) {
          const stopReason =
            typeof response === "object" && response !== null
              ? (response as { stopReason?: unknown }).stopReason
              : undefined;
          throw new NamingError(
            stopReason === "length"
              ? "Naming model returned no title before reaching its output limit"
              : "Naming model returned no text",
          );
        }

        const title = composeTitle(output, findTicketReference(exchange));
        if (!title) throw new NamingError("Naming model returned an invalid title");
        return title;
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason instanceof Error) {
          throw controller.signal.reason;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };

    const debugNotify = (ctx: ExtensionContext, config: SessionAutonameConfig, message: string): void => {
      if (config.debug) ctx.ui.notify(`Session autoname: ${message}`, "warning");
    };

    pi.on("session_start", (_event, ctx) => {
      abortActiveRequest();
      sessionGeneration++;
      autoAttempted = false;
      autoSucceeded = false;
      refreshConfig(ctx.cwd);

      const entries = ctx.sessionManager.getBranch();
      autoEligible = !hasUserMessage(entries) && !pi.getSessionName();
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (!autoEligible || autoAttempted || autoSucceeded || pi.getSessionName()) return;
      autoAttempted = true;

      const current = refreshConfig(ctx.cwd);
      if (!current.config.enabled || !current.config.model) {
        debugNotify(
          ctx,
          current.config,
          current.config.enabled ? "no naming model configured" : "automatic naming is disabled",
        );
        return;
      }

      const exchange = extractFirstExchange(ctx.sessionManager.getBranch());
      if (!exchange) {
        debugNotify(ctx, current.config, "the first completed exchange could not be found");
        return;
      }

      abortActiveRequest();
      const controller = new AbortController();
      activeController = controller;
      const requestToken = requestGeneration;
      const sessionToken = sessionGeneration;

      void generateTitle(exchange, ctx, current.config, controller)
        .then((title) => {
          if (
            sessionToken !== sessionGeneration ||
            requestToken !== requestGeneration ||
            controller.signal.aborted ||
            autoSucceeded ||
            pi.getSessionName()
          ) {
            return;
          }
          pi.setSessionName(title);
          autoSucceeded = true;
        })
        .catch((error) => {
          const reason = controller.signal.reason;
          if (
            !controller.signal.aborted ||
            (reason instanceof Error && reason.name === "TimeoutError")
          ) {
            debugNotify(ctx, current.config, errorMessage(error));
          }
        })
        .finally(() => {
          if (activeController === controller) activeController = null;
        });
    });

    pi.registerCommand("autoname", {
      description: "Regenerate the session name or configure its dedicated model",
      handler: async (args, ctx) => {
        const tokens = args.trim() ? args.trim().split(/\s+/) : [];
        const action = tokens[0]?.toLowerCase();

        if (action === "status") {
          const current = refreshConfig(ctx.cwd);
          const lines = [
            `Automatic naming: ${current.config.enabled ? "enabled" : "disabled"}`,
            ...modelStatus(current, ctx),
            `Timeout: ${current.config.timeoutMs}ms`,
            `Global config: ${current.paths.global}${current.present.global ? "" : " (not found)"}`,
            `Project config: ${current.paths.project}${current.present.project ? "" : " (not found)"}`,
          ];
          if (current.warnings.length) lines.push(`Warnings:\n- ${current.warnings.join("\n- ")}`);
          ctx.ui.notify(lines.join("\n"), current.warnings.length ? "warning" : "info");
          return;
        }

        if (action === "model") {
          const local = tokens.includes("--local");
          const values = tokens.slice(1).filter((token) => token !== "--local");
          if (values.length !== 1) {
            ctx.ui.notify(
              "Usage: /autoname model <provider/model-id|reset> [--local]",
              "warning",
            );
            return;
          }

          const value = values[0];
          let authenticated = false;
          if (value !== "reset") {
            const reference = parseModelReference(value);
            if (!reference) {
              ctx.ui.notify("Model must use the form provider/model-id", "warning");
              return;
            }

            const configuredModel = ctx.modelRegistry.find(reference.provider, reference.modelId);
            if (!configuredModel) {
              ctx.ui.notify(`Naming model not found: ${value}`, "warning");
              return;
            }
            authenticated = ctx.modelRegistry.hasConfiguredAuth(configuredModel);
          }

          const paths = getConfigPaths(dependencies.getAgentDir(), ctx.cwd);
          const target = local ? paths.project : paths.global;
          try {
            persistModelSetting(target, value === "reset" ? undefined : value);
            const current = refreshConfig(ctx.cwd);
            const scope = local ? "project" : "global";
            ctx.ui.notify(
              value === "reset"
                ? `Reset ${scope} naming model; effective model is ${current.config.model ?? "not configured"}`
                : authenticated
                  ? `Set ${scope} naming model to ${value}`
                  : `Set ${scope} naming model to ${value}; provider is not authenticated`,
              value !== "reset" && !authenticated ? "warning" : "info",
            );
          } catch (error) {
            ctx.ui.notify(`Could not update configuration: ${errorMessage(error)}`, "error");
          }
          return;
        }

        if (tokens.length > 0) {
          ctx.ui.notify("Usage: /autoname [status|model ...]", "warning");
          return;
        }

        const current = refreshConfig(ctx.cwd);
        if (!current.config.model) {
          ctx.ui.notify(
            "No naming model configured. Use /autoname model provider/model-id",
            "warning",
          );
          return;
        }

        const exchange = extractFirstExchange(ctx.sessionManager.getBranch());
        if (!exchange) {
          ctx.ui.notify("The first completed user/assistant exchange could not be found", "warning");
          return;
        }

        abortActiveRequest();
        const controller = new AbortController();
        activeController = controller;
        const requestToken = requestGeneration;
        const sessionToken = sessionGeneration;

        try {
          const title = await generateTitle(exchange, ctx, current.config, controller);
          if (
            sessionToken !== sessionGeneration ||
            requestToken !== requestGeneration ||
            controller.signal.aborted
          ) {
            return;
          }
          pi.setSessionName(title);
          autoSucceeded = true;
          ctx.ui.notify(`Session named: ${title}`, "info");
        } catch (error) {
          if (!controller.signal.aborted || controller.signal.reason?.name === "TimeoutError") {
            ctx.ui.notify(`Could not name session: ${errorMessage(error)}`, "error");
          }
        } finally {
          if (activeController === controller) activeController = null;
        }
      },
    });
  };
}
