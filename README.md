# opencode-auto-router

An [OpenCode](https://opencode.ai) plugin that makes **Synthetic** your primary
provider and fails over to **OpenRouter's Auto Router** when Synthetic rate-limits.

- **Primary:** Synthetic's permanent `syn:*` category aliases
  (`syn:large:text`, `syn:small:text`, `syn:large:vision`, `syn:small:vision`).
  Synthetic rotates the underlying model; the alias stays put, so nothing is
  pinned by hand.
- **Failover:** `openrouter/openrouter/auto`, driven by the same
  `~<lab>/<model>-latest` alias workflow this project started with. On a
  retryable Synthetic failure the plugin switches the session to the Auto
  Router and re-sends your turn.

No manual model switching. No version pinning. Automatic recovery on rate limits.

---

## What it does

Two independent jobs ride in one package:

### 1. Registers the Synthetic `syn:*` aliases

Synthetic's `syn:*` aliases are **not** in the public [models.dev](https://models.dev)
catalog, so OpenCode cannot select them out of the box. The plugin discovers them
from Synthetic's OpenAI-compatible `/models` endpoint and registers them (with
context limits, vision capability, reasoning-effort variants, and pricing) as
OpenCode models. Only `syn:*` ids are kept — concrete `hf:*` ids are ignored,
because the point is to never pin a version.

### 2. Registers and drives the OpenRouter Auto Router

The Auto Router accepts an `allowed_models` constraint, **but it only matches
concrete catalog ids.** The `~…-latest` aliases resolve fine as a top-level
`model`, but inside `allowed_models` they match **nothing**. The candidate pool
collapses to zero and every request fails:

```
404  No models match your request and model restrictions
```

Verified against the API:

| `allowed_models` entry                     | Result |
| ------------------------------------------ | ------ |
| `anthropic/*`                              | ✅ 200 |
| `anthropic/claude-sonnet-4.5` (concrete)   | ✅ 200 |
| `~anthropic/claude-sonnet-latest`          | ❌ 404 |
| top-level `model: "~anthropic/claude-sonnet-latest"` | ✅ 200 |

The plugin resolves each alias to its current concrete slug (`alias_target.slug`)
on startup and injects that list into every `openrouter/auto` request, so the
Auto Router keeps working with the alias workflow.

### 3. Fails over automatically

OpenCode does not expose cross-provider failover, and a plugin cannot redirect an
in-flight request — on every session hook the `model` field is readonly. What a
plugin *can* do is observe the failure and drive recovery through the session API:

```
Synthetic request ──► 429 rate limit
        │
        ▼
retry hook         bounds Synthetic retries to one short attempt
        │
        ▼
session.execution.failed (carries the structured error + status)
        │
        ▼
switchModel ──► openrouter/openrouter/auto ──► re-send the last user message
```

Replay safety: a turn is replayed only when the failure is retryable
(status/message match), the session is still on Synthetic, and the failed turn
produced no assistant output and ran no tools. A turn that already did work is
never replayed, so side effects cannot be duplicated. Because a failed fallback
leaves the session on OpenRouter, it cannot loop, and the attempt budget
(default 1) bounds it further.

> [!IMPORTANT]
> **OpenRouter's "Prevent overrides" toggle must be OFF** at
> <https://openrouter.ai/settings/routing> for the Auto Router injection to
> apply. When it is ON, OpenRouter makes your saved account Auto Router values
> final and **ignores request-level settings**, so this plugin (or any client)
> cannot apply its resolved pool. See
> [Troubleshooting](#404-no-models-match-your-request-and-model-restrictions-after-enabling-prevent-overrides).

## Requirements

- **OpenCode 2.x** (V2 plugin API). Failover uses the V2 event stream and
  catalog transforms, which have no V1 equivalent, so the legacy `server()`
  entrypoint is intentionally dropped in 2.0.0.
- **Node 18+**.
- A connected **Synthetic** account (`/connect synthetic`) and, for failover, a
  connected **OpenRouter** account.

## Install

### Option A — from npm

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-auto-router"]
}
```

### Option B — from GitHub (no npm publish required)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:ultus-net/opencode-auto-router"]
}
```

Then connect the providers and restart OpenCode:

```
/connect synthetic
/connect openrouter
```

## Configuration

Defaults work out of the box: Synthetic `syn:large:text` becomes the default
model, `syn:small:text` serves lightweight/title generation, and failover to
`openrouter/openrouter/auto` is on.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-auto-router",
      "options": {
        // Which Synthetic `syn:*` aliases to expose. Default: all of them.
        "syntheticModels": [
          "syn:large:text",
          "syn:small:text",
          "syn:large:vision",
          "syn:small:vision"
        ],

        // Primary / small Synthetic models (used only when setDefaultModel /
        // setSmallModel are on). Defaults shown.
        "primaryModel": "syn:large:text",
        "smallModel": "syn:small:text",

        // Default true: set the default model when none is configured.
        "setDefaultModel": true,
        // Default false: also override an explicitly configured model.
        "forceDefaultModel": false,
        // Default true: set the built-in `title` agent to `smallModel`.
        "setSmallModel": true,

        // OpenRouter Auto Router pool: any aliases; ones with no live target
        // are skipped. Defaults to the built-in frontier list.
        "aliases": [
          "~anthropic/claude-opus-latest",
          "~anthropic/claude-sonnet-latest",
          "~openai/gpt-astra-latest",
          "~google/gemini-pro-latest",
          "~x-ai/grok-latest",
          "~deepseek/deepseek-pro-latest"
        ],
        // Cost band: "low" | "medium" | "high" | "xhigh" | "max".
        // Omit to use your account's saved Auto Router cost preference.
        "costTier": "high",

        // Failover behavior.
        "failover": {
          // Default true.
          "enabled": true,
          // HTTP statuses that trigger failover. Add 500/502/503 for outages.
          "statuses": [429],
          // Fallback message heuristics for providers that omit a status.
          "messageMatches": ["rate limit", "quota", "overloaded"],
          // Max automatic cross-provider failovers per user turn.
          "maxAttempts": 1
        }
      }
    }
  ]
}
```

## How it works

```
Setup
  ├─ discover Synthetic syn:* aliases  (api.synthetic.new/openai/v1/models)
  ├─ register syn:* models + openrouter/auto
  ├─ set default model / title model
  └─ warm OpenRouter ~…-latest pool

