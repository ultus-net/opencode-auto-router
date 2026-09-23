# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] — Unreleased

### Added
- OpenCode 2.x (V2 plugin API) support: dual-export `setup(ctx)` entrypoint
  alongside the V1 `server()` — the same drop-in file now loads on
  OpenCode 1.18.29+ and 2.x. The V2 path registers the `allowed_models`
  injection for all four model-request kinds (`context`, `compaction`,
  `generate`, `title`), resolves the default model via
  `ctx.model.transform`, and reads options via `ctx.options`.
- README: version-dependent install paths (plural `plugins/` on V2),
  config keys (`"plugins"` on V2), options forms (V2 object vs V1
  tuple), and uninstall paths.

### Changed
- Support floor raised to OpenCode **1.18.29** — the migration guide's
  floor for V1 object entrypoints (`@opencode-ai/plugin` peer aligned).
- package.json version 1.0.0 → 1.1.0; optional `@opencode/plugin` peer
  added; package-lock added.