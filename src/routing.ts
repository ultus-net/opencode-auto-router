/**
 * Coarse, agent-level model routing.
 *
 * OpenCode V2 does not let a plugin choose the model per *request*: every
 * request hook (`context`, `generate`, `compaction`, `title`, `model.request`,
 * `http.request`) carries `readonly model`, so OpenRouter's per-call
 * Auto Router selection has no plugin equivalent. The supported lever is the
 * *agent's* configured model (`ctx.agent.transform`), which OpenCode resolves
 * for every request that agent serves, including each tool-driven continuation.
 *
 * So routing here is by role, not by live complexity: an ordered list of regex
 * patterns maps agent ids to Synthetic `syn:*` aliases. The first matching
 * pattern wins; an agent that matches nothing falls back to
 * `config.defaultAgentModel` (default `syn:auto`, which itself remaps to the
 * configured primary alias). This spreads work across the aliases by role while
 * the request-level failover in `failover.ts` stays untouched.
 *
 * Only router-managed agents are repointed: those with no model at all, or
 * those already on Synthetic. An agent explicitly pinned to another provider is
 * left alone, so the plugin never clobbers a deliberate choice.
 */

import { SYNTHETIC_PROVIDER_ID } from "./constants.js"
import type { ResolvedConfig } from "./types.js"

/** The model a route assigns, in OpenCode's `{ providerID, id }` shape. */
export interface AgentModelTarget {
  providerID: string
  id: string
}

/** The subset of an agent this module reads. */
export interface RoutableAgent {
  id: string
  model?: { providerID?: string } | undefined
}

/**
 * Resolve the model for one agent, or `undefined` to leave it unchanged.
 *
 * `config.agentRoutes` is evaluated in order against the agent id; the first
 * match wins. Unmatched agents receive `config.defaultAgentModel` when set.
 * The title agent is excluded here: `setDefaults` owns the small/title model,
 * and two writers for one field is how drift starts.
 */
export function resolveAgentModel(
  agent: RoutableAgent,
  config: ResolvedConfig,
): AgentModelTarget | undefined {
  if (agent.id === "title") return undefined

  const currentProvider = agent.model?.providerID
  const managed = currentProvider == null || currentProvider === SYNTHETIC_PROVIDER_ID
  if (!managed) return undefined

  for (const route of config.agentRoutes) {
    if (route.model && matches(agent.id, route.match)) {
      return { providerID: SYNTHETIC_PROVIDER_ID, id: route.model }
    }
  }

  if (config.defaultAgentModel) {
    return { providerID: SYNTHETIC_PROVIDER_ID, id: config.defaultAgentModel }
  }
  return undefined
}

/**
 * Case-insensitive regex test that never throws on a bad pattern. Patterns are
 * validated by `resolveConfig`; the guard is for direct callers.
 */
function matches(value: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, "i").test(value)
  } catch {
    return false
  }
}
