import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveConfig } from "./config.js"
import {
  DEFAULT_AGENT_ROUTES,
  DEFAULT_ALIASES,
  SYNTHETIC_PRIMARY_MODEL_ID,
  SYNTHETIC_SMALL_MODEL_ID,
} from "./constants.js"

test("defaults are Synthetic-primary with failover on", () => {
  const c = resolveConfig()
  assert.equal(c.primaryModel, SYNTHETIC_PRIMARY_MODEL_ID)
  assert.equal(c.smallModel, SYNTHETIC_SMALL_MODEL_ID)
  assert.equal(c.autoModel, SYNTHETIC_PRIMARY_MODEL_ID)
  assert.deepEqual(c.agentRoutes, [...DEFAULT_AGENT_ROUTES])
  assert.equal(c.defaultAgentModel, SYNTHETIC_PRIMARY_MODEL_ID)
  assert.deepEqual(c.aliases, [...DEFAULT_ALIASES])
  assert.equal(c.setDefaultModel, true)
  assert.equal(c.setSmallModel, true)
  assert.equal(c.failover.enabled, true)
  assert.deepEqual(c.failover.statuses, [429])
  assert.equal(c.failover.maxAttempts, 1)
})

test("explicit models and aliases override defaults", () => {
  const c = resolveConfig({
    primaryModel: "syn:large:vision",
    smallModel: "syn:small:vision",
    aliases: ["~anthropic/claude-sonnet-latest"],
    costTier: "high",
    failover: { maxAttempts: 3, statuses: [429, 503], enabled: false },
    routing: {
      agentRoutes: [{ match: "review", model: "syn:small:text" }],
      defaultAgentModel: "syn:small:text",
    },
  })
  assert.equal(c.primaryModel, "syn:large:vision")
  assert.equal(c.smallModel, "syn:small:vision")
  assert.equal(c.autoModel, "syn:large:vision")
  assert.deepEqual(c.agentRoutes, [{ match: "review", model: "syn:small:text" }])
  assert.equal(c.defaultAgentModel, "syn:small:text")
  assert.deepEqual(c.aliases, ["~anthropic/claude-sonnet-latest"])
  assert.equal(c.costTier, "high")
  assert.equal(c.failover.enabled, false)
  assert.deepEqual(c.failover.statuses, [429, 503])
  assert.equal(c.failover.maxAttempts, 3)
})

test("malformed values fall back instead of throwing", () => {
  const c = resolveConfig({
    aliases: [] as unknown as string[],
    costTier: 42 as unknown as string,
    syntheticModels: ["not-an-alias", "syn:small:text"] as string[],
    requestTimeoutMs: -5,
    failover: { maxAttempts: 0 } as never,
  })
  assert.deepEqual(c.aliases, [...DEFAULT_ALIASES])
  assert.equal(c.costTier, undefined)
  assert.deepEqual(c.syntheticModels, ["syn:small:text"])
  assert.equal(c.requestTimeoutMs, 1)
  assert.equal(c.failover.maxAttempts, 1)
})

test("invalid routing entries are dropped, not fatal", () => {
  const c = resolveConfig({
    routing: {
      agentRoutes: [
        { match: "([", model: "syn:small:text" } as never,
        { match: "ok", model: "" } as never,
        { match: 42, model: "syn:large:text" } as never,
        { match: "valid", model: "syn:small:text" },
      ],
      defaultAgentModel: true as unknown as string,
    },
  })
  // Only the one compiling, non-empty route survives.
  assert.deepEqual(c.agentRoutes, [{ match: "valid", model: "syn:small:text" }])
  // A non-string defaultAgentModel falls back to the built-in.
  assert.equal(c.defaultAgentModel, SYNTHETIC_PRIMARY_MODEL_ID)
})
