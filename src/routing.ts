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
 * Primary agents are the operator's driver, not a routed role. `build` and
 * `plan` therefore keep the router alias, so the global default and the
 * "last used model" pick still govern the session the operator drives. Matching
 * them against a role pattern would pin them to a concrete alias and silently
 * outrank that pick. The built-in utility primaries (`compaction`, `summary`)
 * are the exception: they run auxiliary work, so they keep their cheap route.
 *
 * Only router-managed agents are repointed: those with no model at all, or
 * those already on Synthetic. An agent explicitly pinned to another provider is
 * left alone, so the plugin never clobbers a deliberate choice.
 */

import { SYNTHETIC_PROVIDER_ID, UTILITY_PRIMARY_IDS } from "./constants.js"
import type { ResolvedConfig } from "./types.js"

/** The model a route assigns, in OpenCode's `{ providerID, id }` shape. */
export interface AgentModelTarget {
  providerID: string
  id: string
}

/** The subset of an agent this module reads. */
export interface RoutableAgent {
  id: string
  model?: { providerID?: string; id?: string } | undefined
  /** Host agent mode; absent in unit probes, treated as non-primary. */
  mode?: "subagent" | "primary" | "all" | undefined
}

/**
 * Resolve the model for one agent, or `undefined` to leave it unchanged.
 *
 * `config.agentRoutes` is evaluated in order against the agent id; the first
 * match wins. Unmatched agents receive `config.defaultAgentModel` when set.
 * The title agent is excluded here: `setDefaults` owns the small/title model,
 * and two writers for one field is how drift starts.
 *
 * A primary-capable agent outside `UTILITY_PRIMARY_IDS` resolves to
 * `config.defaultAgentModel` regardless of the role patterns, so the operator's
 * global default (and the host's last-used pick behind it) governs the session
 * they drive. "Primary-capable" is `mode` `primary` or `all`, because the host
 * lets the operator select an `all` agent as their primary. It still returns
 * `undefined` when no default is configured, which leaves the agent's own model
 * untouched.
 *
 * An agent carrying an explicit non-Synthetic pin keeps it untouched. An agent
 * already on Synthetic stays managed: the plugin owns Synthetic-level routing,
 * and "was this pin ours?" is state a replayed transform cannot hold.
 */
export function resolveAgentModel(
  agent: RoutableAgent,
  config: ResolvedConfig,
): AgentModelTarget | undefined {
  if (agent.id === "title") return undefined

  if (agent.model?.providerID != null && agent.model.providerID !== SYNTHETIC_PROVIDER_ID) {
    return undefined
  }

  // A non-Synthetic pin is a deliberate choice on another provider; never touch it.
  // An agent already on Synthetic stays managed: the plugin owns Synthetic-level
  // routing, and tracking "did we write this pin?" would need state that a
  // replayed transform cannot hold. Routing is deterministic, so re-resolving an
  // agent the plugin already routed is a no-op.
  if (agent.model?.providerID != null && agent.model.providerID !== SYNTHETIC_PROVIDER_ID) {
    return undefined
  }

  const primaryCapable = agent.mode === "primary" || agent.mode === "all"
  const utilityPrimary = UTILITY_PRIMARY_IDS.includes(agent.id)
  const skipRoutes = primaryCapable && !utilityPrimary

  if (!skipRoutes) {
    for (const route of config.agentRoutes) {
      if (route.model && matches(agent.id, route.match)) {
        return { providerID: SYNTHETIC_PROVIDER_ID, id: route.model }
      }
    }
  }

  if (config.defaultAgentModel) {
    return { providerID: SYNTHETIC_PROVIDER_ID, id: config.defaultAgentModel }
  }
  return undefined
}

/**
 * The draft-mutation surface this module needs. Structurally satisfied by the
 * host's `AgentEditor`, but declared minimally so the replay contract can be
 * unit-tested without the host. Ids arrive as the host's branded string, so the
 * editor-facing shape admits anything with a `toString`.
 */
export interface RoutingEditor {
  list(): readonly {
    id: string | { toString(): string }
    model?: { providerID?: unknown; id?: unknown } | undefined
    mode?: unknown
  }[]
  update(id: string, update: (agent: { model?: unknown }) => void): void
}

/**
 * Apply `config.agentRoutes` to every routable agent currently in `editor`,
 * returning the ids that were repointed.
 *
 * This is the body of the host transform. It only touches agents that are
 * already in the draft: it never calls `editor.update` for an id it has not
 * listed, because on the host an update for an absent id *creates* a bare agent
 * and the config-owned transform then sees `exists === true` and skips that
 * agent's configured permissions (`core/src/config/plugin/agent.ts:88`). The
 * plugin therefore depends on being ordered after the config transform, which
 * `index.ts` guarantees by re-registering once the boot batch settles.
 */
export function routeAgents(editor: RoutingEditor, config: ResolvedConfig): string[] {
  const routed: string[] = []
  for (const agent of editor.list()) {
    const id = String(agent.id)
    const provider = agent.model?.providerID
    const target = resolveAgentModel(
      {
        id,
        // A model without a providerID counts as unset; only stringify a real
        // id, so the caller never fabricates "undefined"/"null".
        model: provider == null ? undefined : { providerID: String(provider) },
        // Only a recognized mode is forwarded; anything else is treated as
        // unknown, so routing falls back to the role patterns rather than
        // guessing at the agent's class.
        mode:
          agent.mode === "primary" || agent.mode === "all" || agent.mode === "subagent"
            ? agent.mode
            : undefined,
      },
      config,
    )
    if (!target) continue
    editor.update(id, (draft) => {
      draft.model = target
    })
    routed.push(id)
  }
  return routed
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
