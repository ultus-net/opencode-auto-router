/**
 * Public option and internal data types.
 *
 * `PluginOptions` is the shape a user may pass in `opencode.json(c)`; every
 * field is optional and validated/normalized by `resolveConfig`.
 */

export interface FailoverConfig {
  /** Master switch. Default `true`. */
  enabled?: boolean
  /**
   * HTTP statuses treated as retryable for failover. Default `[429]`.
   * Add `500`, `502`, `503` to also fail over on upstream outages.
   */
  statuses?: number[]
  /** Case-insensitive substrings matched against error type/message. */
  messageMatches?: string[]
  /** Max automatic cross-provider failovers per user turn. Default `1`. */
  maxAttempts?: number
  /** Delay, in ms, before OpenCode's single bounded Synthetic retry. Default 1000. */
  retryDelayMs?: number
}

/** One ordered agent-id pattern -> Synthetic alias route. */
export interface AgentRoute {
  /** Regex tested against the agent id (case-insensitive). */
  match: string
  /** Synthetic `syn:*` alias the matching agents use. */
  model: string
}

export interface RoutingConfig {
  /**
   * Ordered routes applied by `ctx.agent.transform`. First matching pattern
   * wins. Defaults to `DEFAULT_AGENT_ROUTES`.
   */
  agentRoutes?: AgentRoute[]
  /**
   * Alias for agents that match no route. Default `syn:auto` (the router alias,
   * which itself remaps to `primaryModel`). Set to `""` to leave unmatched
   * agents untouched.
   */
  defaultAgentModel?: string
}

export interface PluginOptions {
  /** Explicit Synthetic `syn:*` ids to register. Default: all `syn:*` in the catalog. */
  syntheticModels?: string[]
  /**
   * Primary Synthetic model id (without the provider prefix). Default
   * `syn:large:text`. Used when `setDefaultModel` is enabled.
   */
  primaryModel?: string
  /** Secondary/vision Synthetic model id for lightweight requests. */
  smallModel?: string

  /** Agent-level routing (the supported V2 lever; see `routing.ts`). */
  routing?: RoutingConfig

  /** Override the `~…-latest` pool fed to the Auto Router. */
  aliases?: string[]
  /** Cost band for the Auto Router: low | medium | high | xhigh | max. */
  costTier?: string

  /** Default `true`. Set OpenCode's default model when none is configured. */
  setDefaultModel?: boolean
  /** Default `false`. Set the default model even when one is already configured. */
  forceDefaultModel?: boolean
  /** Default `true`. Also set the built-in `title` agent to the small model. */
  setSmallModel?: boolean

  /** Failover to OpenRouter's Auto Router on retryable Synthetic failures. */
  failover?: FailoverConfig

  /** Seconds (or ms) for catalog fetches. Default 10s. */
  requestTimeoutMs?: number
}

/** Normalized configuration with all defaults resolved. */
export interface ResolvedConfig {
  syntheticModels: string[]
  primaryModel: string
  smallModel: string
  /** Ordered agent-id routes, normalized (invalid/blank entries dropped). */
  agentRoutes: AgentRoute[]
  /** Alias for unmatched agents; `""` keeps them untouched. */
  defaultAgentModel: string
  aliases: string[]
  costTier: string | undefined
  setDefaultModel: boolean
  forceDefaultModel: boolean
  setSmallModel: boolean
  failover: Required<FailoverConfig>
  requestTimeoutMs: number
}

/** A single Synthetic catalog entry, reduced to what OpenCode needs. */
export interface SyntheticModel {
  /** The alias id, e.g. `syn:large:text`. Also used as the display name. */
  id: string
  /** Alias id (== `id`) from the catalog's `name`. */
  name: string
  /** Concrete model the alias currently routes to (`display_name`). */
  target?: string
  context: number
  output: number
  input: ("text" | "image")[]
  tools: boolean
  structuredOutput: boolean
  reasoning: boolean
  efforts: string[]
  released?: number
  cost?: { input?: number; output?: number; cache_read?: number }
}

export interface SyntheticCatalog {
  /** Only the `syn:*` alias models. */
  aliases: SyntheticModel[]
  /** Unix ms when the catalog was fetched. */
  at: number
}
