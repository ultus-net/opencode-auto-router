/**
 * Map discovered catalogs into OpenCode model definitions.
 *
 * Pure functions only: no I/O, no host access. This keeps registration logic
 * inspectable and unit-testable, and lets `index.ts` own all side effects.
 *
 * OpenCode's `Model.Info` uses Effect branded primitives (Money, Model.ID,
 * Model.Family, …). Those brands only exist to prevent accidental mixing at
 * compile time and carry no runtime cost, so definitions are assembled as a
 * plain object and cast once at the boundary.
 */

import { Model } from "@opencode/plugin"
import {
  OPENROUTER_AUTO_MODEL_ID,
  OPENROUTER_PROVIDER_ID,
  SYNTHETIC_PROVIDER_ID,
} from "./constants.js"
import type { SyntheticModel } from "./types.js"

/** `Model.Info` as the transform editor expects it. */
export type ModelDraft = Model.Info

function base(providerID: string, id: string): ModelDraft {
  return Model.Info.default(
    providerID as ModelDraft["providerID"],
    id as ModelDraft["id"],
  ) as ModelDraft
}

/** Build an OpenCode model definition for one Synthetic `syn:*` alias. */
export function syntheticModelInfo(model: SyntheticModel): ModelDraft {
  const cost =
    model.cost && (model.cost.input !== undefined || model.cost.output !== undefined)
      ? [
          {
            input: model.cost.input ?? 0,
            output: model.cost.output ?? 0,
            cache: { read: model.cost.cache_read ?? 0, write: 0 },
          },
        ]
      : []

  return {
    ...base(SYNTHETIC_PROVIDER_ID, model.id),
    // The alias id IS the name: Synthetic's `display_name` names the concrete
    // model an alias currently routes to, which collides with that model's own
    // entry and churns on every rotation. `syn:large:text` is unique, stable,
    // and exactly what the Supported Models table documents.
    name: model.id,
    family: model.id,
    capabilities: { tools: model.tools, input: model.input, output: ["text"] },
    limit: { context: model.context, output: model.output },
    cost,
    // Synthetic reports the reasoning efforts it accepts per alias; expose each
    // as a selectable variant (e.g. `synthetic/syn:large:text#high`).
    variants: model.efforts.map((effort) => ({
      id: effort,
      settings: { reasoningEffort: effort },
    })),
    time: { released: model.released ?? Date.now() },
    status: "active",
    enabled: true,
  } as unknown as ModelDraft
}

/** Build the OpenCode model definition for OpenRouter's `openrouter/auto`. */
export function openRouterAutoModelInfo(): ModelDraft {
  return {
    ...base(OPENROUTER_PROVIDER_ID, OPENROUTER_AUTO_MODEL_ID),
    name: "Auto Router",
    family: "openrouter-auto",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    status: "active",
    enabled: true,
  } as unknown as ModelDraft
}
