import { db } from "@utils/Connection";
import Logger from "@utils/Logger";
import { newId } from "../crypto/ids";

export interface AuditInput {
  actorUserId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  result?: string;
  ip?: string | null;
  metadata?: unknown;
}

/** Append an `audit_events` row. Never throws: a failed audit write must not fail the request. */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await db.execute(
      `INSERT INTO audit_events
         (id, actor_user_id, action, target_type, target_id, result, ip, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        input.actorUserId ?? null,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        input.result ?? "success",
        input.ip ?? null,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
      ]
    );
  } catch (err) {
    Logger.error((err as Error).message, "audit");
  }
}
