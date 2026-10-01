/**
 * Runtime state: memoized catalogs with a disk-backed fallback.
 *
 * Both catalogs (Synthetic `syn:*` and OpenRouter `~…-latest` targets) are
 * warmed once at setup and served from memory for `CACHE_TTL_MS`. A refresh
 * failure never clears the last good value, so a transient network error
 * degrades to slightly stale data rather than a broken provider.
 */

import { CACHE_TTL_MS } from "./constants.js"
import { loadSyntheticCache, saveSyntheticCache } from "./cache.js"
import { log } from "./log.js"
import { fetchAliasTargets, resolvePool } from "./openrouter.js"
import { fetchSyntheticCatalog } from "./synthetic.js"
import type { ResolvedConfig, SyntheticCatalog } from "./types.js"

interface Entry<T> {
  at: number
  value: T
}

let syntheticCache: SyntheticCatalog | undefined = loadSyntheticCache()
let poolCache: Entry<string[]> | undefined
let syntheticInflight: Promise<SyntheticCatalog | undefined> | undefined
let poolInflight: Promise<string[]> | undefined

function fresh<T>(entry: Entry<T> | undefined): boolean {
  return entry !== undefined && Date.now() - entry.at < CACHE_TTL_MS
}

function syntheticFresh(catalog: SyntheticCatalog | undefined): boolean {
  return catalog !== undefined && Date.now() - catalog.at < CACHE_TTL_MS
}
/**
 * Resolve the Synthetic `syn:*` alias catalog, refreshing at most every
 * `CACHE_TTL_MS`. Returns the last known catalog on failure.
 */
export async function resolveSynthetic(
  config: ResolvedConfig,
): Promise<SyntheticCatalog | undefined> {
  if (syntheticFresh(syntheticCache)) return syntheticCache
  if (syntheticInflight) return syntheticInflight

  syntheticInflight = (async () => {
    try {
      const next = await fetchSyntheticCatalog(config.requestTimeoutMs)
      if (next.aliases.length > 0) {
        syntheticCache = next
        saveSyntheticCache(next)
      }
    } catch (error) {
      log.warn("Synthetic catalog refresh failed; using cache", error)
    } finally {
      syntheticInflight = undefined
    }
    return syntheticCache
  })()

  return syntheticInflight
}

/**
 * Resolve the OpenRouter `~…-latest` pool to concrete slugs for
 * `allowed_models`, refreshing at most every `CACHE_TTL_MS`.
 */
export async function resolveOpenRouterPool(
  config: ResolvedConfig,
): Promise<string[]> {
  if (fresh(poolCache)) return poolCache?.value ?? []
  if (poolInflight) return poolInflight

  poolInflight = (async () => {
    try {
      const targets = await fetchAliasTargets(config.requestTimeoutMs)
      const slugs = resolvePool(config.aliases, targets)
      if (slugs.length > 0) poolCache = { at: Date.now(), value: slugs }
    } catch (error) {
      log.warn("OpenRouter alias refresh failed; using cache", error)
    } finally {
      poolInflight = undefined
    }
    return poolCache?.value ?? []
  })()

  return poolInflight
}

/** Warm both catalogs so the first request does not wait on the network. */
export async function warm(config: ResolvedConfig): Promise<void> {
  await Promise.allSettled([
    resolveSynthetic(config),
    resolveOpenRouterPool(config),
  ])
}

/**
 * The currently known Synthetic catalog without any network access: the disk
 * cache loaded at import time, or the last successful refresh. Lets setup
 * register models immediately and refresh in the background.
 */
export function currentSynthetic(): SyntheticCatalog | undefined {
  return syntheticCache
}

/** Test seam: drop all memoized state. */
export function resetStateForTests(): void {
  syntheticCache = undefined
  poolCache = undefined
  syntheticInflight = undefined
  poolInflight = undefined
}
