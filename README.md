# opencode-openrouter-auto-latest

An [OpenCode](https://opencode.ai) plugin that lets you drive OpenRouter's
**Auto Router** with the `~<lab>/<model>-latest` aliases — so you always route
across the newest frontier models without ever pinning a version by hand.

```jsonc
// What you want (and what this plugin makes work):
"plugins": [{ "id": "auto-router", "allowed_models": ["~anthropic/claude-sonnet-latest", "~openai/gpt-latest", "..."] }]
```

<p align="center"><em>No manual model switching. No version pinning. Cost-aware routing across current frontier models.</em></p>

---

## The goal

Two ideas combine nicely:

1. **`~…-latest` aliases.** OpenRouter publishes aliases like
   `~anthropic/claude-sonnet-latest` that always point at that lab's newest
   flagship. Use them and you never have to edit config when a new model ships.
2. **The Auto Router (`openrouter/auto`).** Instead of hard-pinning one model,
   OpenRouter classifies each prompt and picks a model from a pool based on
   real-world usage and a cost band. You get "best model for this task,
   at the cost level I chose."

Put them together and the intent is:

> "Route my work across the *current* frontier models — whatever they happen to
> be this week — and pick cost-effectively per request."

That is exactly the setup this plugin enables.

## The wall

OpenRouter's Auto Router accepts an `allowed_models` constraint, **but it only
matches concrete catalog IDs.** The `~…-latest` aliases resolve fine as a
top-level `model`, but inside `allowed_models` they match **nothing**. The
candidate pool collapses to zero and every request fails:

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

So the alias works as a model, but not as a router constraint. This is a nasty
footgun because the [OpenRouter × OpenCode integration
guide](https://openrouter.ai/docs/cookbook/coding-agents/opencode-integration)
recommends exactly those `~…-latest` aliases.

## What this plugin does

It keeps the `~…-latest` workflow and makes the Auto Router accept it:

1. On startup (and at most every 6 hours) it reads OpenRouter's public model
   catalog and maps each `~…-latest` alias to the **concrete slug** it currently
   points at (`alias_target.slug`).
2. On every request to `openrouter/auto` it injects that resolved, concrete list
   as the Auto Router's `allowed_models` via OpenCode's `chat.params` hook.
3. The per-request list overrides the saved account-level allowlist
   (as long as **Prevent overrides** is off — the default), so this works even
   when your account's Auto Router settings are broken.
4. It also makes `openrouter/auto` your OpenCode default model when you have not
   configured one, so a fresh install "just works" without editing config.

You keep writing `~…-latest`. The plugin keeps translating it into what the
router actually understands.

> [!IMPORTANT]
> **OpenRouter's "Prevent overrides" toggle must be OFF** at
> <https://openrouter.ai/settings/routing>. When it is ON, OpenRouter makes your
> saved account Auto Router values final and **ignores request-level settings**,
> so this plugin (or any client) cannot apply its resolved pool. See
> [Troubleshooting](#404-no-models-match-your-request-and-model-restrictions-after-enabling-prevent-overrides).

## Install

Requires **OpenCode ≥ 1.18** and Node 18+.

### Option A — drop-in file (simplest)

Copy `index.js` into your OpenCode plugin directory. It is auto-discovered; no
config change needed.

```bash
mkdir -p ~/.config/opencode/plugin
curl -fsSL https://raw.githubusercontent.com/ultus-net/opencode-openrouter-auto-latest/main/index.js \
  -o ~/.config/opencode/plugin/openrouter-auto-latest.js
```

Restart OpenCode. Done.

### Option B — reference it in config

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-openrouter-auto-latest"]
}
```

### Option C — from GitHub (no npm publish required)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:ultus-net/opencode-openrouter-auto-latest"]
}
```

Then make sure `openrouter/auto` is your model — either select it in the TUI, let
the plugin set it as your default (see below), or set it explicitly:

```jsonc
{
  "model": "openrouter/openrouter/auto"
}
```

> Note the doubled `openrouter/`: OpenCode model IDs are
> `provider_id/model_id`, and the OpenRouter model is named `openrouter/auto`.

## Make the Auto Router your default model

The plugin already does this. When you have **not** configured a `model`
anywhere, it sets OpenCode's default to `openrouter/openrouter/auto` in memory at
startup — no config file edits. This means you install the plugin, restart
OpenCode, and the Auto Router is simply your default.

Rules:

- An explicit `model` in any `opencode.json` / `opencode.jsonc` wins.
- `--model` on the command line always wins.
- To turn it off: set plugin option `setDefaultModel: false`.
- To override even an explicit configured model: set `forceDefaultModel: true`.

The plugin does **not** rewrite your config file; it mutates the loaded config
for the session, so nothing is left behind on disk.

## Configure

Defaults work out of the box. To customize, pass plugin options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/openrouter/auto",
  "plugin": [
    [
      "github:ultus-net/opencode-openrouter-auto-latest",
      {
        // Any aliases you like; ones without a current target are skipped.
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

        // Default true: make openrouter/auto the default model when none is set.
        "setDefaultModel": true,
        // Default false: also override an explicitly configured model.
        "forceDefaultModel": false
      }
    ]
  ]
}
```

If you installed with **Option A**, edit the `DEFAULT_ALIASES` and
`DEFAULT_COST_TIER` constants at the top of
`~/.config/opencode/plugin/openrouter-auto-latest.js` instead.

### Default pool

The default set covers current frontier families across Anthropic, OpenAI,
Google, xAI, DeepSeek, Z.ai, and Moonshot. Any alias with no live target is
silently skipped, so the list is safe to keep as-is as models come and go.

## How it works

```
OpenCode request
      │
      ▼
chat.params hook  ──►  resolve ~aliases from OpenRouter catalog (cached 6h)
      │                        │
      │                        ▼
      │               [ "anthropic/claude-opus-5",
      │                 "openai/gpt-6-astra", ... ]
      ▼
providerOptions.openrouter.plugins = [{ id: "auto-router", allowed_models: [...], cost_tier }]
      │
      ▼
OpenRouter Auto Router picks a concrete model for the prompt + cost band
```

A real captured request body:

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
        "deepseek/deepseek-v4-pro-0813",
        "z-ai/glm-5.3",
        "moonshotai/kimi-k3"
      ]
    }
  ],
  "stream": true
}
```

Results are cached in memory and on disk
(`~/.cache/opencode/openrouter-auto-latest.json`) so restarts and brief network
blips don't break routing.

## Verify it's working

```bash
opencode run --model openrouter/openrouter/auto "reply with exactly: it works"
```

If your account's saved Auto Router allowlist is broken, the bare request fails
with the 404 above while this plugin's request succeeds. You can also confirm
what was sent by checking that the model used is a current flagship — the
Auto Router reports it in the response's `model` field.

## Troubleshooting

### `404 No models match your request and model restrictions` after enabling "Prevent overrides"

OpenRouter's **Prevent overrides** toggle
(<https://openrouter.ai/settings/routing>) makes your **saved** Auto Router
values final and causes per-request settings — including this plugin's — to be
ignored. If the saved allowlist is unhealthy (for example it contains
`~…-latest` aliases, which the router cannot resolve), then every request 404s
and **no client-side plugin can fix it**. This is by OpenRouter's design, not a
bug in this plugin.

Verified with Prevent overrides on:

| Request | Result |
| --- | --- |
| bare `auto` (saved allowlist) | ❌ 404 |
| `allowed_models: ["*/*"]` override | ❌ 404 |
| `allowed_models: ["anthropic/*"]` override | ❌ 404 |
| OpenCode + this plugin | ❌ 404 |

Pick one:

- **Turn Prevent overrides off.** Then this plugin's per-request allowlist
  applies again — this is the intended setup.
- **Or fix the saved allowlist itself** and keep Prevent overrides on. Remove
  any `~…-latest` aliases; use wildcards (`anthropic/*`) or concrete slugs
  (`anthropic/claude-sonnet-4.5`). With a healthy saved list, `openrouter/auto`
  works without any client-side override — and you don't need this plugin.

## FAQ & caveats

**Does this replace my account's Auto Router settings?**
Only the `allowed_models` field, per request. Your saved `excluded_models` and
cost preference still apply. If you turn on **Prevent overrides**
(<https://openrouter.ai/settings/routing>), the saved settings become final,
per-request settings are ignored, and this plugin cannot apply its resolved
list. Leave **Prevent overrides** off to use this plugin.

**I'd rather use the account allowlist directly.**
You can. Just don't put `~…-latest` aliases there; use wildcards (`anthropic/*`)
or concrete slugs. The Auto Router will not resolve aliases in `allowed_models`.

**Does it work with `openrouter/auto-beta`?**
Not by default — `auto-beta` reads a different plugin id (`auto-beta-router`)
and settings. Open an issue if you want it supported.

**Does it add latency?**
No per-request network cost: aliases are resolved at startup and cached for 6
hours (with a disk fallback).

**What about privacy / keys?**
The plugin only calls OpenRouter's public `/models` endpoint (no API key) and
mutates the request OpenCode was already sending to OpenRouter. It sends
nothing anywhere else.

## Uninstall

```bash
rm ~/.config/opencode/plugin/openrouter-auto-latest.js
# or remove the entry from "plugin" in your opencode config
```

## License

[MIT](./LICENSE)
