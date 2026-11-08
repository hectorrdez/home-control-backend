import "dotenv/config";
import Logger from "@utils/Logger";
import {
  HaNotConfiguredError,
  HaUnauthorizedError,
  HaUnexpectedResponseError,
  HaUnreachableError,
} from "./HaErrors";

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 300;
/** Gateway-style statuses that mean "HA not reachable right now"; retried for GET only. */
const RETRYABLE_STATUS = [502, 503, 504];

/** Parses HA_TIMEOUT_MS. Returns null when it is set but not an integer in 1000..30000. */
export function parseTimeoutMs(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) return null;
  return n;
}

/** Effective per-request timeout (env read on each call so tests and restarts see the current value). */
export function haTimeoutMs(): number {
  return parseTimeoutMs(process.env.HA_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
}

/** Warn at startup (never crash) when HA settings are missing or HA_TIMEOUT_MS is invalid. */
export function warnIfHaMisconfigured(): void {
  if (!process.env.HA_URL || !process.env.HA_TOKEN) {
    Logger.write("HA_URL or HA_TOKEN missing: /api/ha/* will return ha_not_configured", "HaClient", "WARN");
  }
  if (parseTimeoutMs(process.env.HA_TIMEOUT_MS) === null) {
    Logger.write(
      `HA_TIMEOUT_MS invalid (need ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}), using ${DEFAULT_TIMEOUT_MS}`,
      "HaClient",
      "WARN"
    );
  }
}

interface RequestOptions {
  body?: unknown;
  /** One retry after RETRY_DELAY_MS on network error, timeout or 502/503/504. Only for idempotent GETs. */
  retry?: boolean;
  /** HA 404 resolves to null instead of throwing (used by single-state lookups). */
  notFoundIsNull?: boolean;
}

function haBase(): { base: string; token: string } {
  let base = process.env.HA_URL ?? "";
  while (base.endsWith("/")) base = base.slice(0, -1);
  const token = process.env.HA_TOKEN ?? "";
  if (!base || !token) throw new HaNotConfiguredError();
  return { base, token };
}

/**
 * The one request path to Home Assistant. The token is only sent as a header;
 * it is never logged or echoed in errors. Returns null only for a 404 with notFoundIsNull.
 */
async function haRequest(
  method: "GET" | "POST",
  path: string,
  { body, retry = false, notFoundIsNull = false }: RequestOptions = {}
): Promise<Response | null> {
  const { base, token } = haBase();
  const attempts = retry ? 2 : 1;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      const headers: Record<string, string> =
        method === "GET"
          ? { Authorization: `Bearer ${token}`, Accept: "application/json" }
          : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(haTimeoutMs()),
      });
    } catch {
      if (attempt < attempts) {
        await delay(RETRY_DELAY_MS);
        continue;
      }
      throw new HaUnreachableError();
    }

    if (res.status === 401 || res.status === 403) throw new HaUnauthorizedError();
    if (res.ok) return res;
    if (notFoundIsNull && res.status === 404) return null;
    if (RETRYABLE_STATUS.includes(res.status)) {
      if (attempt < attempts) {
        await delay(RETRY_DELAY_MS);
        continue;
      }
      throw new HaUnreachableError();
    }
    throw new HaUnexpectedResponseError(`Home Assistant responded ${res.status}`);
  }
  throw new HaUnreachableError();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new HaUnexpectedResponseError("Home Assistant returned a non-JSON body");
  }
}

/** GET a Home Assistant REST path and return the parsed JSON (retried once on transient failure). */
export async function haGet<T = unknown>(path: string): Promise<T> {
  const res = (await haRequest("GET", path, { retry: true })) as Response;
  return parseJson<T>(res);
}

/** GET a single resource; HA 404 resolves to null. Retried once on transient failure. */
export async function haGetOptional<T = unknown>(path: string): Promise<T | null> {
  const res = await haRequest("GET", path, { retry: true, notFoundIsNull: true });
  return res === null ? null : parseJson<T>(res);
}

/** POST a JSON body and return the parsed JSON reply. Never retried: a duplicated service call is not harmless. */
export async function haPostJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = (await haRequest("POST", path, { body })) as Response;
  return parseJson<T>(res);
}

/** POST a JSON body to a Home Assistant REST path and return the raw text reply (e.g. /api/template). Never retried. */
export async function haPostText(path: string, body: unknown): Promise<string> {
  const res = (await haRequest("POST", path, { body })) as Response;
  return res.text();
}
