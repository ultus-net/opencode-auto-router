/**
 * Synthetic catalog: resolve the permanent `syn:*` aliases to OpenCode models.
 *
 * Synthetic publishes category aliases (`syn:large:text`, `syn:small:text`,
 * `syn:large:vision`, `syn:small:vision`) that always point at the current best
 * model for that category. They are absent from the public models.dev catalog,
 * so the plugin discovers them from Synthetic's OpenAI-compatible `/models`
 * endpoint and registers them as OpenCode models.
 *
 * Only `syn:*` ids are kept. Concrete `hf:*` ids are intentionally ignored:
 * the whole point is to never pin a version by hand.
 */

import { SYNTHETIC_MODELS_URL } from "./constants.js"
import { log } from "./log.js"
import type { SyntheticCatalog, SyntheticModel } from "./types.js"

interface RawPricing {
  prompt?: string
  completion?: string
  input_cache_reads?: string
}

interface RawModel {
  id?: string
  name?: string
  display_name?: string
  context_length?: number
  max_output_length?: number
  input_modalities?: string[]
  output_modalities?: string[]
  reasoning_parameters?: { efforts?: string[] }
  supported_features?: string[]
  pricing?: RawPricing
  created?: number
}

export const SYN_ALIAS_PREFIX = "syn:"

/**
 * Synthetic reports per-token prices as currency strings (e.g. "$0.0000006").
 * OpenCode costs are USD per million tokens, so multiply by 1e6.
 */
function perMillion(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined
  const n = Number.parseFloat(value.replace(/[^0-9.eE+-]/g, ""))
  if (!Number.isFinite(n)) return undefined
  return n * 1_000_000
}

function toInputModalities(raw: string[] | undefined): ("text" | "image")[] {
  const set = new Set<"text" | "image">(raw?.includes("image") ? ["text", "image"] : ["text"])
  if (raw?.includes("text")) set.add("text")
  return [...set]
}

export function mapSyntheticModel(raw: RawModel): SyntheticModel | undefined {
  if (typeof raw.id !== "string" || !raw.id.startsWith(SYN_ALIAS_PREFIX)) {
    return undefined
  }
  const efforts = raw.reasoning_parameters?.efforts ?? []
  const cost =
    perMillion(raw.pricing?.prompt) === undefined &&
    perMillion(raw.pricing?.completion) === undefined
      ? undefined
      : {
          input: perMillion(raw.pricing?.prompt),
          output: perMillion(raw.pricing?.completion),
          cache_read: perMillion(raw.pricing?.input_cache_reads),
        }
  return {
    id: raw.id,
    // Synthetic sets `name` to the alias id and `display_name` to the concrete
    // model it routes to (e.g. id/name "syn:large:text", display_name
    // "DeepSeek V4.1 Flash"). The alias id is the stable, unique name; the
    // display_name is kept only as a human-readable `target`.
    name: raw.name ?? raw.id,
    target: raw.display_name,
    context: raw.context_length ?? 200_000,
    output: raw.max_output_length ?? 32_000,
    input: toInputModalities(raw.input_modalities),
    tools: raw.supported_features?.includes("tools") ?? true,
    structuredOutput: raw.supported_features?.includes("structured_outputs") ?? false,
    reasoning: efforts.length > 0,
    efforts,
    released: raw.created,
    cost,
  }
}

/**
 * Fetch and reduce Synthetic's catalog to its `syn:*` aliases.
 * Throws on network/parse failure so the caller can fall back to cache.
 */
export async function fetchSyntheticCatalog(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SyntheticCatalog> {
  const res = await fetch(SYNTHETIC_MODELS_URL, {
    headers: { accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`Synthetic models fetch failed: ${res.status}`)
  }
  const body = (await res.json()) as { data?: RawModel[] }
  const aliases = (body.data ?? [])
    .map(mapSyntheticModel)
    .filter((m): m is SyntheticModel => m !== undefined)

  if (aliases.length === 0) {
    log.warn("Synthetic catalog returned no `syn:*` aliases")
  }
  return { aliases, at: Date.now() }
}
