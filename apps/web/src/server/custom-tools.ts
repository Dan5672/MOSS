import "server-only";
import { PLATFORM_TOOLS } from "@moss/agent";
import { BUILT_IN_TOOLS, customToolSpecSchema, type CustomToolSpec } from "@moss/tools";
import { parse } from "yaml";

const RESERVED = new Set([...BUILT_IN_TOOLS.keys(), ...PLATFORM_TOOLS.map((t) => t.name), "custom_http"]);

/** An example definition, shown on the upload form. */
export const EXAMPLE_CUSTOM_TOOL = `key: plex_sessions
description: Active Plex streams on a media server
class: read
params:
  host: { type: ip, target: true, description: The Plex server }
secret: plex-token          # a stored secret; its value replaces {{secret}}
request:
  method: GET
  scheme: http
  port: 32400
  path: /status/sessions
  headers:
    X-Plex-Token: "{{secret}}"
    Accept: application/json
result:
  pick: $.MediaContainer.Metadata[*].title
`;

/** Parses and validates an uploaded definition (YAML or JSON), with errors a person can act on. */
export function parseCustomTool(source: string): CustomToolSpec {
  if (source.length > 20_000) throw new Error("The definition is too long (20,000 characters at most)");
  let raw: unknown;
  try {
    raw = parse(source, { maxAliasCount: 0 });
  } catch (err) {
    throw new Error(`That isn't valid YAML or JSON: ${(err as Error).message.split("\n")[0]}`);
  }
  const result = customToolSpecSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.slice(0, 8).map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`);
    throw new Error(`The definition has problems:\n${lines.join("\n")}`);
  }
  if (RESERVED.has(result.data.key)) throw new Error(`"${result.data.key}" is the name of a built-in tool; choose another key`);
  return result.data;
}
