// Docker hosts' containers as health and inventory.
import { describe, expect, it } from "vitest";
import { containerStatus, dockerHealth, dockerInventory } from "./integrations/docker.js";

const c = (over: Record<string, unknown>) => ({ id: "x", name: "app", image: "nginx", state: "running", shouldRun: true, ...over }) as Parameters<typeof containerStatus>[0];

describe("Docker", () => {
  it("judges containers: restart loops and unhealthy are down; stopped ones only if they should run", () => {
    expect(containerStatus(c({ state: "restarting", restartCount: 14, exitCode: 1 }))).toEqual({ status: "down", message: "Restarting over and over (14 restarts, last exit code 1)" });
    expect(containerStatus(c({ health: "unhealthy", status: "Up 1 hour (unhealthy)" }))!.status).toBe("down");
    expect(containerStatus(c({ state: "exited", exitCode: 137, restartPolicy: "unless-stopped" }))!.message).toBe("Exited with code 137, but set to restart (unless-stopped)");
    expect(containerStatus(c({ state: "exited", shouldRun: false }))).toBeNull();
  });

  it("makes a monitor per host and per container that should stay up", () => {
    const out = dockerHealth({
      hosts: [
        { host: "192.168.1.20", port: 2375, ok: true, result: { host: "docker1", version: "27.3", containers: [c({ name: "nginx" }), c({ name: "job", state: "exited", shouldRun: false }), c({ name: "worker", state: "restarting", restartCount: 3 })] } },
        { host: "192.168.1.21", port: 2375, ok: false, error: "Could not reach Docker" },
      ],
    });
    expect(out.alerts!.map((a) => [a.key, a.name, a.status])).toEqual([
      ["host:192.168.1.20", "Docker on docker1", "up"],
      ["container:192.168.1.20/nginx", "nginx on docker1", "up"],
      ["container:192.168.1.20/worker", "worker on docker1", "down"],
      ["host:192.168.1.21", "Docker on 192.168.1.21", "down"],
    ]);
    expect(out.summary).toBe("1 of 2 host(s) answering, 2 container(s) watched, 1 with problems");
  });

  it("puts hosts and containers in the inventory, and says which have updates", () => {
    const out = dockerInventory({ hosts: [{ host: "192.168.1.20", port: 2375, ok: true, result: { host: "docker1", containers: [c({ name: "nginx", updateAvailable: true, compose: "web" }), c({ name: "db", updateAvailable: false })] } }] });
    expect(out.inventory!.map((i) => [i.externalId, i.kind, i.parentExternalId])).toEqual([
      ["host/192.168.1.20", "server", undefined],
      ["container/192.168.1.20/nginx", "container", "host/192.168.1.20"],
      ["container/192.168.1.20/db", "container", "host/192.168.1.20"],
    ]);
    expect(out.inventory![1]!.details).toEqual({ image: "nginx", state: "running", compose: "web", updateAvailable: true });
    expect(out.summary).toBe("1 update(s) available: nginx (nginx)");
  });
});
