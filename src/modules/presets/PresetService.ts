import { randomUUID } from "crypto";
import calibrationStore from "@modules/calibrations/CalibrationStore";
import { setCoverPercent } from "@modules/covers/CoverPercentService";
import { controlEntity } from "@modules/entities/EntitiesControlService";
import { EntityNotFoundError } from "@modules/entities/EntityErrors";
import { fetchState, NormalizedEntity } from "@modules/ha/HaStates";
import presetStore, { Preset } from "./PresetStore";
import { DuplicatePresetError, InvalidPresetError, PresetNotApplicableError, PresetNotFoundError, TooManyPresetsError } from "./PresetErrors";
import {
  MAX_PRESETS,
  MAX_PRESETS_PER_ENTITY,
  nameKey,
  parseCreateBody,
  parseEntityIdFilter,
  parseUpdateBody,
  PresetFields,
} from "./PresetValidation";

/** Throws DuplicatePresetError when another preset (not `selfId`) of the same entity has this name. */
function assertUniqueName(draft: Map<string, PresetFields>, entityId: string, name: string, selfId: string): void {
  const key = nameKey(name);
  for (const [id, other] of draft) {
    if (id !== selfId && other.entityId === entityId && nameKey(other.name) === key) throw new DuplicatePresetError();
  }
}

/** All presets, optionally filtered by entityId. */
export function listPresets(rawEntityId?: string): Preset[] {
  const entityId = rawEntityId === undefined ? undefined : parseEntityIdFilter(rawEntityId);
  return presetStore.list().filter((p) => entityId === undefined || p.entityId === entityId);
}

/** Creates a preset with a server-generated id. No HA call. */
export async function createPreset(rawBody: unknown, by: string | null = null): Promise<Preset[]> {
  const fields = parseCreateBody(rawBody);
  const id = randomUUID();
  let createdAt = "";
  await presetStore.mutate((draft, ctx) => {
    if (draft.size >= MAX_PRESETS) throw new TooManyPresetsError();
    let own = 0;
    for (const p of draft.values()) if (p.entityId === fields.entityId) own++;
    if (own >= MAX_PRESETS_PER_ENTITY) throw new TooManyPresetsError();
    assertUniqueName(draft, fields.entityId, fields.name, id);
    createdAt = ctx.now;
    draft.set(id, { ...fields, createdAt });
    return true;
  }, { by });
  return [{ id, ...fields, createdAt }];
}

/** Renames / re-percents one preset. entityId is immutable (a different one is invalid_preset). */
export async function replacePreset(id: string, rawBody: unknown, by: string | null = null): Promise<Preset[]> {
  const body = parseUpdateBody(rawBody);
  let stored: PresetFields | undefined;
  await presetStore.mutate((draft) => {
    const existing = draft.get(id);
    if (!existing) throw new PresetNotFoundError();
    if (body.entityId !== undefined && body.entityId !== existing.entityId) throw new InvalidPresetError("entityId cannot change");
    assertUniqueName(draft, existing.entityId, body.name, id);
    stored = { ...existing, name: body.name, percent: body.percent };
    draft.set(id, stored);
    return true;
  }, { by });
  return [{ id, ...(stored as unknown as PresetFields) }];
}

/** Removes one preset. Idempotent. The contract response is always an empty array. */
export async function deletePreset(id: string, by: string | null = null): Promise<Preset[]> {
  await presetStore.mutate((draft) => draft.delete(id), { by });
  return [];
}

/** Looks up a preset for apply. Unknown id -> preset_not_found 404. */
export function requirePreset(id: string): Preset {
  const fields = presetStore.get(id);
  if (!fields) throw new PresetNotFoundError();
  return { id, ...fields };
}

/**
 * Drives the cover to the preset percent. A calibrated cover goes through the 011 timed move
 * (same errors: not reached here, position_unknown 409 for intermediate targets). Otherwise a
 * cover with a numeric `current_position` gets HA `set_cover_position`. Anything else is 409.
 */
export async function applyPreset(preset: Preset): Promise<NormalizedEntity[]> {
  const { entityId, percent } = preset;
  if (calibrationStore.get(entityId)) return setCoverPercent(entityId, { percent });

  const state = await fetchState(entityId);
  if (!state) throw new EntityNotFoundError();
  if (typeof state.attributes?.current_position !== "number") throw new PresetNotApplicableError();
  return [await controlEntity(entityId, { action: "set_cover_position", params: { position: percent } })];
}
