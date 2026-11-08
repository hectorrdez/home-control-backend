import type { Response } from "express";
import ApiError from "@errors/ApiError";
import { InvalidEntityIdError } from "@modules/entities/EntityErrors";
import { eventLog } from "./EventLog";
import { recentActions } from "@modules/alerts/RecentActions";

export interface ActionRecordContext {
  entityId: string;
  /** Action name as requested (`percent` requests use `cover_percent`). */
  action: string | null;
  /** Params as requested; omitted from the payload when undefined. */
  params?: Record<string, unknown>;
}

/**
 * Runs an entity action and records one `action` event with its outcome
 * (`ok`, plus the ApiError code on failure). The result, or the error, is
 * passed through unchanged. Requests with an invalid entity id are not recorded.
 */
export async function recordEntityAction<T>(
  res: Response,
  ctx: ActionRecordContext,
  run: () => Promise<T>
): Promise<T> {
  const record = (ok: boolean, error?: string) => {
    const payload: Record<string, unknown> = { action: ctx.action };
    if (ctx.params !== undefined) payload.params = ctx.params;
    payload.ok = ok;
    if (error !== undefined) payload.error = error;
    eventLog.record({
      type: "action",
      source: "api",
      entityId: ctx.entityId,
      payload,
      clientId: res.locals.clientId ?? null,
      clientName: res.locals.clientName ?? null,
    });
  };

  let out: T;
  try {
    out = await run();
  } catch (err) {
    if (!(err instanceof InvalidEntityIdError)) {
      record(false, err instanceof ApiError ? err.getErrorCode() : "internal_error");
    }
    throw err;
  }
  record(true);
  // 020: a successful action explains the next state change of this entity as "user interacted".
  recentActions.record(ctx.entityId, { clientId: res.locals.clientId ?? null, clientName: res.locals.clientName ?? null });
  return out;
}
