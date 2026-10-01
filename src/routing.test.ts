import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveConfig } from "./config.js"
import { resolveAgentModel } from "./routing.js"
import { SYNTHETIC_AUTO_MODEL_ID } from "./constants.js"

const cfg = resolveConfig()

test("routes known roles by pattern and defaults the rest to syn:auto", () => {
  // Heavy roles -> large text.
  assert.equal(resolveAgentModel({ id: "reviewer" }, cfg)?.id, "syn:large:text")
  assert.equal(resolveAgentModel({ id: "build" }, cfg)?.id, "syn:large:text")
  // Light/research roles -> small text.
  assert.equal(resolveAgentModel({ id: "explore" }, cfg)?.id, "syn:small:text")
  // Vision roles -> large vision.
  assert.equal(resolveAgentModel({ id: "screenshot-analyzer" }, cfg)?.id, "syn:large:vision")
  // No pattern -> the router alias (which remaps to primary upstream).
  assert.equal(resolveAgentModel({ id: "totally-unknown" }, cfg)?.id, SYNTHETIC_AUTO_MODEL_ID)
  // Every routed target lives on the Synthetic provider.
  assert.equal(resolveAgentModel({ id: "build" }, cfg)?.providerID, "synthetic")
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
