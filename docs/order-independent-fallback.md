# Order-independent agent routing: evaluated and rejected

Status: **negative result.** The `setTimeout(0)` re-assert in `applyAgentRouting`
(`src/index.ts`) stays. No order-independent mechanism was found that (a) routes
custom markdown agents and (b) avoids pre-creating them, which would silently
drop their configured permissions. The shipped fix is itself timing-based, so
this record deliberately does **not** claim it is order-independent.

Host sources are pinned to `opencode-src` revision
`3dd1b3053979971d8eb03ef37b29de07b892d95c` (2026-09-18). Line numbers are only
valid against that revision.

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

Claim 1 says a pre-`config-agent` router cannot see the discovered ids. The
remaining route to "route by a discovered id" is therefore to obtain the ids
from a **materialized** snapshot (a later pass, an external `list()` call, or a
cached set) and then apply them in an earlier transform - or in any pass that
runs before the agent exists in that pass's draft. That is where the
pre-create hazard bites:

- `packages/core/src/agent.ts:56-61` - `update` for an absent id does
  `draft.agents.get(id) ?? Info.empty(id)` and inserts it.
- `packages/core/src/config/plugin/agent.ts:~88-90` - `const exists =
  draft.get(agentID) !== undefined; ... if (!exists) agent.permissions.push(...)`.

So if routing calls `update` for an id that is not yet in **that pass's** draft,
the agent is fabricated bare and `config-agent`, later in the same pass, sees
`exists === true` and skips that agent's configured permissions. The chain is
conditional on the id being absent in the draft being transformed; it does not
arise if the id is already present, which is exactly why the safe path is to run
after `config-agent` in the same pass rather than to import ids across passes.

### 3. An event that fires after `config-agent` - no usable publisher

- `plugin.added` **is** published (`packages/core/src/plugin.ts:64`), and
  because `config-agent` is added at `packages/core/src/plugin/internal.ts:115`
  and the external plugin loader (which owns this router) at `:119`, the
  external plugin's own `plugin.added` does fire after `config-agent`'s. This
  does **not** help: events publish at plugin-add time, outside any `materialize`
  pass, whereas `config-agent`'s transform (registered at
  `config/plugin/agent.ts:52` in the pinned revision) does its
  markdown discovery later, during materialize (`state.ts:79-81`). A
  `plugin.added` callback therefore runs before the discovery it would need.
- `agent.updated` has **no** publisher in `packages/core/src`,
  `packages/server/src`, `packages/protocol/src`, or `packages/schema/src` at the
  pinned revision (a grep for `agent.updated`/`Agent.Event`/`AgentUpdated`
  returns nothing there; only the app consumer and a generated OpenAPI fixture
  reference it). Asserted from that grep, not from a cited publisher.

There is no host event with a proven publisher that fires after `config-agent`'s
discovery and before the first materialize containing custom agents.

### 4. `ctx.agent.list()` outside the transform - not on the host-facing surface

The router targets the published promise API (`@opencode/plugin`). Its
`AgentDomain` does expose `list()`/`get()`
(`node_modules/@opencode/plugin/dist/promise/agent.d.ts:5-7`,
`.../promise/adapter.js:205-206`), but the host's own plugin promise bridge does
not: `opencode-src/packages/core/src/plugin/promise.ts:47-49` builds the agent
context with only `transform` and `reload`. Even where `list()` is callable, it
returns the **committed** state (`packages/server/src/handlers/agent.ts:8-11` ->
`AgentV2.all()`), while a `materialize` pass only `commit`s after all transforms
have run (`state.ts:79-83`). So a poll that executes *inside* a transform
registered before `config-agent` cannot observe that pass's additions - the
draft is not committed yet. Polling only yields an ordering-independent id set if
it runs **after** the pass (which is where the `setTimeout` fix already runs).

## Why the current fix is the least-bad option

`config-agent` is the only discovery path for markdown agents, and the only way
to run after it is to register later. `setTimeout(0)` defers the re-register
past the boot batch so the appended transform sorts after `config-agent`
(`src/reach.test.ts` models the append and the retire). It is timing-based - the
same fragility family as the rejected event mechanism - but the alternative
mechanisms either cannot see the agents or re-introduce the permission-skip.

## Next-best mitigation (not implemented here)

If the fixed delay is judged too fragile, the narrow improvement is to replace
the fixed `setTimeout(0)` in `scheduleReassert` with a **bounded poll of
`ctx.agent.list()`** that waits until at least one non-built-in agent is present,
then performs the same `reassertTransform` + slot retire, driven from
**outside** a materialize pass (e.g. from the same deferred `setup` continuation
the timer uses - NOT from inside an early-registered transform). Rationale:

- It keys off observed agent presence rather than a magic delay.
- It does not call `update` before the agent exists, so it keeps the safety
  constraint intact.
- It stays within the same "register late" mechanism; it does not escape the
  ordering root cause and does not remove the timer entirely.

Caveats (load-bearing):

- `list()` returns **committed** state (`server/src/handlers/agent.ts:8-11` ->
  `AgentV2.all()`), and a materialize pass commits only after all transforms
  (`state.ts:79-83`). A poll *inside* an early transform would see nothing; the
  poll must run after a pass, exactly where the timer already runs. So the poll
  changes *when* the late re-register is scheduled, not the fundamental
  register-late requirement.
- It relies on `ctx.agent.list()` being present on the peer `@opencode/plugin`
  (present in 2.0.21; `peerDependencies` allows `>=2.0.0`), and still needs a
  timeout bound and a fallback to the fixed delay.

That is why it is left as a documented option rather than shipped.
