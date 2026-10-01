/**
 * Live end-to-end check of the Auto Router injection against OpenRouter.
 *
 * Proves the core mechanism with the real API:
 *   - resolved concrete slugs in allowed_models -> the Auto Router routes (200)
 *   - a raw ~...-latest alias in allowed_models -> collapses the pool (404)
 *
 * Reads the OpenRouter key from OPENROUTER_API_KEY or the OpenCode auth store.
 * Run: node scripts/e2e-openrouter.mjs
 */

import fs from "node:fs"
import { aliasTargets, resolvePool } from "../dist/openrouter.js"
import { DEFAULT_ALIASES } from "../dist/constants.js"

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
  const authPath = process.env.HOME + "/.local/share/opencode/auth.json"
  return JSON.parse(fs.readFileSync(authPath, "utf8")).openrouter?.key
}

const key = apiKey()
if (!key) throw new Error("No OpenRouter key found")

const catalog = await (await fetch("https://openrouter.ai/api/v1/models")).json()
const pool = resolvePool(DEFAULT_ALIASES, aliasTargets(catalog.data))
console.log("resolved " + pool.length + " concrete slugs from " + DEFAULT_ALIASES.length + " aliases")

async function ask(label, allowedModels) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({
      model: "openrouter/auto",
      max_tokens: 5,
      messages: [{ role: "user", content: "reply with exactly: OK" }],
      plugins: [{ id: "auto-router", allowed_models: allowedModels }],
    }),
  })
  const text = await res.text()
  let routed
  try { routed = JSON.parse(text).model } catch {}
  console.log(label + "HTTP " + res.status + (routed ? " (routed to " + routed + ")" : ""))
  if (res.status !== 200) console.log("    body: " + text.slice(0, 200))
  return res.status
}

console.log("")
console.log("[injected] allowed_models = resolved concrete slugs:")
const ok = await ask("  ", pool)

console.log("")
console.log("[control] allowed_models = [~anthropic/claude-sonnet-latest] (raw alias):")
const bad = await ask("  ", ["~anthropic/claude-sonnet-latest"])

if (ok !== 200) throw new Error("expected 200 with resolved pool, got " + ok)
console.log("")
console.log(bad === 404 ? "OK: control reproduced the 404 the plugin fixes" : "NOTE: control returned " + bad)
