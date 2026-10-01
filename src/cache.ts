/**
 * Disk cache for the resolved Synthetic alias catalog.
 *
 * The catalog is small and changes rarely (Synthetic rotates the underlying
 * model, not the alias id), so a 6h memory TTL plus a disk fallback keeps
 * startup offline-safe: a network blip degrades to the last known aliases
 * instead of an empty provider.
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

function isSyntheticModel(value: unknown): value is SyntheticModel {
  if (typeof value !== "object" || value === null) return false
  const m = value as Record<string, unknown>
  return typeof m.id === "string" && typeof m.name === "string"
}

export function loadSyntheticCache(): SyntheticCatalog | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(SYNTHETIC_CACHE_PATH, "utf8"),
    )
    if (typeof parsed !== "object" || parsed === null) return undefined
    const { aliases, at } = parsed as Record<string, unknown>
    if (Array.isArray(aliases) && aliases.length > 0) {
      return {
        aliases: aliases.filter(isSyntheticModel),
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
    fs.writeFileSync(SYNTHETIC_CACHE_PATH, JSON.stringify(catalog))
  } catch {
    // Best-effort cache; failing to persist must never fail a request.
  }
}
