// Docker through a read-only socket proxy (e.g. docker-socket-proxy with CONTAINERS=1, IMAGES=1, INFO=1 and POST=0)
// on each host: containers, their state, health and restarts. Optionally, whether each image has a newer version:
// the registry is asked for the tag's digest with a HEAD request (it doesn't count against Docker Hub's pull limit)
// and compared with the digest the host has.
import { sendRequest, type RawRequest } from "./custom-http.js";
import { arr, call, HomelabError, num, obj, type Base } from "./homelab.js";
import { clean } from "./parsers.js";

type RegistryFetch = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

/** "nginx" → Docker Hub library/nginx:latest; "ghcr.io/owner/app:1.2" → ghcr.io owner/app:1.2. Pinned (@sha256) images: null. */
export function parseImageRef(ref: string): { registry: string; repo: string; tag: string } | null {
  if (ref.includes("@")) return null;
  const slash = ref.indexOf("/");
  const first = slash === -1 ? "" : ref.slice(0, slash);
  const hasRegistry = first.includes(".") || first.includes(":") || first === "localhost";
  const registry = hasRegistry ? first : "registry-1.docker.io";
  let rest = hasRegistry ? ref.slice(slash + 1) : ref;
  const colon = rest.lastIndexOf(":");
  const tag = colon > rest.lastIndexOf("/") && colon !== -1 ? rest.slice(colon + 1) : "latest";
  if (colon > rest.lastIndexOf("/") && colon !== -1) rest = rest.slice(0, colon);
  const repo = registry === "registry-1.docker.io" && !rest.includes("/") ? `library/${rest}` : rest;
  return { registry: registry === "docker.io" ? "registry-1.docker.io" : registry, repo, tag };
}

/** The registry's digest for an image tag, signing in anonymously if the registry asks (Docker Hub, GHCR...). */
export async function remoteDigest(ref: string, fetchImpl: RegistryFetch = fetch as unknown as RegistryFetch): Promise<string | null> {
  const r = parseImageRef(ref);
  if (!r) return null;
  const url = `https://${r.registry}/v2/${r.repo}/manifests/${r.tag}`;
  let res = await fetchImpl(url, { method: "HEAD", headers: { Accept: MANIFEST_TYPES } });
  if (res.status === 401) {
    const challenge = res.headers.get("www-authenticate") ?? "";
    const param = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(challenge)?.[1];
    const realm = param("realm");
    if (!realm || !/^https:\/\//.test(realm)) return null;
    const tokenUrl = `${realm}?service=${encodeURIComponent(param("service") ?? "")}&scope=${encodeURIComponent(param("scope") ?? `repository:${r.repo}:pull`)}`;
    const t = await fetchImpl(tokenUrl, { method: "GET", headers: {} });
    if (t.status !== 200) return null;
    const body = JSON.parse(await t.text()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) return null;
    res = await fetchImpl(url, { method: "HEAD", headers: { Accept: MANIFEST_TYPES, Authorization: `Bearer ${token}` } });
  }
  return res.status === 200 ? res.headers.get("docker-content-digest") : null;
}

const RESTART_POLICIES = new Set(["always", "unless-stopped", "on-failure"]);

export async function dockerApiContainers(
  a: Base & { checkUpdates?: boolean },
  send: RawRequest = sendRequest,
  registry: RegistryFetch = fetch as unknown as RegistryFetch,
) {
  const b = { ...a, scheme: a.scheme ?? ("http" as const) };
  const get = async (path: string) => (await call(send, "Docker", b, "GET", path, {})).json;
  const info = obj(await get("/info"));
  const list = arr(await get("/containers/json?all=1")).slice(0, 150);
  const containers = await Promise.all(
    list.map(async (c) => {
      const id = String(c.Id ?? "");
      let detail: Record<string, unknown> = {};
      try {
        detail = obj(await get(`/containers/${encodeURIComponent(id)}/json`));
      } catch {
        // The proxy may not allow inspecting; the list still says enough.
      }
      const state = obj(detail.State);
      const labels = obj(c.Labels);
      return {
        id: id.slice(0, 12),
        name: String((Array.isArray(c.Names) ? c.Names[0] : undefined) ?? id.slice(0, 12)).replace(/^\//, ""),
        image: clean(c.Image) ?? "",
        imageId: clean(c.ImageID),
        state: clean(c.State) ?? clean(state.Status) ?? "unknown",
        status: clean(c.Status),
        health: clean(obj(state.Health).Status),
        restartCount: num(detail.RestartCount),
        exitCode: num(state.ExitCode),
        restartPolicy: clean(obj(obj(detail.HostConfig).RestartPolicy).Name) ?? undefined,
        compose: clean(labels["com.docker.compose.project"]),
        shouldRun: RESTART_POLICIES.has(String(obj(obj(detail.HostConfig).RestartPolicy).Name ?? "")),
      };
    }),
  );

  let updates: Record<string, boolean> = {};
  if (a.checkUpdates) {
    // One look-up per image, not per container.
    const images = [...new Set(containers.map((c) => c.image))].filter((i) => !i.startsWith("sha256:")).slice(0, 40);
    const results = await Promise.all(
      images.map(async (image) => {
        try {
          const local = containers.find((c) => c.image === image)?.imageId ?? image;
          const img = obj(await get(`/images/${encodeURIComponent(local)}/json`));
          const have = (Array.isArray(img.RepoDigests) ? img.RepoDigests : []).map((d) => String(d).split("@")[1]);
          const latest = await remoteDigest(image, registry);
          return [image, latest !== null && have.length > 0 && !have.includes(latest)] as const;
        } catch {
          return [image, false] as const;
        }
      }),
    );
    updates = Object.fromEntries(results);
  }

  if (!info.Name && !list.length) throw new HomelabError("Docker didn't answer (is the socket proxy allowing CONTAINERS and INFO?)");
  return {
    host: clean(info.Name),
    version: clean(info.ServerVersion),
    containers: containers.map((c) => ({ ...c, ...(a.checkUpdates ? { updateAvailable: updates[c.image] ?? false } : {}) })),
  };
}
