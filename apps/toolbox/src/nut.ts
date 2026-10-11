// Network UPS Tools: a small client for upsd's text protocol (TCP 3493). Lists the UPSes and reads their
// variables: status (OL on mains, OB on battery, LB low battery, RB replace battery), charge, runtime, load.
import { connect as netConnect, type Socket } from "node:net";
import { clean } from "./parsers.js";

export class NutError extends Error {}

export interface UpsReading {
  name: string;
  description?: string;
  status: string;
  onBattery: boolean;
  lowBattery: boolean;
  replaceBattery: boolean;
  charge?: number;
  runtimeSeconds?: number;
  load?: number;
  inputVoltage?: number;
  manufacturer?: string;
  model?: string;
}

/** Parses "VAR ups key \"value\"" lines into a map. */
export function parseVars(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = /^VAR \S+ (\S+) "((?:[^"\\]|\\.)*)"$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.replace(/\\(.)/g, "$1");
  }
  return out;
}

export function reading(name: string, description: string | undefined, v: Record<string, string>): UpsReading {
  const status = v["ups.status"] ?? "";
  const flags = status.split(/\s+/);
  const n = (k: string) => (v[k] !== undefined && Number.isFinite(Number(v[k])) ? Number(v[k]) : undefined);
  return {
    name,
    description: clean(description) || undefined,
    status,
    onBattery: flags.includes("OB"),
    lowBattery: flags.includes("LB"),
    replaceBattery: flags.includes("RB"),
    charge: n("battery.charge"),
    runtimeSeconds: n("battery.runtime"),
    load: n("ups.load"),
    inputVoltage: n("input.voltage"),
    manufacturer: clean(v["device.mfr"] ?? v["ups.mfr"]) || undefined,
    model: clean(v["device.model"] ?? v["ups.model"]) || undefined,
  };
}

type Connect = (port: number, host: string) => Socket;

/** One conversation with upsd: commands in, lines out until each answer's end. */
async function conversation(host: string, port: number, timeoutMs: number, connect: Connect, run: (ask: (cmd: string, until: (line: string) => boolean) => Promise<string[]>) => Promise<UpsReading[]>) {
  const socket = connect(port, host);
  socket.setEncoding("utf8");
  let buffer = "";
  const lines: string[] = [];
  let waiter: (() => void) | null = null;
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      lines.push(buffer.slice(0, i).replace(/\r$/, ""));
      buffer = buffer.slice(i + 1);
    }
    waiter?.();
  });
  const closed = new Promise<never>((_, reject) => {
    socket.on("error", (err) => reject(new NutError(`Could not reach upsd at ${host}:${port}: ${err.message}`)));
    socket.on("close", () => reject(new NutError("upsd closed the connection")));
  });
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new NutError(`upsd at ${host}:${port} didn't answer in time`)), timeoutMs));
  const ask = async (cmd: string, until: (line: string) => boolean) => {
    socket.write(`${cmd}\n`);
    const got: string[] = [];
    const next = () =>
      new Promise<void>((resolve) => {
        waiter = resolve;
      });
    for (;;) {
      while (lines.length) {
        const line = lines.shift()!;
        if (line.startsWith("ERR ")) throw new NutError(`upsd: ${line.slice(4)}`);
        got.push(line);
        if (until(line)) return got;
      }
      await Promise.race([next(), closed, timer]);
    }
  };
  try {
    return await Promise.race([run(ask), timer]);
  } finally {
    socket.end("LOGOUT\n");
  }
}

export async function nutStatus(
  a: { target: string; port: number; user?: string; password?: string; timeoutMs: number },
  connect: Connect = (port, host) => netConnect({ port, host }),
): Promise<{ ups: UpsReading[] }> {
  const ups = await conversation(a.target, a.port, a.timeoutMs, connect, async (ask) => {
    if (a.user && a.password) {
      await ask(`USERNAME ${a.user}`, (l) => l.startsWith("OK"));
      await ask(`PASSWORD ${a.password}`, (l) => l.startsWith("OK"));
    }
    const list = await ask("LIST UPS", (l) => l === "END LIST UPS");
    const names = list.flatMap((l) => {
      const m = /^UPS (\S+) "(.*)"$/.exec(l);
      return m ? [{ name: m[1]!, description: m[2] }] : [];
    });
    const out: UpsReading[] = [];
    for (const u of names.slice(0, 8)) {
      const vars = await ask(`LIST VAR ${u.name}`, (l) => l === `END LIST VAR ${u.name}`);
      out.push(reading(u.name, u.description, parseVars(vars)));
    }
    return out;
  });
  if (!ups.length) throw new NutError("upsd has no UPS set up");
  return { ups };
}
