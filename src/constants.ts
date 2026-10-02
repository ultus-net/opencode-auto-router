/**
 * Shared constants for the auto-router plugin.
 *
 * The plugin has two independent jobs that happen to ride in one package:
 *
 *  1. Primary provider: Synthetic's permanent `syn:*` category aliases. These
 *     are the stable, always-current IDs (`syn:large:text`, …) that Synthetic
 *     rotates to the newest model per category, so nothing is pinned.
 *  2. Failover: when Synthetic rate-limits, fall back to OpenRouter's Auto
 *     Router (`openrouter/auto`), reusing the `~<lab>/<model>-latest` alias
 *     workflow this project started with.
 */

/** Plugin id. Used by OpenCode for storage scoping and diagnostics. */
export const PLUGIN_ID = "opencode-auto-router"

export const SYNTHETIC_PROVIDER_ID = "synthetic"
export const SYNTHETIC_MODELS_URL = "https://api.synthetic.new/openai/v1/models"

/** OpenCode model id within the `synthetic` provider. */
export const SYNTHETIC_PRIMARY_MODEL_ID = "syn:large:text"
export const SYNTHETIC_SMALL_MODEL_ID = "syn:small:text"

/**
 * Friendly plugin-registered alias. Synthetic's catalog has no `syn:auto`
 * category, so the plugin registers this id itself and remaps it to the
 * configured `primaryModel` via the model's `modelID`: requests for
 * `synthetic/syn:auto` send a real Synthetic id, while the picker shows the
 * router's default. It is the routed default for agents that match no route.
 */
export const SYNTHETIC_AUTO_MODEL_ID = "syn:auto"

/**
 * Default role -> alias routing. Ordered; the first pattern that matches an
 * agent id wins. Deliberately small and legible: heavy roles get the large text
 * alias, light/research roles get the small text alias, vision roles get the
 * large vision alias. Unmatched agents fall to `SYNTHETIC_AUTO_MODEL_ID`.
 * (`syn:small:vision` is registered and selectable, but not routed by default.)
 */
export const DEFAULT_AGENT_ROUTES: readonly { match: string; model: string }[] = [
  { match: "vision|image|screenshot|ocr|multimodal", model: "syn:large:vision" },
  { match: "explore|search|grep|read|title|summar|compact|quick|small|fast|executor|retro|rsi", model: "syn:small:text" },
  { match: "build|code|coder|edit|implement|plan|review|debug|refactor|general|test|decompose|architect|judge", model: "syn:large:text" },
]

export const OPENROUTER_PROVIDER_ID = "openrouter"
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

/**
 * OpenRouter model id. OpenCode model refs are `provider_id/model_id`, and the
 * OpenRouter model is literally named `openrouter/auto`, hence the doubled
 * segment when referenced as a full ref.
 */
export const OPENROUTER_AUTO_MODEL_ID = "openrouter/auto"

/**
 * Default pool fed to the Auto Router. Any alias without a live target is
 * skipped. This mirrors the historical default list; it is configurable and
 * intentionally tolerant of models that do not exist yet.
 */
export const DEFAULT_ALIASES: readonly string[] = [
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

/** Cost band: "low" | "medium" | "high" | "xhigh" | "max". Undefined = account default. */
export const DEFAULT_COST_TIER: string | undefined = undefined

/** Catalog is treated as fresh for this long before a refresh is attempted. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** Network timeout for catalog fetches. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

/** Statuses that mark a provider failure as safe to fail over on. */
export const DEFAULT_FAILOVER_STATUSES: readonly number[] = [429]

/** Case-insensitive substrings matched against an error's type/message. */
export const DEFAULT_FAILOVER_MESSAGE_MATCHES: readonly string[] = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "too many requests",
  "quota",
  "overloaded",
]
