# Order-independent agent routing: evaluated and rejected

Status: **negative result.** The `setTimeout(0)` re-assert in `applyAgentRouting`
(`src/index.ts`) stays. No order-independent mechanism was found that (a) routes
custom markdown agents and (b) avoids pre-creating them, which would silently
drop their configured permissions.

## What was evaluated

"Discover custom agent ids via `ctx.agent.list()` and route by id, instead of
relying on transform registration order." Four candidate mechanisms were
checked against the host sources in `opencode-src`.

### 1. `ctx.agent.list()` at transform time - cannot see undiscovered agents

The host replays every transform from an empty base on each materialize, in
registration order:

- `packages/core/src/state.ts:78-83` - `materialize` starts from
  `options.initial()`, then runs `for (const transform of transforms)`.
- `packages/core/src/state.ts:112-115` - a new registration is appended
  (`transforms = [...transforms, transform]`), so order is registration order.

A routing transform that registered before `config-agent` runs before the
markdown documents are read. Inside that callback the draft holds only what
earlier transforms created (the built-ins from `plugin/agent.ts`). `list()`
therefore returns built-ins only, exactly like today. Nothing about reading ids
from the same draft escapes the replay order.

### 2. Getting ids from a snapshot, then `editor.update(id, ...)` - re-introduces the hazard

The pre-create hazard the current code is built to avoid:

- `packages/core/src/agent.ts:56-61` - `update` for an absent id does
  `draft.agents.get(id) ?? Info.empty(id)` and inserts it.
- `packages/core/src/config/plugin/agent.ts:88-90` - `const exists =
  draft.get(agentID) !== undefined; ... if (!exists) agent.permissions.push(...)`.

So if routing calls `update` for an id that is not yet in the draft, the agent
is fabricated bare and `config-agent` then sees `exists === true` and skips that
agent's configured permissions. Any "route by discovered id" scheme that acts
before the agent exists triggers this. The only safe ordering is to run after
`config-agent`, which is what the timer achieves.

### 3. An event that fires after `config-agent` - no publisher exists

- The client observes an `agent.updated` event
  (`opencode-src/packages/app/src/context/server-sync.tsx:561,594`), and the
  schema defines it, but no core/server/protocol publisher exists in the host
  source (grep for `Agent.Event` / `agent.updated` in `packages/core/src`,
  `packages/server/src`, `packages/protocol/src`, `packages/schema/src` returns
  nothing outside the app consumer and the generated OpenAPI fixture).
- `plugin.added` is published by the plugin service
  (`packages/core/src/plugin.ts:64`), but `config-agent` is booted before the
  external plugin loader (`packages/core/src/plugin/internal.ts:115` adds
  `ConfigAgentPlugin`, `:119` adds `ConfigExternalPlugin`). By the time this
  router's `setup` runs, `config-agent.added` has already fired; a subscription
  only sees future events.

There is no host event with a proven publisher that fires after `config-agent`
and before the first materialize that contains custom agents.

### 4. `ctx.agent.list()` outside the transform - not on the host-facing surface

The router targets the published promise API (`@opencode/plugin`). Its
`AgentDomain` does expose `list()`/`get()`
(`node_modules/@opencode/plugin/dist/promise/agent.d.ts:5-7`,
`.../promise/adapter.js:205-206`), but the host's own plugin promise bridge does
not: `opencode-src/packages/core/src/plugin/promise.ts:47-49` builds the agent
context with only `transform` and `reload`. Even where `list()` is callable, it
returns the *materialized* state (`packages/server/src/handlers/agent.ts:8-11` ->
`AgentV2.all()`), so polling it only tells you what the transform replay has
already produced - it does not give an ordering-independent id set.

## Why the current fix is the least-bad option

`config-agent` is the only discovery path for markdown agents, and the only way
to run after it is to register later. `setTimeout(0)` defers the re-register
past the boot batch so the appended transform sorts after `config-agent`
(`src/reach.test.ts` models the append and the retire). It is timing-based, but
the alternative mechanisms either cannot see the agents or re-introduce the
permission-skip.

## Next-best mitigation (not implemented here)

If the fixed delay is judged too fragile, the narrow improvement is to replace
the fixed `setTimeout(0)` in `scheduleReassert` with a **bounded poll of
`ctx.agent.list()`** that waits until at least one non-built-in agent is present,
then performs the same `reassertTransform` + slot retire. Rationale:

- It keys off observed agent presence rather than a magic delay.
- It does not call `update` before the agent exists, so it keeps the safety
  constraint intact.
- It stays within the same "register late" mechanism; it does not escape the
  ordering root cause and does not remove the timer entirely.

Caveats: it relies on `ctx.agent.list()` being present on the peer
`@opencode/plugin` (present in 2.0.21; `peerDependencies` allows `>=2.0.0`), and
still needs a timeout bound and a fallback. That is why it is left as a
documented option rather than shipped.
