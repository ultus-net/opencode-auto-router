/**
 * Hermetic smoke test for the built plugin.
 *
 * Loads dist/index.js, drives setup() against a fake OpenCode V2 host, and
 * asserts the observable wiring: catalog discovery, model registration, default
 * model, Auto Router injection, and a simulated rate-limit failover. Network is
 * stubbed, so this is deterministic and offline.
 *
 * Run: npm run smoke
 */

import assert from "node:assert/strict"
import fs from "node:fs"

// Isolate the plugin's disk cache BEFORE importing it, so the smoke test never
// reads a real ~/.cache catalog. cache.ts snapshots XDG_CACHE_HOME at import.
const cacheHome = new URL("../.tmp-smoke-cache", import.meta.url).pathname
fs.rmSync(cacheHome, { recursive: true, force: true })
process.env.XDG_CACHE_HOME = cacheHome
const { default: plugin } = await import("../dist/index.js")

const SYNTHETIC_BODY = {
  data: [
    {
      id: "syn:large:text",
      display_name: "DeepSeek V4.1 Flash",
      context_length: 524288,
      max_output_length: 65536,
      input_modalities: ["text", "image"],
      reasoning_parameters: { efforts: ["none", "low", "high"] },
      pricing: { prompt: "$0.0000006", completion: "$0.0000012" },
      created: 1700000000,
    },
    {
      id: "syn:small:text",
      display_name: "GLM 4.7 Flash",
      context_length: 196608,
      max_output_length: 65536,
      input_modalities: ["text"],
      reasoning_parameters: { efforts: ["none", "low"] },
      created: 1700000000,
    },
    { id: "hf:zai-org/GLM-4.7-Flash", display_name: "ignored concrete id" },
  ],
}

const OPENROUTER_BODY = {
  data: [
    { id: "~anthropic/claude-sonnet-latest", alias_target: { slug: "anthropic/claude-sonnet-5.5" } },
    { id: "~openai/gpt-latest", alias_target: { slug: "openai/gpt-6-astra" } },
    { id: "~missing/none-latest" },
  ],
}

globalThis.fetch = async (url) => {
  const body = String(url).includes("synthetic") ? SYNTHETIC_BODY : OPENROUTER_BODY
  return { ok: true, status: 200, async json() { return body } }
}

function makeHost() {
  const calls = { providerTransforms: 0, hooks: [], switchModel: [], prompt: [], reloads: 0 }

  const providerRecords = new Map([
    ["synthetic", { provider: {}, models: new Map() }],
    ["openrouter", { provider: {}, models: new Map() }],
  ])

  const eventQueue = []
  const eventWaiters = []
  let sessionModel = { providerID: "synthetic", id: "syn:large:text" }
  let sessionMessages = [{ type: "user", text: "do the thing" }]

  // Registered provider transforms are replayed by reload(), matching the
  // documented V2 semantics ("reload replays the active transforms").
  const providerTransformCbs = []
  const providerEditor = () => ({
    get: (id) => providerRecords.get(id),
    models: {
      set: (id, models) => {
        const rec = providerRecords.get(id) ?? { provider: {}, models: new Map() }
        rec.models = new Map(models.map((m) => [m.id, m]))
        providerRecords.set(id, rec)
      },
      update: () => {},
      remove: () => {},
    },
    update: () => {},
    remove: () => {},
    add: () => {},
    list: () => [...providerRecords.values()],
  })

  const ctx = {
    app: { name: "opencode", version: "2.0.0", channel: "test" },
    options: { setDefaultModel: true, setSmallModel: true },

    provider: {
      async transform(cb) {
        calls.providerTransforms += 1
        providerTransformCbs.push(cb)
        cb(providerEditor())
      },
      async reload() {
        calls.reloads += 1
        for (const cb of providerTransformCbs) cb(providerEditor())
      },
      list: async () => [],
      get: async () => ({}),
    },

    model: {
      async transform(cb) {
        let def
        cb({
          list: () => [], get: () => undefined, update: () => {}, remove: () => {},
          default: { get: () => def, set: (p, m) => { def = { providerID: p, modelID: m } } },
          provider: { list: () => [], get: () => undefined },
        })
        ctx.__default = def
      },
      reload: async () => {},
    },

    agent: {
      async transform(cb) {
        const agents = new Map([["title", { id: "title", model: undefined }]])
        cb({
          list: () => [...agents.values()],
          get: (id) => agents.get(id),
          default: () => {},
          update: (id, fn) => { const a = agents.get(id); if (a) fn(a) },
          remove: () => {},
        })
        ctx.__titleModel = agents.get("title")?.model
      },
    },

    session: {
      async hook(name, _cb, options) { calls.hooks.push({ name, options }) },
      async get() { return { model: sessionModel } },
      async context() { return sessionMessages },
      async switchModel({ model }) { calls.switchModel.push(model); sessionModel = model },
      async prompt({ text }) { calls.prompt.push(text); return {} },
    },

    event: {
      subscribe() {
        return {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              const next = eventQueue.length ? eventQueue.shift() : await new Promise((r) => eventWaiters.push(r))
              if (next === null) return
              yield next
            }
          },
        }
      },
    },
  }

  return {
    ctx,
    calls,
    providerRecords,
    setMessages: (m) => { sessionMessages = m },
    pushEvent: (e) => { const w = eventWaiters.shift(); if (w) w(e); else eventQueue.push(e) },
  }
}

