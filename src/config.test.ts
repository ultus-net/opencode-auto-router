import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveConfig } from "./config.js"
import {
  DEFAULT_AGENT_ROUTES,
  DEFAULT_ALIASES,
  SYNTHETIC_AUTO_MODEL_ID,
  SYNTHETIC_PRIMARY_MODEL_ID,
  SYNTHETIC_SMALL_MODEL_ID,
} from "./constants.js"

test("defaults are Synthetic-primary with failover on", () => {
  const c = resolveConfig()
  assert.equal(c.primaryModel, SYNTHETIC_PRIMARY_MODEL_ID)
  assert.equal(c.smallModel, SYNTHETIC_SMALL_MODEL_ID)
  assert.deepEqual(c.agentRoutes, [...DEFAULT_AGENT_ROUTES])
  assert.equal(c.defaultAgentModel, SYNTHETIC_AUTO_MODEL_ID)
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
    // A non-syn primary is rejected, not passed through.
    primaryModel: "gpt-5" as unknown as string,
  })
  assert.deepEqual(c.aliases, [...DEFAULT_ALIASES])
  assert.equal(c.costTier, undefined)
  assert.deepEqual(c.syntheticModels, ["syn:small:text"])
  assert.equal(c.requestTimeoutMs, 1)
  assert.equal(c.failover.maxAttempts, 1)
  assert.equal(c.primaryModel, SYNTHETIC_PRIMARY_MODEL_ID)
})

test("invalid routing entries are dropped, not fatal", () => {
  const c = resolveConfig({
    routing: {
      agentRoutes: [
        { match: "([", model: "syn:small:text" } as never, // bad regex
        { match: "ok", model: "" } as never, // empty model
        { match: "ok", model: "gpt-5" } as never, // not a syn:* alias
        { match: 42, model: "syn:large:text" } as never, // not a string
        { match: "valid", model: "syn:small:text" },
      ],
      defaultAgentModel: "gpt-5" as unknown as string,
    },
  })
  // Only the one compiling, non-empty, syn:* route survives.
  assert.deepEqual(c.agentRoutes, [{ match: "valid", model: "syn:small:text" }])
  // A non-syn default falls back to the router alias.
  assert.equal(c.defaultAgentModel, SYNTHETIC_AUTO_MODEL_ID)
})
