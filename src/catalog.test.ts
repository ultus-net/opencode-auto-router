import { test } from "node:test"
import assert from "node:assert/strict"

import { mapSyntheticModel } from "./synthetic.js"
import { normalizeSyntheticModel } from "./cache.js"
import { syntheticModelInfo } from "./models.js"
import { aliasTargets, resolvePool } from "./openrouter.js"

test("mapSyntheticModel keeps syn:* aliases and drops concrete ids", () => {
  // Raw shape verified against https://api.synthetic.new/openai/v1/models:
  // `name` == the alias id; `display_name` is the concrete target.
  const alias = mapSyntheticModel({
    id: "syn:large:text",
    name: "syn:large:text",
    display_name: "DeepSeek V4.1 Flash",
    context_length: 524288,
    max_output_length: 65536,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    reasoning_parameters: { efforts: ["none", "low", "high"] },
    supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
    pricing: { prompt: "$0.0000006", completion: "$0.0000012", input_cache_reads: "$0.00000003" },
    created: 1_700_000_000,
  })
  assert.ok(alias)
  assert.equal(alias?.id, "syn:large:text")
  // Name is the alias id, NOT the colliding display_name.
  assert.equal(alias?.name, "syn:large:text")
  assert.equal(alias?.target, "DeepSeek V4.1 Flash")
  assert.equal(alias?.context, 524288)
  assert.equal(alias?.output, 65536)
  assert.deepEqual(alias?.input, ["text", "image"])
  assert.equal(alias?.tools, true)
  assert.equal(alias?.structuredOutput, true)
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
    name: "syn:small:text",
    input_modalities: ["text"],
    output_modalities: ["text"],
  })
  assert.ok(m)
  assert.equal(m?.name, "syn:small:text")
  assert.deepEqual(m?.input, ["text"])
  assert.equal(m?.reasoning, false)
  // No supported_features -> tools defaults to true.
  assert.equal(m?.tools, true)
  assert.equal(m?.cost, undefined)
})

test("normalizeSyntheticModel repairs legacy caches missing booleans", () => {
  // Shape written by pre-2.0.0 plugins: no `tools`/`structuredOutput` and a
  // `name` that is the display name rather than the alias id.
  const legacy = normalizeSyntheticModel({
    id: "syn:large:text",
    name: "DeepSeek V4.1 Flash",
    context: 524288,
    output: 65536,
    input: ["text", "image"],
    reasoning: true,
    efforts: ["none", "high"],
  })
  assert.ok(legacy)
  assert.equal(legacy?.tools, true)
  assert.equal(legacy?.structuredOutput, false)
  assert.deepEqual(legacy?.input, ["text", "image"])

  // Explicit false must survive so tool-less models stay tool-less.
  assert.equal(normalizeSyntheticModel({ id: "syn:x", tools: false })?.tools, false)

  // Junk / non-source ids are dropped rather than coerced.
  assert.equal(normalizeSyntheticModel(null), undefined)
  assert.equal(normalizeSyntheticModel({ id: "hf:deepseek" }), undefined)
  assert.equal(normalizeSyntheticModel({ id: 42 }), undefined)
})

test("syntheticModelInfo always emits a boolean capabilities.tools", () => {
  const info = syntheticModelInfo({
    id: "syn:large:text",
    name: "syn:large:text",
    context: 200_000,
    output: 32_000,
    input: ["text"],
    // Simulate a legacy/undefined catalog value slipping through.
    tools: undefined as unknown as boolean,
    structuredOutput: false,
    reasoning: false,
    efforts: [],
  })
  assert.equal(typeof info.capabilities.tools, "boolean")
  assert.equal(info.capabilities.tools, true)
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
