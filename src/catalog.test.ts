import { test } from "node:test"
import assert from "node:assert/strict"

import { mapSyntheticModel } from "./synthetic.js"
import { aliasTargets, resolvePool } from "./openrouter.js"

test("mapSyntheticModel keeps syn:* aliases and drops concrete ids", () => {
  const alias = mapSyntheticModel({
    id: "syn:large:text",
    display_name: "DeepSeek V4.1 Flash",
    context_length: 524288,
    max_output_length: 65536,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    reasoning_parameters: { efforts: ["none", "low", "high"] },
    pricing: { prompt: "$0.0000006", completion: "$0.0000012", input_cache_reads: "$0.00000003" },
    created: 1_700_000_000,
  })
  assert.ok(alias)
  assert.equal(alias?.id, "syn:large:text")
  assert.equal(alias?.name, "DeepSeek V4.1 Flash")
  assert.equal(alias?.context, 524288)
  assert.equal(alias?.output, 65536)
  assert.deepEqual(alias?.input, ["text", "image"])
  assert.equal(alias?.reasoning, true)
  // $0.0000006/token -> $0.6/M
  assert.equal(alias?.cost?.input, 0.6)
  assert.equal(alias?.cost?.output, 1.2)

  assert.equal(mapSyntheticModel({ id: "hf:zai-org/GLM-4.7-Flash" }), undefined)
  assert.equal(mapSyntheticModel({}), undefined)
})

test("mapSyntheticModel marks text-only models without reasoning effort", () => {
  const m = mapSyntheticModel({
    id: "syn:small:text",
    input_modalities: ["text"],
    output_modalities: ["text"],
  })
  assert.ok(m)
  assert.deepEqual(m?.input, ["text"])
  assert.equal(m?.reasoning, false)
  assert.equal(m?.cost, undefined)
})

test("aliasTargets maps only ~aliases that resolve", () => {
  const targets = aliasTargets([
    { id: "~anthropic/claude-sonnet-latest", alias_target: { slug: "anthropic/claude-sonnet-5" } },
    { id: "~openai/gpt-latest" },
    { id: "anthropic/claude-sonnet-5" },
  ])
  assert.equal(targets.size, 1)
  assert.equal(targets.get("~anthropic/claude-sonnet-latest"), "anthropic/claude-sonnet-5")
})

test("resolvePool preserves order, keeps first slug per alias, dedupes", () => {
  const targets = new Map([
    ["~a/one-latest", "a/one-1"],
    ["~b/two-latest", "b/two-1"],
  ])
  const pool = resolvePool(
    ["~a/one-latest", "~missing/x-latest", "~b/two-latest", "~a/one-latest"],
    targets,
  )
  assert.deepEqual(pool, ["a/one-1", "b/two-1"])
})
