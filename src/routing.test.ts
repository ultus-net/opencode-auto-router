import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveConfig } from "./config.js"
import { resolveAgentModel, routeAgents } from "./routing.js"
import { SYNTHETIC_AUTO_MODEL_ID } from "./constants.js"

const cfg = resolveConfig()

type ProbeAgent = { id: string; model?: { providerID?: string; id?: string }; mode?: string }
type ProbeDraft = {
  list: () => ProbeAgent[]
  get: (id: string) => ProbeAgent | undefined
  update: (id: string, fn: (agent: ProbeAgent) => void) => void
}

/** Minimal stand-in for the host draft (`core/src/agent.ts:56`). */
function makeDraft(agents: Map<string, ProbeAgent>): ProbeDraft {
  return {
    list: () => [...agents.values()],
    get: (id) => agents.get(id),
    update: (id, fn) => {
      const current = agents.get(id) ?? { id }
      agents.set(id, current)
      fn(current)
      current.id = id
    },
  }
}

/**
 * Replay a transform list the way `AgentV2` materializes state
 * (`core/src/state.ts`): from an empty base, in registration order. The
 * config-owned transform that discovers custom agents sits between `before`
 * and `after`, so `before` mirrors the observed bug (router registered too
 * early) and `after` mirrors the fix (re-registered once boot settles).
 */
function materialize(parts: {
  before?: Array<(draft: ProbeDraft) => void>
  after?: Array<(draft: ProbeDraft) => void>
  custom: ProbeAgent[]
}): Map<string, ProbeAgent> {
  const agents = new Map<string, ProbeAgent>()
  const draft = makeDraft(agents)
  const builtins = (d: ProbeDraft) => {
    for (const id of ["build", "general"]) d.update(id, () => {})
  }
  const configAgent = (d: ProbeDraft) => {
    for (const agent of parts.custom) d.update(agent.id, (a) => Object.assign(a, agent))
  }
  for (const transform of [builtins, ...(parts.before ?? []), configAgent, ...(parts.after ?? [])]) {
    transform(draft)
  }
  return agents
}

test("registration order decides whether custom agents are routed (bug + fix)", () => {
  const custom: ProbeAgent[] = [{ id: "reviewer" }, { id: "executor" }, { id: "probe-unpinned" }]
  const route = (d: ProbeDraft) => routeAgents(d as never, cfg)

  // Bug: the router transform registered before the config transform, so on
  // replay it runs against a draft that only holds built-ins.
  const early = materialize({ before: [route], custom })
  assert.equal(early.get("reviewer")?.model, undefined)
  assert.equal(early.get("executor")?.model, undefined)

  // Fix: a router transform appended after the config transform sees the
  // discovered custom agents and routes them.
  const late = materialize({ after: [route], custom })
  assert.equal(late.get("reviewer")?.model?.id, "syn:large:text")
  assert.equal(late.get("executor")?.model?.id, "syn:small:text")
  assert.equal(late.get("probe-unpinned")?.model?.id, SYNTHETIC_AUTO_MODEL_ID)
})

test("routeAgents never creates an agent that config-agent has not listed", () => {
  const agents = new Map<string, ProbeAgent>()
  let updates = 0
  const editor = {
    list: () => [...agents.values()],
    update(id: string, fn: (agent: ProbeAgent) => void) {
      updates += 1
      const current = agents.get(id) ?? { id }
      agents.set(id, current)
      fn(current)
    },
  }
  assert.deepEqual(routeAgents(editor as never, cfg), [])
  assert.equal(updates, 0, "an empty draft must not be pre-populated")
  assert.equal(agents.size, 0)
})

test("routeAgents repoints unpinned custom agents and leaves foreign pins", () => {
  const draft = new Map<string, ProbeAgent>([
    ["reviewer", { id: "reviewer" }],
    ["executor", { id: "executor" }],
    ["pinned", { id: "pinned", model: { providerID: "anthropic" } }],
    ["title", { id: "title" }],
  ])
  const routed = routeAgents(makeDraft(draft) as never, cfg)
  assert.deepEqual(routed.sort(), ["executor", "reviewer"])
  assert.equal(draft.get("executor")?.model?.id, "syn:small:text")
  assert.equal(draft.get("reviewer")?.model?.id, "syn:large:text")
  assert.equal(draft.get("pinned")?.model?.id, undefined)
  assert.equal(draft.get("title")?.model, undefined)
})

test("routes known roles by pattern and defaults the rest to syn:auto", () => {
  // Heavy roles -> large text.
  assert.equal(resolveAgentModel({ id: "reviewer" }, cfg)?.id, "syn:large:text")
  // Light/research roles -> small text.
  assert.equal(resolveAgentModel({ id: "explore" }, cfg)?.id, "syn:small:text")
  // Vision roles -> large vision.
  assert.equal(resolveAgentModel({ id: "screenshot-analyzer" }, cfg)?.id, "syn:large:vision")
  // Escalation twin: routed strong even though "executor" is a substring
  // of the cheap line's pattern, so its route must precede that line.
  assert.equal(resolveAgentModel({ id: "executor-strong" }, cfg)?.id, "syn:large:text")
  assert.equal(resolveAgentModel({ id: "executor" }, cfg)?.id, "syn:small:text")
  // No pattern -> the router alias (which remaps to primary upstream).
  assert.equal(resolveAgentModel({ id: "totally-unknown" }, cfg)?.id, SYNTHETIC_AUTO_MODEL_ID)
  // Every routed target lives on the Synthetic provider.
  assert.equal(resolveAgentModel({ id: "build" }, cfg)?.providerID, "synthetic")
})

