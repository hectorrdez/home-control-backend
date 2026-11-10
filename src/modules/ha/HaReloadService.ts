import ApiError from "@errors/ApiError";
import Logger from "@utils/Logger";
import { appEvents } from "@shared/events/AppEvents";
import { haGet, haPostJson } from "./HaClient";
import { HaUnauthorizedError, HaUnexpectedResponseError, HaUnreachableError } from "./HaErrors";
import { haCache } from "./HaCache";
import { ReloadCooldownError, ReloadDisabledError, ReloadInProgressError } from "./HaReloadErrors";

const DEFAULT_RELOAD_DOMAINS = ["tuya", "localtuya"];
const COOLDOWN_MS = 30_000;
const SETTLE_STEP_MS = 500;
const SETTLE_MAX_POLLS = 16; // about 8 s
const SETTLE_STABLE_POLLS = 2;

export interface ReloadEntryResult {
  entryId: string;
  domain: string;
  title: string;
  ok: boolean;
  /** Short stable code when ok is false (never a token or URL). */
  error?: string;
}

export interface ReloadOutcome {
  data: ReloadEntryResult[];
  /** Entity counts from HaCache; null while the cache is not ready (REST fallback). */
  entities: { before: number | null; after: number | null };
}

interface ConfigEntry {
  entry_id: string;
  domain: string;
  title?: string;
  disabled_by?: string | null;
}

export type Sleep = (ms: number) => Promise<void>;
const delay: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** HA_RELOAD_DOMAINS: unset -> defaults; set -> comma list, trimmed, lowercase, de-duplicated. */
export function parseReloadDomains(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_RELOAD_DOMAINS];
  return [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/** Allow-list read on each call; an empty list is a 400 reload_disabled. */
export function configuredReloadDomains(): string[] {
  const domains = parseReloadDomains(process.env.HA_RELOAD_DOMAINS);
  if (domains.length === 0) throw new ReloadDisabledError();
  return domains;
}

/**
 * At most one reload at a time, then a 30 s cooldown. In-memory only.
 * acquire() is synchronous, so two requests cannot both pass it.
 */
export class ReloadGate {
  private running = false;
  private cooldownUntil = 0;

  acquire(now: number = Date.now()): void {
    if (this.running) throw new ReloadInProgressError();
    const wait = this.cooldownUntil - now;
    if (wait > 0) throw new ReloadCooldownError(Math.ceil(wait / 1000));
    this.running = true;
  }

  /**
   * Frees the lock. The 30 s cooldown starts only when a reload request was really
   * sent to HA (`attempted`); failures before that (list call, no matching entries)
   * leave the next call free to run.
   */
  release(now: number = Date.now(), attempted: boolean = false): void {
    this.running = false;
    if (attempted) this.cooldownUntil = now + COOLDOWN_MS;
  }
}

export const reloadGate = new ReloadGate();

/** Entity count from the WebSocket cache, or null when the cache is not ready. */
function entityCount(): number | null {
  return haCache.isReady() ? haCache.allStates().length : null;
}

/**
 * Polls the cache every 500 ms (up to ~8 s) and stops once the count is the same
 * for two polls in a row. Returns the last count seen.
 */
export async function settleEntityCount(sleep: Sleep = delay): Promise<number | null> {
  let current = entityCount();
  if (current === null) return null;
  let stable = 0;
  for (let poll = 0; poll < SETTLE_MAX_POLLS && stable < SETTLE_STABLE_POLLS; poll++) {
    await sleep(SETTLE_STEP_MS);
    const next = entityCount();
    if (next === null) break;
    stable = next === current ? stable + 1 : 0;
    current = next;
  }
  return current;
}

async function listEntries(): Promise<ConfigEntry[]> {
  let rows: unknown;
  try {
    rows = await haGet<unknown>("/api/config/config_entries/entry");
  } catch (err) {
    // Spec: HA unreachable or auth failure -> 502 for this route.
    if (err instanceof HaUnreachableError) throw new ApiError("Home Assistant unreachable", 502, "ha_unreachable");
    if (err instanceof HaUnauthorizedError) {
      throw new ApiError("Home Assistant rejected the access token", 502, "ha_unauthorized");
    }
    throw err;
  }
  if (!Array.isArray(rows)) throw new HaUnexpectedResponseError();
  return rows as ConfigEntry[];
}

/** One reload; a failure becomes ok:false for this entry only. */
async function reloadEntry(entry: ConfigEntry): Promise<ReloadEntryResult> {
  const base = { entryId: entry.entry_id, domain: entry.domain, title: entry.title ?? "" };
  try {
    await haPostJson(`/api/config/config_entries/entry/${encodeURIComponent(entry.entry_id)}/reload`, {});
    Logger.write(`ha reload: ${entry.domain} entry ${entry.entry_id} ok`, "HaReload");
    return { ...base, ok: true };
  } catch (err) {
    const error = err instanceof ApiError ? err.getErrorCode() : "reload_failed";
    Logger.write(`ha reload: ${entry.domain} entry ${entry.entry_id} failed (${error})`, "HaReload", "WARN");
    return { ...base, ok: false, error };
  }
}

/**
 * Reloads the enabled config entries of the allow-listed domains, one after the
 * other, then refreshes the cache registries and announces the change on SSE.
 * `onAttempt` fires right before each reload request is sent to HA (the caller
 * uses it to decide whether the cooldown starts). Callers must hold reloadGate.
 */
export async function reloadHaIntegrations(
  domains: string[],
  clientId: string | null,
  sleep: Sleep = delay,
  onAttempt?: () => void
): Promise<ReloadOutcome> {
  const before = entityCount();
  const entries = await listEntries();
  const targets = entries.filter((e) => domains.includes(e.domain) && e.disabled_by == null);
  if (targets.length === 0) {
    Logger.write("ha reload: no matching config entries", "HaReload");
    return { data: [], entities: { before, after: before } };
  }

  const data: ReloadEntryResult[] = [];
  for (const entry of targets) {
    onAttempt?.();
    data.push(await reloadEntry(entry));
  }

  haCache.refreshRegistries();
  const after = await settleEntityCount(sleep);
  // Empty keys = "refetch all" for open panels.
  for (const resource of ["entities", "areas"] as const) {
    appEvents.emit({ type: "resource_changed", resource, keys: [], by: clientId });
  }
  Logger.write(`ha reload: ${data.filter((d) => d.ok).length}/${data.length} entries reloaded`, "HaReload");
  return { data, entities: { before, after } };
}
