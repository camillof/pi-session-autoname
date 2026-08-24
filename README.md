# pi-session-autoname

Automatically give a new [Pi](https://github.com/earendil-works/pi) session a short,
searchable name after its first completed exchange.

The extension uses a dedicated model that you explicitly configure. It never falls
back to the active conversation model, never periodically renames a session, and has
no installed runtime dependencies.

## Features

- Runs once after Pi's first `agent_settled` event.
- Uses the original first user message and final assistant response, excluding tool output.
- Produces a title of at most 48 Unicode characters.
- Preserves names set with `/name`, `--name`, or another extension.
- Prefixes Linear-style references, for example `AIR-4933: Fix message retries`.
- Recognizes both plain keys and `linear.app/<workspace>/issue/<key>` URLs.
- Redacts common credentials before sending the excerpt to the naming provider.
- Provides global and project-specific model configuration through `/autoname`.

## Requirements

- Pi 0.84 or newer.
- Node.js 22.6 or newer.
- A dedicated naming model available in Pi's model registry, with its provider authenticated.

## Install

From npm:

```bash
pi install npm:@camillof/pi-session-autoname
```

Try a local checkout without installing it:

```bash
pi -e .
```

After installing or changing the extension, restart Pi or run `/reload`.

## Configure the naming model

No model is selected by default. Configure one globally:

```text
/autoname model anthropic/claude-haiku-4-5
```

Or configure a model only for the current project:

```text
/autoname model openrouter/anthropic/claude-haiku --local
```

Only the first slash separates the provider from the model ID, so model IDs may
contain additional slashes.

Configuration can also be written directly as JSON. Global configuration lives at
`<agent-dir>/session-autoname.json`; project configuration lives at
`<project>/.pi/session-autoname.json` and takes precedence.

```json
{
  "enabled": true,
  "model": "anthropic/claude-haiku-4-5",
  "timeoutMs": 10000,
  "debug": false
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enables the one automatic naming attempt. Manual `/autoname` still works when false. |
| `model` | `null` | Required dedicated model in `provider/model-id` form. |
| `timeoutMs` | `10000` | Request timeout, accepted range 1,000–60,000 ms. |
| `debug` | `false` | Shows otherwise silent automatic naming failures. |

## Commands

| Command | Behavior |
| --- | --- |
| `/autoname` | Regenerate from the original first exchange and replace the current name on success. |
| `/autoname status` | Show effective configuration, model availability, paths, and warnings. |
| `/autoname model <provider/model-id>` | Set the global naming model. |
| `/autoname model <provider/model-id> --local` | Set the project naming model. |
| `/autoname model reset [--local]` | Remove the model override at that scope. |

Use Pi's built-in `/name <text>` command when you want to write a custom name rather
than regenerate the title from the original exchange.

## Naming behavior

The automatic attempt is eligible only for a brand-new, unnamed session. After the
first exchange fully settles, the extension sends at most 4,000 characters from the
first user message and final assistant response to the configured naming model. Tool
calls and tool results are excluded.

If the original exchange contains `AIR-4933` or a matching Linear issue URL, the
extension deterministically prefixes the result with `AIR-4933: `. The prefix counts
toward the 48-character limit. Model output is normalized to one line and stripped of
Markdown, labels, control characters, duplicate ticket keys, and trailing periods.

Missing configuration, unavailable credentials, timeouts, provider failures, and
invalid responses leave the session unchanged. Automatic failures are silent unless
`debug` is enabled; manual failures are shown in the UI.

## Privacy

The configured model may belong to a different provider than the conversation model.
Before sending the excerpt, the extension redacts common bearer tokens, API keys, AWS
access keys, private keys, and environment variables whose names end in `TOKEN`,
`SECRET`, `PASSWORD`, `API_KEY`, or `PRIVATE_KEY`.

Redaction is best-effort, not a substitute for avoiding secrets in prompts. Review the
configured provider's data-handling policy before using it with sensitive sessions.

## Development

Pi loads the TypeScript source directly; there is no build step.

```bash
npm test
npm run pack:check
pi -e .
```

Tests use Node's built-in test runner and TypeScript stripping. The package declares Pi
as a peer dependency for API compatibility and type information but installs no copy
of Pi and bundles no dependencies.

## License

MIT