test("a primary agent keeps the router alias, not its role route", () => {
  // `build` and `plan` match the heavy pattern, but they drive the operator's
  // session: the global default (and the host's last-used pick behind it) wins.
  for (const id of ["build", "plan"]) {
    const routed = resolveAgentModel({ id, mode: "primary" }, cfg)
    assert.equal(routed?.id, SYNTHETIC_AUTO_MODEL_ID, `${id} must keep syn:auto`)
    assert.equal(routed?.providerID, "synthetic")
  }

  // The same ids in a subagent position still take their role route, so the
  // guard is the mode and not the id.
  assert.equal(resolveAgentModel({ id: "build", mode: "subagent" }, cfg)?.id, "syn:large:text")
})

test("utility primaries keep their cheap route", () => {
  for (const id of ["compaction", "summary"]) {
    assert.equal(
      resolveAgentModel({ id, mode: "primary" }, cfg)?.id,
      "syn:small:text",
      `${id} must stay on the small alias`,
    )
  }
})

test("a primary agent is left untouched when no default model is configured", () => {
  const c = resolveConfig({ routing: { defaultAgentModel: "" } })
  assert.equal(resolveAgentModel({ id: "build", mode: "primary" }, c), undefined)
  // The utility primaries still route by pattern under the same config.
  assert.equal(resolveAgentModel({ id: "compaction", mode: "primary" }, c)?.id, "syn:small:text")
})

test("a foreign-pinned primary agent is never routed", () => {
  assert.equal(
    resolveAgentModel(
      { id: "build", mode: "primary", model: { providerID: "anthropic" } },
      cfg,
    ),
    undefined,
  )
})

test("routeAgents sends the primary agent to syn:auto and subagents by role", () => {
  const draft = new Map<string, ProbeAgent>([
    ["build", { id: "build", mode: "primary" }],
    ["plan", { id: "plan", mode: "primary" }],
    ["compaction", { id: "compaction", mode: "primary" }],
    ["reviewer", { id: "reviewer", mode: "subagent" }],
  ])
  routeAgents(makeDraft(draft) as never, cfg)
  assert.equal(draft.get("build")?.model?.id, SYNTHETIC_AUTO_MODEL_ID)
  assert.equal(draft.get("plan")?.model?.id, SYNTHETIC_AUTO_MODEL_ID)
  assert.equal(draft.get("compaction")?.model?.id, "syn:small:text")
  assert.equal(draft.get("reviewer")?.model?.id, "syn:large:text")
})

test("the first matching route wins", () => {
  const c = resolveConfig({
    routing: {
      agentRoutes: [
        { match: "review", model: "syn:small:text" },
        { match: ".*", model: "syn:large:text" },
      ],
    },
  })
  assert.equal(resolveAgentModel({ id: "reviewer" }, c)?.id, "syn:small:text")
  assert.equal(resolveAgentModel({ id: "builder" }, c)?.id, "syn:large:text")
})

test("the title agent is owned by setDefaults, not routing", () => {
  assert.equal(resolveAgentModel({ id: "title" }, cfg), undefined)
})

test("agents pinned to another provider are left alone", () => {
  assert.equal(
    resolveAgentModel({ id: "build", model: { providerID: "anthropic" } }, cfg),
    undefined,
  )
})

test("unset-provider agents are routable (missing providerID counts as unset)", () => {
  assert.equal(resolveAgentModel({ id: "build" }, cfg)?.id, "syn:large:text")
  // A model object without a providerID is treated as unset, not as a foreign pin.
  assert.equal(resolveAgentModel({ id: "build", model: {} }, cfg)?.id, "syn:large:text")
  assert.equal(
    resolveAgentModel({ id: "build", model: { providerID: "synthetic" } }, cfg)?.id,
    "syn:large:text",
  )
})

test("an unmatched agent with defaultAgentModel '' is left untouched", () => {
  const c = resolveConfig({
    routing: {
      agentRoutes: [{ match: "build", model: "syn:large:text" }],
      defaultAgentModel: "",
    },
  })
  assert.equal(resolveAgentModel({ id: "build" }, c)?.id, "syn:large:text")
  assert.equal(resolveAgentModel({ id: "unmatched" }, c), undefined)
})

test("routing can be disabled entirely", () => {
  const c = resolveConfig({ routing: { agentRoutes: [], defaultAgentModel: "" } })
  assert.equal(resolveAgentModel({ id: "build" }, c), undefined)
  assert.equal(resolveAgentModel({ id: "explore" }, c), undefined)
})