const { ctx, calls, providerRecords, pushEvent } = makeHost()

assert.equal(plugin.id, "opencode-auto-router")
assert.equal(typeof plugin.setup, "function")

await plugin.setup(ctx)
await new Promise((r) => setTimeout(r, 50))

const synModels = [...providerRecords.get("synthetic").models.keys()].sort()
assert.deepEqual(synModels, ["syn:large:text", "syn:small:text"], "synthetic models: " + synModels)

const large = providerRecords.get("synthetic").models.get("syn:large:text")
assert.deepEqual(large.variants.map((v) => v.id), ["none", "low", "high"])
assert.deepEqual(large.limit, { context: 524288, output: 65536 })
// The alias must be distinguishable from the concrete model it targets.
assert.match(large.name, /syn:large:text/, "alias name must expose its own id")

assert.ok(providerRecords.get("openrouter").models.has("openrouter/auto"))

assert.deepEqual(ctx.__default, { providerID: "synthetic", modelID: "syn:large:text" })
assert.deepEqual(ctx.__titleModel, { providerID: "synthetic", id: "syn:small:text" })

for (const kind of ["context", "compaction", "generate", "title"]) {
  assert.ok(calls.hooks.some((h) => h.name === kind && h.options?.providerID === "openrouter"), "hook " + kind)
}
assert.ok(calls.hooks.some((h) => h.name === "retry" && h.options?.providerID === "synthetic"), "retry hook")

pushEvent({ type: "session.execution.failed", data: { sessionID: "ses_test", error: { status: 429, message: "rate limit" } } })
await new Promise((r) => setTimeout(r, 50))
assert.deepEqual(calls.switchModel, [{ providerID: "openrouter", id: "openrouter/auto" }])
assert.deepEqual(calls.prompt, ["do the thing"])

const unsafe = makeHost()
unsafe.setMessages([
  { type: "user", text: "do the thing" },
  { type: "assistant", content: [{ type: "tool", name: "bash" }] },
])
await plugin.setup(unsafe.ctx)
await new Promise((r) => setTimeout(r, 50))
unsafe.pushEvent({ type: "session.execution.failed", data: { sessionID: "ses_unsafe", error: { status: 429 } } })
await new Promise((r) => setTimeout(r, 50))
assert.deepEqual(unsafe.calls.switchModel, [], "must not replay a turn that ran tools")

console.log("smoke: OK")
console.log("  synthetic models:", synModels.join(", "))
console.log("  variants(syn:large:text):", large.variants.map((v) => v.id).join(", "))
console.log("  openrouter models:", [...providerRecords.get("openrouter").models.keys()].join(", "))
console.log("  default:", ctx.__default.providerID + "/" + ctx.__default.modelID)
console.log("  failover switched to:", calls.switchModel[0].providerID + "/" + calls.switchModel[0].id)
console.log("  unsafe turn replays:", unsafe.calls.switchModel.length)
