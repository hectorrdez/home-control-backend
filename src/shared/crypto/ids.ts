import { randomBytes, randomUUID } from "crypto";

/** UUID v4 for entity primary keys (CHAR(36)). */
export function newId(): string {
  return randomUUID();
}

/** 64-hex-char opaque token (session ids, verification / reset tokens). */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}
