// Multi-provider decisions (odd/tasks/multi-provider.md): the owner's choice
// of decision provider, mirrored by the worker to decision-provider.json in
// the config dir (adapters/orca/write-secret-mirror.mjs) and read by the gate
// hook. Not secret. Anything missing or malformed reads as Jev only, the
// behaviour every install had before this file existed (review note 1).

import { isRecord } from "../guards.ts";
import { DEFAULT_CLEF_MODEL, isClefModel, type ClefModel } from "./clef.ts";
import { DEFAULT_PROVIDER_MODE, isProviderMode, type ProviderMode } from "./provider_cascade.ts";

export const PROVIDER_SETTINGS_MIRROR_FILE = "decision-provider.json";

export interface ProviderSettings {
  readonly mode: ProviderMode;
  readonly clefModel: ClefModel;
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = { mode: DEFAULT_PROVIDER_MODE, clefModel: DEFAULT_CLEF_MODEL };

/** Tolerant: each field falls back to its default on its own. `raw` null is a missing file. */
export function parseProviderSettings(raw: string | null): ProviderSettings {
  if (raw === null) return DEFAULT_PROVIDER_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PROVIDER_SETTINGS;
  }
  return normalizeProviderSettings(parsed);
}

export function normalizeProviderSettings(value: unknown): ProviderSettings {
  if (!isRecord(value)) return DEFAULT_PROVIDER_SETTINGS;
  return {
    mode: isProviderMode(value.mode) ? value.mode : DEFAULT_PROVIDER_SETTINGS.mode,
    clefModel: isClefModel(value.clefModel) ? value.clefModel : DEFAULT_PROVIDER_SETTINGS.clefModel,
  };
}
