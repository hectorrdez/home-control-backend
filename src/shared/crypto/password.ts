import { scryptSync, randomBytes, timingSafeEqual } from "crypto";

/** `scrypt$<salt hex>$<derived key hex>`: no native module, works everywhere. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const dk = scryptSync(plain, salt, 64).toString("hex");
  return `scrypt$${salt}$${dk}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = (stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, dkHex] = parts;
  const expected = Buffer.from(dkHex, "hex");
  const actual = scryptSync(plain, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
