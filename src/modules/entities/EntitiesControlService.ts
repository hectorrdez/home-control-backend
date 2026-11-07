import { haPostText } from "@modules/ha/HaClient";
import { fetchState, normalizeLive, NormalizedEntity } from "@modules/ha/HaStates";
import coverMoves from "@modules/covers/CoverMoves";
import {
  DomainNotAllowedError,
  EntityNotFoundError,
  InvalidActionError,
  InvalidEntityIdError,
  InvalidParamsError,
} from "./EntityErrors";

/**
 * Per-domain action allowlist. Each action maps 1:1 to the HA service of the same name
 * in the entity's domain. A domain's key here is also the domain allowlist.
 */
const CONTROL_ACTIONS = {
  light: ["turn_on", "turn_off", "toggle"],
  switch: ["turn_on", "turn_off", "toggle"],
  fan: ["turn_on", "turn_off", "toggle"],
  scene: ["turn_on", "turn_off", "toggle"],
  script: ["turn_on", "turn_off", "toggle"],
  media_player: ["turn_on", "turn_off", "toggle"],
  cover: ["open_cover", "close_cover", "stop_cover", "set_cover_position", "toggle"],
  climate: ["turn_on", "turn_off", "set_temperature", "set_hvac_mode", "set_preset_mode"],
  lock: ["lock", "unlock"],
} as const satisfies Record<string, readonly string[]>;

/** Domains the panel may control (notes.md allowlist). */
export const ALLOWED_DOMAINS: string[] = Object.keys(CONTROL_ACTIONS);

/** Actions allowed per domain (lookup by domain string). */
export const ACTIONS_BY_DOMAIN: Readonly<Record<string, readonly string[]>> = CONTROL_ACTIONS;

export type EntityAction = (typeof CONTROL_ACTIONS)[keyof typeof CONTROL_ACTIONS][number];

/** Union of every action across all domains. */
export const ALLOWED_ACTIONS: readonly EntityAction[] = [
  ...new Set(Object.values(CONTROL_ACTIONS).flat()),
] as EntityAction[];

/** Service data keys a client may pass; anything else is rejected. */
const ALLOWED_PARAMS = [
  "brightness",
  "brightness_pct",
  "color_temp",
  "temperature",
  "position",
  "percentage",
  "hvac_mode",
  "preset_mode",
  "volume_level",
] as const;

const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

export interface ActionBody {
  action?: unknown;
  params?: unknown;
}

/**
 * Validates the body and returns a clean action + service data. Throws typed ApiErrors.
 * When `domain` is given, the action must be allowed for that domain; otherwise it is
 * checked against the union of all domains.
 */
export function parseAction(
  body: ActionBody | undefined,
  domain?: string
): { action: EntityAction; params: Record<string, unknown> } {
  const action = body?.action;
  const allowed: readonly string[] = domain === undefined ? ALLOWED_ACTIONS : (ACTIONS_BY_DOMAIN[domain] ?? []);
  if (typeof action !== "string" || !allowed.includes(action)) {
    throw new InvalidActionError(`action must be one of: ${allowed.join(", ")}`);
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

  const { action, params } = parseAction(body, domain);

  const existing = await fetchState(entityId);
  if (!existing) throw new EntityNotFoundError();

  // HA replies with the list of states that changed; we re-read ours from it.
  const send = () => haPostText(`/api/services/${domain}/${action}`, { entity_id: entityId, ...params });
  if (domain === "cover") await coverMoves.onAction(entityId, action, send);
  else await send();

  return normalizeLive((await fetchState(entityId)) ?? existing);
}
