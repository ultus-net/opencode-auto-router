/**
 * opencode-auto-router — an OpenCode V2 plugin.
 *
 * Primary provider: Synthetic's permanent `syn:*` category aliases
 * (`syn:large:text`, `syn:small:text`, `syn:large:vision`, `syn:small:vision`).
 * Failover: when Synthetic rate-limits, fall back to OpenRouter's Auto Router
 * (`openrouter/auto`), reusing the `~<lab>/<model>-latest` alias workflow that
 * keeps the Auto Router's candidate pool current without pinning versions.
 *
 * Two independent capabilities live here:
 *
 *   1. Catalog registration. Synthetic's `syn:*` aliases are absent from the
 *      public models.dev catalog, so they are discovered from Synthetic's
 *      OpenAI-compatible `/models` endpoint and registered as OpenCode models.
 *      The OpenRouter Auto Router is registered too, with its `~…-latest` pool
 *      resolved to concrete slugs on every request (the Auto Router cannot
 *      resolve aliases inside `allowed_models` — see `openrouter.ts`).
 *
 *   2. Cross-provider failover. A plugin cannot redirect an in-flight request
 *      (hook `model` fields are readonly), so `failover.ts` observes the
 *      failure via the event stream and drives recovery through the session
 *      API: switch to OpenRouter, re-send the last user message.
 *
 * V2-only. The event-driven failover and catalog transforms have no V1
 * equivalent, so the legacy `server()` entrypoint is intentionally dropped in
 * 2.0.0. See CHANGELOG.md.
 *
 * @see https://opencode.ai/v2/docs/build/plugins
 */

import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"

import { resolveConfig } from "./config.js"
import {
  OPENROUTER_AUTO_MODEL_ID,
  OPENROUTER_PROVIDER_ID,
  PLUGIN_ID,
  SYNTHETIC_PROVIDER_ID,
} from "./constants.js"
import { FailoverController, type FailoverHost, type ModelRef, type ReplayCandidate, type RetryEvent } from "./failover.js"
import { log } from "./log.js"
import {
  buildAutoModel,
  openRouterAutoModelInfo,
  syntheticModelInfo,
  type ModelDraft,
} from "./models.js"
import { resolveAgentModel } from "./routing.js"
import { currentSynthetic, resolveOpenRouterPool, warm } from "./state.js"
import type { ResolvedConfig } from "./types.js"

export { resolveConfig } from "./config.js"
export { FailoverController, isRetryable } from "./failover.js"
export type { ReplayCandidate, RetryEvent, RetryDecision } from "./failover.js"
export { resolveAgentModel } from "./routing.js"
export { resolvePool, aliasTargets } from "./openrouter.js"
export { mapSyntheticModel } from "./synthetic.js"

/** Which session request kinds carry the Auto Router injection. */
const REQUEST_KINDS = ["context", "compaction", "generate", "title"] as const

/** Register the Synthetic `syn:*` models and the OpenRouter Auto Router model. */
async function registerModels(ctx: Context, config: ResolvedConfig): Promise<void> {
  const requested = config.syntheticModels
  const select = <T extends { id: string }>(all: T[]): T[] =>
    requested.length > 0 ? all.filter((m) => requested.includes(m.id)) : all

  await ctx.provider.transform((editor) => {
    // `models.set` REPLACES a provider's whole inventory, so merge with what is
    // already there. This only augments an already-present (connected)
    // provider: inventing one would clobber the catalog's endpoint settings.
    const merge = (providerID: string, additions: ModelDraft[]): void => {
      const record = editor.get(providerID)
      if (!record) {
        log.warn(`${providerID} not connected; skipping model registration`)
        return
      }
      const merged = new Map(record.models)
      for (const model of additions) merged.set(model.id, model)
      editor.models.set(providerID, [...merged.values()])
    }

    const cached = currentSynthetic()
    if (cached && cached.aliases.length > 0) {
      const models = select(cached.aliases)
      if (models.length > 0) {
        merge(SYNTHETIC_PROVIDER_ID, [
          buildAutoModel(config.autoModel),
          ...models.map(syntheticModelInfo),
        ])
      }
    }
    merge(OPENROUTER_PROVIDER_ID, [openRouterAutoModelInfo()])
  })
}

/** Fetch fresh catalogs and reload the registrations that depend on them. */
async function refreshCatalogs(ctx: Context, config: ResolvedConfig): Promise<void> {
  await warm(config)
  try {
    await ctx.provider.reload()
    log.debug("reloaded providers after catalog refresh")
  } catch (error) {
    log.warn("provider reload after catalog refresh failed", error)
  }
}

/** Set the default model and the small/title model. */
async function setDefaults(ctx: Context, config: ResolvedConfig): Promise<void> {
  const primary: ModelRef = {
    providerID: SYNTHETIC_PROVIDER_ID,
    id: config.primaryModel,
  }

  if (config.setDefaultModel) {
    await ctx.model.transform((editor) => {
      const current = editor.default.get()
      if (config.forceDefaultModel || !current) {
        editor.default.set(primary.providerID, primary.id)
      }
    })
  }

  if (config.setSmallModel) {
    await ctx.agent.transform((editor) => {
      if (!editor.get("title")) return
      editor.update("title", (agent) => {
        agent.model = {
          providerID: primary.providerID,
          id: config.smallModel,
        } as unknown as typeof agent.model
      })
    })
  }
}

