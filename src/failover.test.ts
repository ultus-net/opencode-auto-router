import { test } from "node:test"
import assert from "node:assert/strict"

import { FailoverController, isRetryable, type FailoverHost, type ModelRef } from "./failover.js"
import { resolveConfig } from "./config.js"
import { OPENROUTER_AUTO_MODEL_ID, OPENROUTER_PROVIDER_ID, SYNTHETIC_PROVIDER_ID } from "./constants.js"

const config = resolveConfig()

function hostFor(model: ModelRef | undefined, text: string | undefined) {
  const calls: string[] = []
  let current = model
  const host: FailoverHost = {
    async getSessionModel() {
      return current
    },
    async lastUserText() {
      return text
    },
    async switchModel(_sessionID, next) {
      calls.push(`switch:${next.providerID}/${next.id}`)
      current = next
    },
    async prompt(_sessionID, sent) {
      calls.push(`prompt:${sent}`)
      return {}
    },
  }
  return { host, calls }
}

test("isRetryable matches status and message heuristics", () => {
  assert.equal(isRetryable({ status: 429 }, config), true)
  assert.equal(isRetryable({ message: "Rate limit exceeded" }, config), true)
  assert.equal(isRetryable({ type: "rate_limit_error" }, config), true)
  assert.equal(isRetryable({ status: 400, message: "bad request" }, config), false)
})

test("boundRetry caps Synthetic retries then stops", () => {
  const { host } = hostFor({ providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" }, "hi")
  const controller = new FailoverController(config, host)

  const first = {
    model: { providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" },
    error: { status: 429 },
    attempt: 1,
    decision: { retry: false } as { retry: false } | { retry: true; delay: number },
  }
  assert.equal(controller.boundRetry(first), true)
  assert.deepEqual(first.decision, { retry: true, delay: 1000 })

  const second = {
    model: { providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" },
    error: { status: 429 },
    attempt: 2,
    decision: { retry: true, delay: 9999 } as { retry: false } | { retry: true; delay: number },
  }
  controller.boundRetry(second)
  assert.deepEqual(second.decision, { retry: false })
})

test("boundRetry ignores OpenRouter and non-retryable errors", () => {
  const { host } = hostFor({ providerID: SYNTHETIC_PROVIDER_ID, id: "x" }, "hi")
  const controller = new FailoverController(config, host)
  const decision = { retry: false } as { retry: false } | { retry: true; delay: number }

  assert.equal(
    controller.boundRetry({
      model: { providerID: OPENROUTER_PROVIDER_ID, id: OPENROUTER_AUTO_MODEL_ID },
      error: { status: 429 },
      attempt: 1,
      decision,
    }),
    false,
  )
  assert.equal(
    controller.boundRetry({
      model: { providerID: SYNTHETIC_PROVIDER_ID, id: "x" },
      error: { status: 500 },
      attempt: 1,
      decision,
    }),
    false,
  )
})

test("onExecutionFailed switches to OpenRouter and replays the turn", async () => {
  const { host, calls } = hostFor({ providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" }, "do the thing")
  const controller = new FailoverController(config, host)

  await controller.onExecutionFailed("ses_1", { status: 429, message: "rate limit" })

  assert.deepEqual(calls, [`switch:${OPENROUTER_PROVIDER_ID}/${OPENROUTER_AUTO_MODEL_ID}`, "prompt:do the thing"])
})

test("onExecutionFailed refuses to loop once off Synthetic", async () => {
  const { host, calls } = hostFor({ providerID: OPENROUTER_PROVIDER_ID, id: OPENROUTER_AUTO_MODEL_ID }, "again")
  const controller = new FailoverController(config, host)

  await controller.onExecutionFailed("ses_2", { status: 429 })
  assert.deepEqual(calls, [])
})

test("onExecutionFailed stops after the attempt budget", async () => {
  const scoped = resolveConfig({ failover: { maxAttempts: 1 } })
  const { host, calls } = hostFor({ providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" }, "text")
  const controller = new FailoverController(scoped, host)

  await controller.onExecutionFailed("ses_3", { status: 429 })
  // Simulate the fallback also failing and somehow still reporting Synthetic.
  await controller.onExecutionFailed("ses_3", { status: 429 })
  assert.equal(calls.filter((c) => c.startsWith("switch:")).length, 1)
})

test("onExecutionFailed does nothing when disabled", async () => {
  const off = resolveConfig({ failover: { enabled: false } })
  const { host, calls } = hostFor({ providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" }, "text")
  const controller = new FailoverController(off, host)
  await controller.onExecutionFailed("ses_4", { status: 429 })
  assert.deepEqual(calls, [])
})
