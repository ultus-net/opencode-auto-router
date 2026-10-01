/**
 * Disk cache for the resolved Synthetic alias catalog.
 *
 * The catalog is small and changes rarely (Synthetic rotates the underlying
 * model, not the alias id), so a 6h memory TTL plus a disk fallback keeps
 * startup offline-safe: a network blip degrades to the last known aliases
 * instead of an empty provider.
 *
 * Cached entries cross a version boundary, so they are never trusted blindly:
 * an entry written by an older plugin cannot be assumed to have the current
 * shape. Every load re-runs `normalizeSyntheticModel`, which guarantees the
 * booleans OpenCode's `Model.Capabilities` schema requires. A `version` tag
 * discards caches from incompatible releases outright.
 */

import fs from "node:fs"
import path from "node:path"
import type { SyntheticCatalog, SyntheticModel } from "./types.js"

const CACHE_DIR =
  process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? ".", ".cache")

export const SYNTHETIC_CACHE_PATH = path.join(
  CACHE_DIR,
  "opencode",
  "auto-router-synthetic.json",
)

/** Bump whenever `SyntheticModel` changes shape incompatibly. */
export const SYNTHETIC_CACHE_VERSION = 2

const DEFAULT_CONTEXT = 200_000
const DEFAULT_OUTPUT = 32_000

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function asModalities(value: unknown): ("text" | "image")[] {
  if (!Array.isArray(value)) return ["text"]
  const set = new Set<"text" | "image">()
  for (const item of value) {
    if (item === "text" || item === "image") set.add(item)
  }
  if (set.size === 0) set.add("text")
  return [...set]
}

function asEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asCost(value: unknown): SyntheticModel["cost"] {
  if (typeof value !== "object" || value === null) return undefined
  const raw = value as Record<string, unknown>
  const input = asOptionalNumber(raw.input)
  const output = asOptionalNumber(raw.output)
  const cacheRead = asOptionalNumber(raw.cache_read)
  if (input === undefined && output === undefined && cacheRead === undefined) {
    return undefined
  }
  return { input, output, cache_read: cacheRead }
}

/**
 * Coerce an untrusted (cached) record into a valid `SyntheticModel`.
 *
 * `tools` in particular MUST end up a boolean: `Model.Capabilities.tools` is
 * `Schema.Boolean`, and a missing value previously flowed straight into the
 * provider transform, turning the whole `/api/model` response into a 400
 * ("Expected boolean at [...capabilities.tools]").
 */
export function normalizeSyntheticModel(value: unknown): SyntheticModel | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const m = value as Record<string, unknown>
  const id = m.id
  if (typeof id !== "string" || !id.startsWith("syn:")) return undefined

  return {
    id,
    name: typeof m.name === "string" && m.name.length > 0 ? m.name : id,
    target: typeof m.target === "string" ? m.target : undefined,
    context: asNumber(m.context, DEFAULT_CONTEXT),
    output: asNumber(m.output, DEFAULT_OUTPUT),
    input: asModalities(m.input),
    // Absent tools means "unknown", which historically defaulted to supported.
    tools: typeof m.tools === "boolean" ? m.tools : true,
    structuredOutput: m.structuredOutput === true,
    reasoning: m.reasoning === true,
    efforts: asEfforts(m.efforts),
    released: typeof m.released === "number" ? m.released : undefined,
    cost: asCost(m.cost),
  }
}

export function loadSyntheticCache(): SyntheticCatalog | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(SYNTHETIC_CACHE_PATH, "utf8"),
    )
    if (typeof parsed !== "object" || parsed === null) return undefined
    const { aliases, at, version } = parsed as Record<string, unknown>
    // Incompatible cache: force a refetch instead of feeding the host a
    // half-shaped model.
    if (version !== SYNTHETIC_CACHE_VERSION) return undefined
    if (Array.isArray(aliases) && aliases.length > 0) {
      return {
        aliases: aliases
          .map(normalizeSyntheticModel)
          .filter((m): m is SyntheticModel => m !== undefined),
        at: typeof at === "number" ? at : 0,
      }
    }
  } catch {
    // Missing or unreadable cache is not an error; the caller refetches.
  }
  return undefined
}

export function saveSyntheticCache(catalog: SyntheticCatalog): void {
  try {
    fs.mkdirSync(path.dirname(SYNTHETIC_CACHE_PATH), { recursive: true })
    fs.writeFileSync(
      SYNTHETIC_CACHE_PATH,
      JSON.stringify({ ...catalog, version: SYNTHETIC_CACHE_VERSION }),
    )
  } catch {
    // Best-effort cache; failing to persist must never fail a request.
  }
}