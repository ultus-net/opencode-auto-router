import { test } from "node:test"
import assert from "node:assert/strict"

import { FailoverController, isRetryable, type FailoverHost, type ModelRef, type ReplayCandidate } from "./failover.js"
import { resolveConfig } from "./config.js"
import { OPENROUTER_AUTO_MODEL_ID, OPENROUTER_PROVIDER_ID, SYNTHETIC_PROVIDER_ID } from "./constants.js"

const config = resolveConfig()

function hostFor(candidate: ReplayCandidate | undefined, model: ModelRef | undefined) {
  const calls: string[] = []
  let current = model
  const host: FailoverHost = {
    async getSessionModel() {
      return current
    },
    async replayCandidate() {
      return candidate
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

const SAFE = { text: "do the thing", safe: true }
const UNSAFE = { text: "do the thing", safe: false }

test("isRetryable matches status and message heuristics", () => {
  assert.equal(isRetryable({ status: 429 }, config), true)
  assert.equal(isRetryable({ message: "Rate limit exceeded" }, config), true)
  assert.equal(isRetryable({ type: "rate_limit_error" }, config), true)
  assert.equal(isRetryable({ status: 400, message: "bad request" }, config), false)
})

test("boundRetry caps Synthetic retries then stops", () => {
  const { host } = hostFor(SAFE, { providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" })
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
  const { host } = hostFor(SAFE, { providerID: SYNTHETIC_PROVIDER_ID, id: "x" })
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
  const { host, calls } = hostFor(SAFE, { providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" })
  const controller = new FailoverController(config, host)

  await controller.onExecutionFailed("ses_1", { status: 429, message: "rate limit" })

  assert.deepEqual(calls, [`switch:${OPENROUTER_PROVIDER_ID}/${OPENROUTER_AUTO_MODEL_ID}`, "prompt:do the thing"])
})

test("onExecutionFailed refuses to loop once off Synthetic", async () => {
  const { host, calls } = hostFor(SAFE, { providerID: OPENROUTER_PROVIDER_ID, id: OPENROUTER_AUTO_MODEL_ID })
  const controller = new FailoverController(config, host)

  await controller.onExecutionFailed("ses_2", { status: 429 })
  assert.deepEqual(calls, [])
})

test("onExecutionFailed stops after the attempt budget", async () => {
  const scoped = resolveConfig({ failover: { maxAttempts: 1 } })
  const { host, calls } = hostFor(SAFE, { providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" })
  const controller = new FailoverController(scoped, host)

  await controller.onExecutionFailed("ses_3", { status: 429 })
  // Simulate the fallback also failing and somehow still reporting Synthetic.
  await controller.onExecutionFailed("ses_3", { status: 429 })
  assert.equal(calls.filter((c) => c.startsWith("switch:")).length, 1)
})

test("onExecutionFailed does nothing when disabled", async () => {
  const off = resolveConfig({ failover: { enabled: false } })
  const { host, calls } = hostFor(SAFE, { providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" })
  const controller = new FailoverController(off, host)
  await controller.onExecutionFailed("ses_4", { status: 429 })
  assert.deepEqual(calls, [])
})

test("onExecutionFailed refuses to replay a turn that already produced output", async () => {
  const { host, calls } = hostFor(UNSAFE, { providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" })
  const controller = new FailoverController(config, host)
  await controller.onExecutionFailed("ses_5", { status: 429 })
  assert.deepEqual(calls, [])
})

test("onExecutionFailed does nothing when there is no user turn to replay", async () => {
  const { host, calls } = hostFor(undefined, { providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" })
  const controller = new FailoverController(config, host)
  await controller.onExecutionFailed("ses_6", { status: 429 })
  assert.deepEqual(calls, [])
})

test("onExecutionFailed does nothing for a non-retryable error", async () => {
  const { host, calls } = hostFor(SAFE, { providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" })
  const controller = new FailoverController(config, host)
  await controller.onExecutionFailed("ses_7", { status: 400, message: "bad request" })
  assert.deepEqual(calls, [])
})

test("onExecutionFailed swallows host errors without crashing", async () => {
  const host: FailoverHost = {
    async getSessionModel() {
      return { providerID: SYNTHETIC_PROVIDER_ID, id: "syn:large:text" }
    },
    async replayCandidate() {
      return SAFE
    },
    async switchModel() {
      throw new Error("switch failed")
    },
    async prompt() {
      return {}
    },
  }
  const controller = new FailoverController(config, host)
  await assert.doesNotReject(controller.onExecutionFailed("ses_8", { status: 429 }))
})

