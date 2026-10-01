# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — Unreleased

Project renamed: `opencode-openrouter-auto-latest` → **`opencode-auto-router`**
(<https://github.com/ultus-net/opencode-auto-router>). The scope grew from "make
OpenRouter aliases work" to "Synthetic-primary with automatic failover to the
Auto Router", which the old name no longer described.

### Added
- **Synthetic as the primary provider.** The plugin discovers Synthetic's
  permanent `syn:*` category aliases (`syn:large:text`, `syn:small:text`,
  `syn:large:vision`, `syn:small:vision`) from
  `https://api.synthetic.new/openai/v1/models` and registers them as OpenCode
  models with real context limits, vision capability, reasoning-effort variants
  (`synthetic/syn:large:text#high`), and pricing. These aliases are absent from
  models.dev, so they are not selectable without this.
- **Automatic cross-provider failover.** On a retryable Synthetic failure, the
  session switches to `openrouter/openrouter/auto` and the last user message is
  re-sent. Driven by the V2 event stream (`session.execution.failed`,
  `session.retry.scheduled`) with a bounded `retry` hook. A turn is replayed only
  when the failure is retryable, the session is still on Synthetic, and the
  failed turn produced no assistant output and ran no tools — so side effects
  cannot be duplicated. The attempt budget is configurable (default 1). See
  `src/failover.ts`.
- **Non-blocking setup.** Models register from the on-disk catalog immediately;
  fresh catalogs are fetched in the background and the providers reloaded when
  they arrive, so a slow or offline network does not delay startup.
- **TypeScript.** …the package is now authored in TypeScript, compiled to
  `dist/`.
- Default model and the built-in `title` agent are set from `primaryModel` /
  `smallModel` when unset (`setDefaultModel` / `setSmallModel`).
- Unit tests for config normalization, catalog mapping, alias resolution, and
  the failover controller (`npm test`, `node:test`).
- `npm run smoke`: a hermetic fake-host test that drives the built plugin's
  `setup()` (registration, defaults, injection, failover) with the network
  stubbed, so the whole wiring is exercisable offline.
- CI now runs install, typecheck, build, test, and smoke.

### Changed
- **Breaking:** the legacy V1 `server()` entrypoint is removed. Failover relies
  on the V2 event stream and catalog transforms, which have no V1 equivalent.
  OpenCode 2.x is now required. See the
  [V1→V2 migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1).
- Default OpenRouter pool is unchanged in spirit (frontier families), now
  configured via the `aliases` option.
- Package entrypoint is `dist/index.js` (built); `files` ships `dist/`.
- Repo/package/homepage URLs point at `opencode-auto-router`.

## [1.1.0]

### Added
- OpenCode 2.x (V2 plugin API) support: dual-export `setup(ctx)` entrypoint
  alongside the V1 `server()` — the same drop-in file loads on OpenCode
  1.18.29+ and 2.x. The V2 path registers the `allowed_models` injection for
  all four model-request kinds (`context`, `compaction`, `generate`, `title`),
  resolves the default model via `ctx.model.transform`, and reads options via
  `ctx.options`.
- README: version-dependent install paths (plural `plugins/` on V2), config
  keys (`"plugins"` on V2), options forms (V2 object vs V1 tuple), and uninstall
  paths.

### Changed
- Support floor raised to OpenCode **1.18.29** — the migration guide's floor for
  V1 object entrypoints (`@opencode-ai/plugin` peer aligned).
- package.json version 1.0.0 → 1.1.0; optional `@opencode/plugin` peer added;
  package-lock added.

## [1.0.0]

### Added
- Initial release: resolve OpenRouter `~…-latest` aliases to concrete slugs
  (`alias_target.slug`) and inject them as `allowed_models` into every
  `openrouter/auto` request, so the Auto Router works with the alias workflow.
- Optional setting of `openrouter/auto` as the default model.
- 6-hour memory + disk cache for the resolved pool.
- Documentation of the "Prevent overrides" interaction and the 404 failure mode.
