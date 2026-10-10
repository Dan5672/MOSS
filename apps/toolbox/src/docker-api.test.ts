// Docker through a socket proxy, and checking images against their registries.
import type { RenderedRequest } from "@moss/tools";
import { describe, expect, it } from "vitest";
import type { RawRequest } from "./custom-http.js";
import { dockerApiContainers, parseImageRef, remoteDigest } from "./docker-api.js";

function device(routes: Record<string, unknown>) {
  const seen: RenderedRequest[] = [];
  const send: RawRequest = async (r) => {
    seen.push(r);
    const route = routes[`${r.method} ${r.path}`];
    if (route === undefined) return { status: 404, body: Buffer.from("{}"), truncated: false };
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(route)), truncated: false };
  };
  return { send, seen };
}

/** A registry that wants an anonymous token first, like Docker Hub. */
function registry(digests: Record<string, string>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push(`${init.method} ${url}`);
    const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
    if (url.startsWith("https://auth.docker.io/token")) return { status: 200, headers: headers({}), text: async () => JSON.stringify({ token: "anon" }) };
    if (init.headers.Authorization !== "Bearer anon") {
      return { status: 401, headers: headers({ "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"' }), text: async () => "" };
    }
    const digest = Object.entries(digests).find(([k]) => url.includes(k))?.[1];
    return digest ? { status: 200, headers: headers({ "docker-content-digest": digest }), text: async () => "" } : { status: 404, headers: headers({}), text: async () => "" };
  };
  return { fetchImpl, calls };
}

describe("image references", () => {
  it("knows Docker Hub, other registries, tags and pinned images", () => {
    expect(parseImageRef("nginx")).toEqual({ registry: "registry-1.docker.io", repo: "library/nginx", tag: "latest" });
    expect(parseImageRef("linuxserver/plex:1.40")).toEqual({ registry: "registry-1.docker.io", repo: "linuxserver/plex", tag: "1.40" });
    expect(parseImageRef("ghcr.io/home-assistant/home-assistant:stable")).toEqual({ registry: "ghcr.io", repo: "home-assistant/home-assistant", tag: "stable" });
    expect(parseImageRef("localhost:5000/app")).toEqual({ registry: "localhost:5000", repo: "app", tag: "latest" });
    expect(parseImageRef("nginx@sha256:abc")).toBeNull();
  });

  it("signs in anonymously when the registry asks, then reads the digest with HEAD", async () => {
    const { fetchImpl, calls } = registry({ "library/nginx/manifests/latest": "sha256:new" });
    expect(await remoteDigest("nginx", fetchImpl)).toBe("sha256:new");
    expect(calls).toEqual([
      "HEAD https://registry-1.docker.io/v2/library/nginx/manifests/latest",
      "GET https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull",
      "HEAD https://registry-1.docker.io/v2/library/nginx/manifests/latest",
    ]);
  });
});

describe("docker_api_containers", () => {
  it("lists containers with health, restarts and restart policy, and which images have updates", async () => {
    const { send, seen } = device({
      "GET /info": { Name: "docker1", ServerVersion: "27.3.1" },
      "GET /containers/json?all=1": [
        { Id: "aaaaaaaaaaaa1111", Names: ["/nginx"], Image: "nginx", ImageID: "sha256:img1", State: "running", Status: "Up 2 days (healthy)", Labels: { "com.docker.compose.project": "web" } },
        { Id: "bbbbbbbbbbbb2222", Names: ["/worker"], Image: "ghcr.io/me/worker:1", ImageID: "sha256:img2", State: "restarting", Status: "Restarting (1) 5 seconds ago", Labels: {} },
      ],
      "GET /containers/aaaaaaaaaaaa1111/json": { RestartCount: 0, State: { Status: "running", Health: { Status: "healthy" }, ExitCode: 0 }, HostConfig: { RestartPolicy: { Name: "unless-stopped" } } },
      "GET /containers/bbbbbbbbbbbb2222/json": { RestartCount: 14, State: { Status: "restarting", ExitCode: 1 }, HostConfig: { RestartPolicy: { Name: "always" } } },
      "GET /images/sha256%3Aimg1/json": { RepoDigests: ["nginx@sha256:old"] },
      "GET /images/sha256%3Aimg2/json": { RepoDigests: ["ghcr.io/me/worker@sha256:same"] },
    });
    const { fetchImpl } = registry({ "library/nginx": "sha256:new", "me/worker": "sha256:same" });
    const res = await dockerApiContainers({ target: "192.168.1.20", port: 2375, verifyTls: false, timeoutMs: 5000, checkUpdates: true }, send, fetchImpl as never);
    expect(seen[0]).toMatchObject({ scheme: "http", port: 2375 });
    expect(res).toEqual({
      host: "docker1",
      version: "27.3.1",
      containers: [
        { id: "aaaaaaaaaaaa", name: "nginx", image: "nginx", imageId: "sha256:img1", state: "running", status: "Up 2 days (healthy)", health: "healthy", restartCount: 0, exitCode: 0, restartPolicy: "unless-stopped", compose: "web", shouldRun: true, updateAvailable: true },
        { id: "bbbbbbbbbbbb", name: "worker", image: "ghcr.io/me/worker:1", imageId: "sha256:img2", state: "restarting", status: "Restarting (1) 5 seconds ago", health: undefined, restartCount: 14, exitCode: 1, restartPolicy: "always", compose: undefined, shouldRun: true, updateAvailable: false },
      ],
    });
  });
});
