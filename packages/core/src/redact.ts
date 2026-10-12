// Scrubs secret values from tool output before it is logged or returned to an agent.
// Also covers common encodings, since tools sometimes echo credentials back encoded.

const MIN_REDACT_LENGTH = 4;

function encodings(secret: string): string[] {
  const hex = Buffer.from(secret).toString("hex");
  const base64 = Buffer.from(secret).toString("base64");
  // The JSON-escaped form too: results are scrubbed as JSON text, where pa"ss\1 reads pa\"ss\\1.
  return [secret, JSON.stringify(secret).slice(1, -1), base64, base64.replace(/=+$/, ""), Buffer.from(secret).toString("base64url"), encodeURIComponent(secret), hex, hex.toUpperCase()];
}

function variants(secret: string): string[] {
  // A key or certificate is often echoed a line at a time (or re-wrapped), so each long line counts on its own.
  const lines = secret.includes("\n") ? secret.split(/\r?\n/).filter((l) => l.trim().length >= 16) : [];
  return [secret, ...lines].flatMap(encodings);
}

/** Whether text holds a private key: such a result is withheld whole, whatever key it is. */
export const containsPrivateKey = (text: string) => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text);

export function redactSecrets(text: string, secretValues: Iterable<string>): string {
  const needles = [...new Set([...secretValues].filter((s) => s.length >= MIN_REDACT_LENGTH).flatMap(variants))]
    // Longest first, so a secret that contains another is removed whole.
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const needle of needles) out = out.split(needle).join("[REDACTED]");
  return out;
}
