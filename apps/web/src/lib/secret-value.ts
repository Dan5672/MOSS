// Catches a pasted note or stray whitespace in a secret before it's stored. (A UniFi password once arrived
// as 214 characters of "Username: ... Password: ..." and the console rightly refused it.) Never logs the value.

const SINGLE_VALUE_TYPES = new Set(["password", "api_token", "snmp_community"]);

/** Why a secret's value looks wrong for its type, or null. */
export function secretValueProblem(value: string, type: string): string | null {
  if (type === "ssh_key") return null; // keys span lines and end with a newline
  if (value !== value.trim()) return "It starts or ends with a space or a line break.";
  if (!SINGLE_VALUE_TYPES.has(type)) return null;
  if (/[\r\n]/.test(value)) return "It has more than one line.";
  const spaces = (value.match(/\s/g) ?? []).length;
  if (spaces >= 3 && value.length > 30) return "It reads like a sentence or a note, not a single password or key.";
  return null;
}
