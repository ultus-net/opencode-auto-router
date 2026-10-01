/**
 * Option normalization and defaults.
 *
 * Unknown or malformed values fall back to defaults rather than throwing:
 * a plugin should degrade gracefully in the host, and the failure mode of a
 * bad option is a worse routing policy, not a broken session.
 */

import {
  DEFAULT_AGENT_ROUTES,
  DEFAULT_ALIASES,
  DEFAULT_COST_TIER,
  DEFAULT_FAILOVER_MESSAGE_MATCHES,
  DEFAULT_FAILOVER_STATUSES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  SYNTHETIC_PRIMARY_MODEL_ID,
  SYNTHETIC_SMALL_MODEL_ID,
} from "./constants.js"
import type { AgentRoute, PluginOptions, ResolvedConfig } from "./types.js"

function positiveInt(value: unknown, fallback: number, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.trunc(value))
}

function stringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const items = value.filter((v): v is string => typeof v === "string" && v.length > 0)
  return items.length > 0 ? items : [...fallback]
}

/**
 * A route is kept only when `match` compiles as a regex and `model` is a
 * non-empty string. An invalid pattern is dropped rather than allowed to throw
 * at transform time, where it would break every agent.
 */
function validRoutes(value: unknown): AgentRoute[] | undefined {
  if (!Array.isArray(value)) return undefined
  const routes: AgentRoute[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const match = (entry as { match?: unknown }).match
    const model = (entry as { model?: unknown }).model
    if (typeof match !== "string" || typeof model !== "string" || !model) continue
    try {
      new RegExp(match)
    } catch {
      continue
    }
    routes.push({ match, model })
  }
  return routes
}

export function resolveConfig(options: PluginOptions = {}): ResolvedConfig {
  const failover = options.failover ?? {}
  const routing = options.routing ?? {}
  return {
    syntheticModels: Array.isArray(options.syntheticModels)
      ? options.syntheticModels.filter((v) => typeof v === "string" && v.startsWith("syn:"))
      : [],
    primaryModel:
      typeof options.primaryModel === "string" && options.primaryModel
        ? options.primaryModel
        : SYNTHETIC_PRIMARY_MODEL_ID,
    smallModel:
      typeof options.smallModel === "string" && options.smallModel
        ? options.smallModel
        : SYNTHETIC_SMALL_MODEL_ID,
    autoModel:
      typeof options.primaryModel === "string" && options.primaryModel
        ? options.primaryModel
        : SYNTHETIC_PRIMARY_MODEL_ID,
    agentRoutes: validRoutes(routing.agentRoutes) ?? [...DEFAULT_AGENT_ROUTES],
    defaultAgentModel:
      typeof routing.defaultAgentModel === "string"
        ? routing.defaultAgentModel
        : SYNTHETIC_PRIMARY_MODEL_ID,
    aliases: stringArray(options.aliases, DEFAULT_ALIASES),
    costTier:
      typeof options.costTier === "string" && options.costTier
        ? options.costTier
        : DEFAULT_COST_TIER,
    setDefaultModel: options.setDefaultModel !== false,
    forceDefaultModel: options.forceDefaultModel === true,
    setSmallModel: options.setSmallModel !== false,
    failover: {
      enabled: failover.enabled !== false,
      statuses: Array.isArray(failover.statuses)
        ? failover.statuses.filter((n): n is number => typeof n === "number")
        : [...DEFAULT_FAILOVER_STATUSES],
      messageMatches: stringArray(
        failover.messageMatches,
        DEFAULT_FAILOVER_MESSAGE_MATCHES,
      ),
      maxAttempts: positiveInt(failover.maxAttempts, 1, 1),
      retryDelayMs: positiveInt(failover.retryDelayMs, 1_000, 0),
    },
    requestTimeoutMs: positiveInt(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1,
    ),
  }
}
