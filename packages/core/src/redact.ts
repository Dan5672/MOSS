// Scrubs secret values from tool output before it is logged or returned to an agent.
// Also covers common encodings, since tools sometimes echo credentials back encoded.

const MIN_REDACT_LENGTH = 4;

function variants(secret: string): string[] {
  // The JSON-escaped form too: results are scrubbed as JSON text, where pa"ss\1 reads pa\"ss\\1.
  return [secret, JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString("base64"), encodeURIComponent(secret)];
}

export function redactSecrets(text: string, secretValues: Iterable<string>): string {
  const needles = [...new Set([...secretValues].filter((s) => s.length >= MIN_REDACT_LENGTH).flatMap(variants))]
    // Longest first, so a secret that contains another is removed whole.
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const needle of needles) out = out.split(needle).join("[REDACTED]");
  return out;
}
