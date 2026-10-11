// The NUT client against a small stand-in upsd.
import { createServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nutStatus, parseVars, reading } from "./nut.js";

const VARS: Record<string, string> = {
  "ups.status": "OB DISCHRG",
  "battery.charge": "64",
  "battery.runtime": "780",
  "ups.load": "23",
  "input.voltage": "0.0",
  "device.mfr": "APC",
  "device.model": "Back-UPS 900",
};

let port = 0;
const seen: string[] = [];
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  let buf = "";
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const cmd = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      seen.push(cmd);
      if (cmd.startsWith("USERNAME") || cmd.startsWith("PASSWORD")) socket.write(cmd.endsWith("wrong") ? "ERR ACCESS-DENIED\n" : "OK\n");
      else if (cmd === "LIST UPS") socket.write('BEGIN LIST UPS\nUPS apc "Rack UPS"\nEND LIST UPS\n');
      else if (cmd === "LIST VAR apc") {
        // Split across writes, as TCP may.
        socket.write("BEGIN LIST VAR apc\n");
        socket.write(Object.entries(VARS).map(([k, v]) => `VAR apc ${k} "${v}"`).join("\n") + "\nEND LIST ");
        socket.write("VAR apc\n");
      } else if (cmd === "LOGOUT") socket.end("OK Goodbye\n");
    }
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("Network UPS Tools", () => {
  it("reads flags and numbers", () => {
    expect(parseVars(['VAR apc ups.status "OL RB"', 'VAR apc device.model "Smart \\"UPS\\""'])).toEqual({ "ups.status": "OL RB", "device.model": 'Smart "UPS"' });
    expect(reading("apc", "", { "ups.status": "OB LB", "battery.charge": "9" })).toMatchObject({ onBattery: true, lowBattery: true, replaceBattery: false, charge: 9 });
  });

  it("lists the UPSes and reads each one's variables", async () => {
    const res = await nutStatus({ target: "127.0.0.1", port, timeoutMs: 3000 });
    expect(res).toEqual({
      ups: [
        {
          name: "apc",
          description: "Rack UPS",
          status: "OB DISCHRG",
          onBattery: true,
          lowBattery: false,
          replaceBattery: false,
          charge: 64,
          runtimeSeconds: 780,
          load: 23,
          inputVoltage: 0,
          manufacturer: "APC",
          model: "Back-UPS 900",
        },
      ],
    });
    expect(seen.filter((c) => c !== "LOGOUT")).toEqual(["LIST UPS", "LIST VAR apc"]);
  });

  it("signs in when given a user, and reports upsd's errors", async () => {
    seen.length = 0;
    await nutStatus({ target: "127.0.0.1", port, user: "monuser", password: "secret", timeoutMs: 3000 });
    expect(seen.filter((c) => c !== "LOGOUT").slice(0, 2)).toEqual(["USERNAME monuser", "PASSWORD secret"]);
    await expect(nutStatus({ target: "127.0.0.1", port, user: "monuser", password: "wrong", timeoutMs: 3000 })).rejects.toThrow("upsd: ACCESS-DENIED");
    await expect(nutStatus({ target: "127.0.0.1", port: 1, timeoutMs: 2000 })).rejects.toThrow(/Could not reach upsd|didn't answer/);
  });
});
