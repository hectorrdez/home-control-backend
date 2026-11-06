import { haPostText } from "@modules/ha/HaClient";
import { fetchAreaIndex, fetchState, normalizeEntity, NormalizedEntity } from "@modules/ha/HaStates";
import {
  DomainNotAllowedError,
  EntityNotFoundError,
  InvalidActionError,
  InvalidEntityIdError,
  InvalidParamsError,
} from "./EntityErrors";

/** Domains the panel may control (notes.md allowlist). */
export const ALLOWED_DOMAINS = ["light", "switch", "climate", "cover", "fan", "media_player", "scene", "script"];

/** Actions mapped 1:1 to the HA service of the same name in the entity's domain. */
export const ALLOWED_ACTIONS = ["turn_on", "turn_off", "toggle"] as const;
export type EntityAction = (typeof ALLOWED_ACTIONS)[number];

/** Service data keys a client may pass; anything else is rejected. */
const ALLOWED_PARAMS = [
  "brightness",
  "color_temp",
  "temperature",
  "position",
  "percentage",
  "hvac_mode",
  "volume_level",
] as const;

const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

export interface ActionBody {
  action?: unknown;
  params?: unknown;
}

/** Validates the body and returns a clean action + service data. Throws typed ApiErrors. */
export function parseAction(body: ActionBody | undefined): { action: EntityAction; params: Record<string, unknown> } {
  const action = body?.action;
  if (typeof action !== "string" || !(ALLOWED_ACTIONS as readonly string[]).includes(action)) {
    throw new InvalidActionError(`action must be one of: ${ALLOWED_ACTIONS.join(", ")}`);
  }
  const raw = body?.params ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidParamsError("params must be an object");
  }
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(ALLOWED_PARAMS as readonly string[]).includes(key)) {
      throw new InvalidParamsError(`param not allowed: ${key}`);
    }
    if (typeof value !== "number" && typeof value !== "string") {
      throw new InvalidParamsError(`param ${key} must be a number or string`);
    }
    params[key] = value;
  }
  return { action: action as EntityAction, params };
}

/** Calls the HA service for the entity and returns its new normalized state. */
export async function controlEntity(
  entityId: string,
  body: ActionBody | undefined
): Promise<NormalizedEntity> {
  if (!ENTITY_ID_RE.test(entityId)) throw new InvalidEntityIdError();
  const domain = entityId.split(".")[0];
  if (!ALLOWED_DOMAINS.includes(domain)) throw new DomainNotAllowedError(`domain not allowed: ${domain}`);

  const { action, params } = parseAction(body);

  const existing = await fetchState(entityId);
  if (!existing) throw new EntityNotFoundError();

  // HA replies with the list of states that changed; we re-read ours from it.
  await haPostText(`/api/services/${domain}/${action}`, { entity_id: entityId, ...params });

  const fresh = (await fetchState(entityId)) ?? existing;
  return normalizeEntity(fresh, await fetchAreaIndex());
}
