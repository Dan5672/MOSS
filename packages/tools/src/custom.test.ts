import { describe, expect, it } from "vitest";
import { customHttp, customToolDefinition, customToolSpecSchema, pickJson, renderCustomRequest } from "./custom.js";

const plex = {
  key: "plex_sessions",
  description: "Active Plex streams on a media server",
  class: "read",
  params: { host: { type: "ip", target: true, description: "The Plex server" }, limit: { type: "integer", min: 1, max: 50, default: 10 } },
  secret: "plex-token",
  request: {
    method: "GET",
    scheme: "http",
    port: 32400,
    path: "/status/sessions",
    query: { "X-Plex-Container-Size": "{{limit}}" },
    headers: { "X-Plex-Token": "{{secret}}", Accept: "application/json" },
  },
  result: { pick: "$.MediaContainer.Metadata[*].title" },
};

const issues = (spec: unknown) => {
  const r = customToolSpecSchema.safeParse(spec);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("custom tools", () => {
  it("accepts a well-formed definition and builds a strict tool from it", () => {
    const spec = customToolSpecSchema.parse(plex);
    const def = customToolDefinition(spec);
    expect(def.manifest).toEqual({ name: "plex_sessions", class: "read", targetArgs: ["host"] });
    expect(def.args.parse({ host: "10.0.0.20" })).toEqual({ host: "10.0.0.20", limit: 10 });
    expect(() => def.args.parse({ host: "plex.lan" })).toThrow();
    expect(() => def.args.parse({ host: "10.0.0.20", extra: 1 })).toThrow();
    expect(() => def.args.parse({ host: "10.0.0.20", limit: 500 })).toThrow();
  });

  it("refuses definitions that could misbehave", () => {
    expect(issues({ ...plex, request: { ...plex.request, method: "POST" } })).toContain("read tools must use GET; anything that changes state is a write tool");
    expect(issues({ ...plex, request: { ...plex.request, path: "/status/{{secret}}" } })).toContain("{{secret}} may only be used in headers, query or body");
    expect(issues({ ...plex, request: { ...plex.request, path: "/a/../admin" } })).toContain("path may not contain ..");
    expect(issues({ ...plex, request: { ...plex.request, headers: { "X-Plex-Token": "{{token}}" } } })).toContain("{{token}} is not a declared parameter");
    expect(issues({ ...plex, secret: undefined })).toContain("{{secret}} is used but no secret is declared");
    expect(issues({ ...plex, request: { ...plex.request, headers: { "Transfer-Encoding": "chunked" } } })).toContain("Transfer-Encoding can't be set");
    expect(issues({ ...plex, params: { host: { type: "ip" } } })).toContain("exactly one parameter must be the target (type: ip, target: true)");
    expect(issues({ ...plex, params: { host: { type: "string", target: true } } })).toContain("only an ip parameter can be the target");
    expect(issues({ ...plex, key: "Plex Sessions" })).not.toHaveLength(0);
    expect(issues({ ...plex, shell: "rm -rf /" })).not.toHaveLength(0);
  });

  it("renders requests with values encoded for where they land", () => {
    const spec = customToolSpecSchema.parse({
      ...plex,
      class: "write",
      params: { host: { type: "ip", target: true }, name: { type: "string" } },
      request: { method: "POST", scheme: "https", path: "/items/{{name}}", query: { q: "{{name}}" }, headers: { Authorization: "Bearer {{secret}}" }, body: { title: "{{name}}", tags: ["{{name}}"] } },
    });
    const r = renderCustomRequest(spec, { host: "10.0.0.5", name: "a b/../c" }, "tok");
    expect(r).toMatchObject({
      target: "10.0.0.5",
      port: 443,
      method: "POST",
      path: "/items/a%20b%2F..%2Fc?q=a%20b%2F..%2Fc",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "a b/../c", tags: ["a b/../c"] }),
    });
    expect(customHttp.args.safeParse(r).success).toBe(true);
    expect(() => renderCustomRequest(spec, { host: "10.0.0.5", name: "x" }, "tok\r\nX-Evil: 1")).toThrow(/line break/);
  });

  it("picks parts of a JSON result", () => {
    const doc = { MediaContainer: { size: 2, Metadata: [{ title: "A" }, { title: "B" }, { other: 1 }] } };
    expect(pickJson(doc, "$.MediaContainer.Metadata[*].title")).toEqual(["A", "B"]);
    expect(pickJson(doc, "$.MediaContainer.size")).toBe(2);
    expect(pickJson(doc, "$.MediaContainer.Metadata[1]")).toEqual({ title: "B" });
    expect(pickJson(doc, "$['MediaContainer'].missing")).toBeUndefined();
    expect(pickJson(doc, "$.MediaContainer.Metadata[*]", 1)).toEqual([{ title: "A" }]);
    expect(issues({ ...plex, result: { pick: "MediaContainer" } })).toContain("pick must look like $.a.b[*].c");
  });
});
