import "dotenv/config";
import Logger from "@utils/Logger";
import {
  HaNotConfiguredError,
  HaUnauthorizedError,
  HaUnexpectedResponseError,
  HaUnreachableError,
} from "./HaErrors";

const TIMEOUT_MS = 5000;

/** Warn at startup (never crash) when HA settings are missing. */
export function warnIfHaMisconfigured(): void {
  if (!process.env.HA_URL || !process.env.HA_TOKEN) {
    Logger.write("HA_URL or HA_TOKEN missing: /api/ha/* will return ha_not_configured", "HaClient", "WARN");
  }
}

/**
 * GET a Home Assistant REST path and return the parsed JSON.
 * The token is only sent as a header; it is never logged or echoed in errors.
 */
export async function haGet<T = unknown>(path: string): Promise<T> {
  const base = (process.env.HA_URL ?? "").replace(/\/+$/, "");
  const token = process.env.HA_TOKEN ?? "";
  if (!base || !token) throw new HaNotConfiguredError();

  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {
    throw new HaUnreachableError();
  });

  if (res.status === 401 || res.status === 403) throw new HaUnauthorizedError();
  if (!res.ok) throw new HaUnexpectedResponseError(`Home Assistant responded ${res.status}`);

  try {
    return (await res.json()) as T;
  } catch {
    throw new HaUnexpectedResponseError("Home Assistant returned a non-JSON body");
  }
}
