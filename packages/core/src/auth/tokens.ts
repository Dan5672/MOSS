// Opaque bearer tokens (sessions, agent and service tokens). Only the SHA-256 hash is stored.
import { createHash, randomBytes } from "node:crypto";

export function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