Request (Synthetic)
  └─ syn:large:text ──► Synthetic

On retryable failure
  ├─ retry hook bounds Synthetic retries
  ├─ session.execution.failed (error.status / error.message)
  └─ switchModel ──► openrouter/openrouter/auto
                     └─ ~…-latest resolved to concrete slugs
                        injected as allowed_models
```

A real captured Auto Router request body:

```json
{
  "model": "openrouter/auto",
  "plugins": [
    {
      "id": "auto-router",
      "allowed_models": [
        "anthropic/claude-opus-5",
        "anthropic/claude-sonnet-5",
        "openai/gpt-6-astra",
        "google/gemini-3.8-flash",
        "x-ai/grok-4.6",
        "deepseek/deepseek-v4-pro-0813"
      ]
    }
  ],
  "stream": true
}
```

Catalogs are cached in memory and on disk for 6 hours, so restarts and brief
network blips don't break routing:

- Synthetic: `~/.cache/opencode/auto-router-synthetic.json`
- Set `OPENCODE_AUTO_ROUTER_DEBUG=1` for verbose logging.

## Development

TypeScript, compiled to `dist/`.

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm test            # compile tests, run node:test
```

Source layout:

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Plugin entrypoint; wires registration, defaults, injection, failover |
| `src/synthetic.ts` | Synthetic `syn:*` catalog discovery and mapping |
| `src/openrouter.ts` | `~…-latest` alias → concrete slug resolution |
| `src/state.ts` | Memoized catalogs with disk fallback |
| `src/models.ts` | Pure catalog → OpenCode `Model.Info` mapping |
| `src/failover.ts` | Retryable-error decision + cross-provider controller |
| `src/config.ts` | Option normalization and defaults |

## Verify it's working

```bash
# Primary path
opencode run --model synthetic/syn:large:text "reply with exactly: it works"

# Failover target (Auto Router with the resolved pool)
opencode run --model openrouter/openrouter/auto "reply with exactly: it works"
```

With `OPENCODE_AUTO_ROUTER_DEBUG=1`, a rate-limit failover logs:

```
[auto-router] failing over ses_… to openrouter/openrouter/auto
```

## Troubleshooting

### `404 No models match your request and model restrictions` after enabling "Prevent overrides"

OpenRouter's **Prevent overrides** toggle
(<https://openrouter.ai/settings/routing>) makes your **saved** Auto Router
values final and causes per-request settings — including this plugin's — to be
ignored. If the saved allowlist is unhealthy (for example it contains
`~…-latest` aliases, which the router cannot resolve), then every request 404s
and **no client-side plugin can fix it**. This is by OpenRouter's design, not a
bug in this plugin.

Pick one:

- **Turn Prevent overrides off.** Then this plugin's per-request allowlist
  applies again — the intended setup.
- **Or fix the saved allowlist itself.** Remove any `~…-latest` aliases; use
  wildcards (`anthropic/*`) or concrete slugs (`anthropic/claude-sonnet-4.5`).

### Synthetic models don't appear in `/models`

The Synthetic provider must be connected before the plugin can register models.
Run `/connect synthetic`, then restart OpenCode. The plugin only augments a
provider that is already present, so it never invents or overwrites provider
settings.

### Failover didn't happen

- Did the error match `failover.statuses` (default `[429]`) or
  `failover.messageMatches`? Outages (5xx) need to be added explicitly.
- Did the failed turn already run tools or produce output? Such a turn is not
  replayed, to avoid duplicating side effects.
- Was the session still on Synthetic? A failure after failover does not fail
  over again.
- Is `failover.enabled` still true?

## FAQ & caveats

**Does failover replay my turn?**
Only after a retryable failure, only when the session is still on Synthetic, and
only when the failed turn produced no assistant output and ran no tools. A turn
that already did work is left as-is (no replay), so there are no side effects to
duplicate.

**Does this replace my account's Auto Router settings?**
Only the `allowed_models` field, per request. Your saved `excluded_models` and
cost preference still apply — as long as **Prevent overrides** is off.

**Does it add latency?**
No per-request network cost: both catalogs are resolved at startup and cached
for 6 hours (with a disk fallback).

**What about privacy / keys?**
The plugin never reads your API keys. It calls Synthetic's and OpenRouter's
public `/models` endpoints (no key) and mutates the request OpenCode was already
sending. It sends nothing anywhere else.

**Does it work with `openrouter/auto-beta`?**
Not by default — `auto-beta` reads a different plugin id (`auto-beta-router`)
and settings. Open an issue if you want it supported.

## Uninstall

```bash
# Remove the "plugins" entry from your opencode config, or the drop-in file:
rm ~/.config/opencode/plugins/opencode-auto-router.js
```

## License

[MIT](./LICENSE)