/**
 * Point router-managed agents at their routed Synthetic alias. This is the
 * supported coarse-routing lever: OpenCode resolves an agent's model for every
 * request it serves (including each tool continuation), whereas per-request
 * model selection is not exposed to plugins. See `routing.ts`.
 */
async function applyAgentRouting(ctx: Context, config: ResolvedConfig): Promise<void> {
  if (config.agentRoutes.length === 0 && !config.defaultAgentModel) return
  await ctx.agent.transform((editor) => {
    for (const agent of editor.list()) {
      const id = String(agent.id)
      const current = agent.model
      const target = resolveAgentModel(
        {
          id,
          model: current ? { providerID: String(current.providerID) } : undefined,
        },
        config,
      )
      if (!target) continue
      editor.update(id, (draft) => {
        draft.model = target as unknown as typeof draft.model
      })
    }
  })
}

/** Inject the resolved `~…-latest` pool into every `openrouter/auto` request. */
async function registerAutoRouterInjection(
  ctx: Context,
  config: ResolvedConfig,
): Promise<void> {
  const inject = async (event: {
    model: ModelRef
    options: Record<string, unknown>
  }): Promise<void> => {
    if (event.model.providerID !== OPENROUTER_PROVIDER_ID) return
    if (event.model.id !== OPENROUTER_AUTO_MODEL_ID) return

    const models = await resolveOpenRouterPool(config)
    if (models.length === 0) return

    const options = event.options
    const existing = Array.isArray(options.plugins) ? options.plugins : []
    const autoRouter = {
      id: "auto-router",
      allowed_models: models,
      ...(config.costTier ? { cost_tier: config.costTier } : {}),
    }
    options.plugins = [
      ...existing.filter(
        (plugin) =>
          typeof plugin !== "object" ||
          plugin === null ||
          (plugin as { id?: string }).id !== "auto-router",
      ),
      autoRouter,
    ]
  }

  for (const kind of REQUEST_KINDS) {
    await ctx.session.hook(kind, inject, { providerID: OPENROUTER_PROVIDER_ID })
  }
}

/** Build a FailoverHost backed by the plugin context. */
function makeFailoverHost(ctx: Context): FailoverHost {
  return {
    async getSessionModel(sessionID: string): Promise<ModelRef | undefined> {
      const session = await ctx.session.get({ sessionID })
      const model = session.model
      if (!model) return undefined
      return { providerID: model.providerID, id: model.id }
    },
    async replayCandidate(sessionID: string): Promise<ReplayCandidate | undefined> {
      const messages = await ctx.session.context({ sessionID })
      let text: string | undefined
      let safe = true
      // Walk backwards to the most recent user message: that is the turn that
      // just failed. Any assistant message after it means the turn already
      // produced output or ran tools, so replaying it is not safe.
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]
        if (!message) continue
        if (message.type === "user") {
          text = message.text
          break
        }
        if (message.type === "assistant" && message.content.length > 0) {
          safe = false
        }
      }
      if (typeof text !== "string" || !text.trim()) return undefined
      return { text, safe }
    },
    async switchModel(sessionID: string, model: ModelRef): Promise<void> {
      await ctx.session.switchModel({ sessionID, model })
    },
    async prompt(sessionID: string, text: string): Promise<unknown> {
      return ctx.session.prompt({ sessionID, text })
    },
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = resolveConfig(ctx.options)

    // Register from whatever catalog we already have (disk cache, if any) so
    // setup does not block on the network. Then refresh in the background and
    // reload the providers once fresh data arrives.
    await registerModels(ctx, config)
    void refreshCatalogs(ctx, config)
    await setDefaults(ctx, config)
    await applyAgentRouting(ctx, config)
    await registerAutoRouterInjection(ctx, config)

    const controller = new FailoverController(config, makeFailoverHost(ctx))

    if (controller.enabled) {
      // Bound Synthetic retries so a sustained rate limit reaches a terminal
      // failure quickly; the long default backoff only delays failover.
      await ctx.session.hook(
        "retry",
        (event) => {
          controller.boundRetry(event as unknown as RetryEvent)
        },
        { providerID: SYNTHETIC_PROVIDER_ID },
      )

      // Observe terminal outcomes. We drive recovery only on failure, and the
      // controller itself refuses to act when the session is no longer on
      // Synthetic, so a failed fallback cannot loop.
      const abort = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            const e = event as { type: string; data?: Record<string, unknown> }
            const sessionID = e.data?.sessionID
            if (typeof sessionID !== "string") continue
            if (e.type === "session.execution.succeeded") {
              controller.clear(sessionID)
            } else if (e.type === "session.execution.failed") {
              const error = e.data?.error as
                | { type?: string; message?: string; status?: number }
                | undefined
              void controller.onExecutionFailed(sessionID, error ?? {})
            }
          }
        } catch (error) {
          if (!abort.signal.aborted) log.warn("event subscription ended", error)
        }
      })()

      return () => {
        abort.abort()
      }
    }

    return undefined
  },
})
