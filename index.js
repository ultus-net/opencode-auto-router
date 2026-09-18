/**
 * openrouter-auto-latest — an OpenCode plugin.
 *
 * Keeps the `~<lab>/<model>-latest` alias workflow and makes it work with
 * OpenRouter's Auto Router (`openrouter/auto`).
 *
 * WHY THIS EXISTS
 * ---------------
 * OpenRouter's Auto Router accepts an `allowed_models` constraint, but that
 * constraint only matches *concrete catalog IDs*:
 *
 *     allowed_models: ["anthropic/*", "openai/gpt-5.1"]    -> works
 *     allowed_models: ["~anthropic/claude-sonnet-latest"]  -> matches nothing
 *
 * The `~...-latest` aliases resolve fine when used as a top-level `model`, but
 * inside `allowed_models` they resolve to nothing. That collapses the router's
 * candidate pool, so every request fails with:
 *
 *     404 "No models match your request and model restrictions"
 *
 * This is easy to hit because the OpenRouter x OpenCode integration guide
 * recommends exactly those `~...-latest` aliases.
 *
 * WHAT THIS DOES
 * --------------
 * Keeps the "never pin versions by hand" workflow. At startup (and at most
 * every CACHE_TTL_MS) it reads each alias's current target from OpenRouter's
 * public model catalog (`alias_target.slug`) and injects the resolved concrete
 * slugs into every `openrouter/auto` request through OpenCode's `chat.params`
 * hook.
 *
 * The per-request list overrides the account-level Auto Router allowlist
 * ("Prevent overrides" must be OFF, which is the default), so this works even
 * when the saved account allowlist is unhealthy.
 *
 * @see https://openrouter.ai/docs/guides/routing/routers/auto-router
 */

import fs from "node:fs"

/** Default pool fed to the Auto Router. Any alias without a target is skipped. */
const DEFAULT_ALIASES = [
  "~anthropic/claude-opus-latest",
  "~anthropic/claude-sonnet-latest",
  "~anthropic/claude-haiku-latest",
  "~anthropic/claude-fable-latest",
  "~openai/gpt-astra-latest",
  "~openai/gpt-sol-latest",
  "~openai/gpt-terra-latest",
  "~openai/gpt-luna-latest",
  "~openai/gpt-mini-latest",
  "~google/gemini-pro-latest",
  "~google/gemini-flash-latest",
  "~x-ai/grok-latest",
  "~deepseek/deepseek-pro-latest",
  "~deepseek/deepseek-flash-latest",
  "~deepseek/deepseek-v4-flash-latest",
  "~z-ai/glm-latest",
  "~z-ai/glm-flash-latest",
  "~moonshotai/kimi-latest",
]

/** Optional cost band: "low" | "medium" | "high" | "xhigh" | "max". */
const DEFAULT_COST_TIER = undefined

const PROVIDER_ID = "openrouter"
const MODEL_ID = "openrouter/auto"

const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours
const MODELS_URL = "https://openrouter.ai/api/v1/models"
const DISK_CACHE = `${
  process.env.XDG_CACHE_HOME ?? `${process.env.HOME}/.cache`
}/opencode/openrouter-auto-latest.json`

/**
 * @typedef {Object} PluginConfig
 * @property {string[]} [aliases]  Override the `~...-latest` pool.
 * @property {string} [costTier]   Cost band for the Auto Router.
 */

/** @type {PluginConfig} */
let config = {}

/** @type {{ at: number, slugs: string[] } | undefined} */
let cache = loadDiskCache()
let inflight

function loadDiskCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DISK_CACHE, "utf8"))
    if (Array.isArray(parsed?.slugs) && parsed.slugs.length) {
      return { at: parsed.at ?? 0, slugs: parsed.slugs }
    }
  } catch {}
}

function saveDiskCache(next) {
  try {
    fs.mkdirSync(DISK_CACHE.replace(/\/[^/]+$/, ""), { recursive: true })
    fs.writeFileSync(DISK_CACHE, JSON.stringify(next))
  } catch {}
}

async function fetchAliasTargets() {
  const res = await fetch(MODELS_URL, { headers: { accept: "application/json" } })
  if (!res.ok) throw new Error(`OpenRouter models fetch failed: ${res.status}`)
  const { data } = await res.json()
  const targets = new Map()
  for (const model of data ?? []) {
    if (typeof model?.id === "string" && model.id.startsWith("~") && model.alias_target?.slug) {
      targets.set(model.id, model.alias_target.slug)
    }
  }
  return targets
}

async function resolveSlugs() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.slugs
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const aliases = config.aliases ?? DEFAULT_ALIASES
      const targets = await fetchAliasTargets()
      const slugs = aliases.map((alias) => targets.get(alias)).filter(Boolean)
      if (slugs.length) {
        cache = { at: Date.now(), slugs }
        saveDiskCache(cache)
      }
      return cache?.slugs ?? []
    } catch {
      // Offline or transient failure: keep serving the last known pool.
      return cache?.slugs ?? []
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

export default {
  id: "openrouter-auto-latest",
  /**
   * @param {import("@opencode-ai/plugin").PluginInput} _input
   * @param {PluginConfig} [options]
   */
  server: async (_input, options) => {
    config = options ?? {}
    // Warm the cache so the first request does not wait on the network.
    await resolveSlugs()

    return {
      "chat.params": async (input, output) => {
        if (input.model?.providerID !== PROVIDER_ID) return
        if (input.model?.id !== MODEL_ID) return

        const models = await resolveSlugs()
        if (!models.length) return

        const costTier = config.costTier ?? DEFAULT_COST_TIER
        const options_ = (output.options ??= {})
        const existing = Array.isArray(options_.plugins) ? options_.plugins : []
        const autoRouter = {
          id: "auto-router",
          allowed_models: models,
          ...(costTier ? { cost_tier: costTier } : {}),
        }
        options_.plugins = [...existing.filter((plugin) => plugin?.id !== "auto-router"), autoRouter]
      },
    }
  },
}