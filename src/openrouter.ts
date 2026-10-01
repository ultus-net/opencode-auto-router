/**
 * OpenRouter `~…-latest` alias resolution for the Auto Router.
 *
 * OpenRouter's Auto Router accepts an `allowed_models` constraint, but that
 * constraint only matches *concrete catalog ids*:
 *
 *     allowed_models: ["anthropic/*", "openai/gpt-5.1"]    -> works
 *     allowed_models: ["~anthropic/claude-sonnet-latest"]  -> matches nothing
 *
 * The `~…-latest` aliases resolve fine as a top-level `model`, but inside
 * `allowed_models` they resolve to nothing, collapsing the candidate pool and
 * failing every request with:
 *
 *     404  No models match your request and model restrictions
 *
 * This module reads each alias's current target (`alias_target.slug`) from
 * OpenRouter's public catalog and caches the resolved concrete slug list.
 */

import { OPENROUTER_MODELS_URL } from "./constants.js"
import { log } from "./log.js"

interface RawModel {
  id?: string
  alias_target?: { slug?: string }
}

/** Map every `~…-latest` alias to the concrete slug it currently points at. */
export function aliasTargets(
  data: RawModel[],
): Map<string, string> {
  const targets = new Map<string, string>()
  for (const model of data) {
    const id = model.id
    const slug = model.alias_target?.slug
    if (typeof id === "string" && id.startsWith("~") && typeof slug === "string") {
      targets.set(id, slug)
    }
  }
  return targets
}

/** Reduce an alias list to the concrete slugs that currently resolve. */
export function resolvePool(
  aliases: readonly string[],
  targets: Map<string, string>,
): string[] {
  const seen = new Set<string>()
  const slugs: string[] = []
  for (const alias of aliases) {
    const slug = targets.get(alias)
    if (slug && !seen.has(slug)) {
      seen.add(slug)
      slugs.push(slug)
    }
  }
  return slugs
}

/** Fetch OpenRouter's catalog and return the alias -> slug map. */
export async function fetchAliasTargets(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: { accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`OpenRouter models fetch failed: ${res.status}`)
  }
  const body = (await res.json()) as { data?: RawModel[] }
  const targets = aliasTargets(body.data ?? [])
  log.debug("resolved", targets.size, "OpenRouter aliases")
  return targets
}
