import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveConfig } from "./config.js"
import { routeAgents, type RoutingEditor } from "./routing.js"
import { makeTransformSlot, reassertTransform, type TransformRegistration } from "./index.js"

const cfg = resolveConfig()

/**
 * Models the host's transform list (`core/src/state.ts:114` append, `:100`
 * dispose removes). Re-registering appends, so the newest transform sorts last.
 */
function makeRegistry() {
  const transforms: string[] = []
  const register = (name: string): TransformRegistration => {
    transforms.push(name)
    return {
      dispose: async () => {
        const at = transforms.indexOf(name)
        if (at !== -1) transforms.splice(at, 1)
      },
    }
  }
  return { transforms, register }
}

test("reassertTransform appends the new transform after the earlier one and retires the early one", async () => {
  const registry = makeRegistry()
  const early = registry.register("router-early")
  registry.register("config-agent")

  const late = await reassertTransform(async () => registry.register("router-late"), early)

  assert.deepEqual(registry.transforms, ["config-agent", "router-late"])
  assert.ok(late.dispose, "returns the fresh registration handle")
})

test("reassertTransform still disposes the early transform when re-registration fails", async () => {
  const registry = makeRegistry()
  const early = registry.register("router-early")
  registry.register("config-agent")

  await assert.rejects(
    reassertTransform(async () => {
      throw new Error("host refused the transform")
    }, early),
    /refused/,
  )
  assert.deepEqual(registry.transforms, ["config-agent"], "no mis-ordered transform is left live")
})

test("reassertTransform tolerates a handle without dispose", async () => {
  const early = {} as TransformRegistration
  const late = { dispose: async () => {} }
  await assert.doesNotReject(reassertTransform(async () => late, early))
})

test("transform slot retires the previous registration on re-init (no accumulation)", async () => {
  const registry = makeRegistry()
  const slot = makeTransformSlot()
  slot.set(registry.register("router-first"))
  assert.deepEqual(registry.transforms, ["router-first"])

  await slot.retire()
  slot.set(registry.register("router-second"))
  assert.deepEqual(registry.transforms, ["router-second"], "first registration was retired")

  // A missing dispose must not throw or strand the slot.
  slot.set({} as TransformRegistration)
  await assert.doesNotReject(slot.retire())
  assert.equal(slot.active, undefined)
})

test("routeAgents is idempotent: a double-registration window does not change the result", () => {
  const agents = new Map([
    ["reviewer", { id: "reviewer" } as { id: string; model?: { providerID?: string; id?: string } }],
    ["executor", { id: "executor" }],
  ])
  const editor: RoutingEditor = {
    list: () => [...agents.values()],
    update: (id, fn) => {
      const current = agents.get(id) ?? { id }
      agents.set(id, current)
      fn(current)
    },
  }
  const first = routeAgents(editor, cfg)
  assert.ok(first.length > 0, "resolveConfig must yield routes for this test to be meaningful")
  const afterFirst = JSON.stringify([...agents.values()])
  const second = routeAgents(editor, cfg)
  assert.deepEqual(second, first)
  assert.equal(JSON.stringify([...agents.values()]), afterFirst, "second pass is a no-op")
})
