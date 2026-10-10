// Write tools: they change things, so the gate only sends them when they match a step of an approved change
// request. Each does exactly one thing, then reads back the result so the agent can verify it.
import { sendRequest, type RawRequest } from "./custom-http.js";
import { arr, call, HomelabError, obj, type Base } from "./homelab.js";
import { clean } from "./parsers.js";
import { dataOf, withUnifi, type UnifiAuth } from "./unifi.js";
import { parseSystemctlShow, pinNote, run, ServerError, sshRun, type SshRun, type SshTarget } from "./servers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Servers over SSH ----------------------------------------------------------------------------

const SAFE_NAME = /^[A-Za-z0-9@._:-]{1,128}$/;
const quote = (name: string) => {
  // The argument schemas already restrict names; this keeps the shell quoting airtight regardless.
  if (!SAFE_NAME.test(name)) throw new ServerError("Invalid name");
  return `'${name}'`;
};

function sudoHint(stderr: string, what: string) {
  if (/a password is required|sudo: a terminal is required|not allowed to execute/i.test(stderr)) {
    return new ServerError(`sudo refused: the account needs passwordless sudo for ${what} (e.g. a sudoers line: moss ALL=(root) NOPASSWD: /usr/bin/systemctl)`);
  }
  return null;
}

export async function serviceRestart(t: SshTarget & { service: string; action: "restart" | "start" | "stop" }, ssh: SshRun = sshRun) {
  const unit = quote(t.service);
  const res = await run(t, `sudo -n systemctl ${t.action} ${unit}; rc=$?; systemctl show ${unit} --property=ActiveState,SubState,Result,ActiveEnterTimestamp --no-pager; exit $rc`, ssh);
  if (res.code !== 0) throw sudoHint(res.stderr, "systemctl") ?? new ServerError(`systemctl ${t.action} ${t.service} failed: ${clean(res.stderr) ?? `exit ${res.code}`}`);
  const p = parseSystemctlShow(res.stdout);
  return { target: t.target, service: t.service, action: t.action, active: p.ActiveState, sub: p.SubState, since: p.ActiveEnterTimestamp || undefined, ...pinNote(t, res.hostKeySha256) };
}

export async function containerRestart(t: SshTarget & { container: string; action: "restart" | "start" | "stop" }, ssh: SshRun = sshRun) {
  const name = quote(t.container);
  const res = await run(t, `docker ${t.action} ${name} >/dev/null && docker inspect --format '{{json .State}}' ${name}`, ssh);
  if (res.code !== 0) {
    const err = clean(res.stderr) ?? "";
    if (/permission denied/i.test(err)) throw new ServerError(`${t.user} isn't allowed to use Docker on ${t.target}`);
    if (/No such container/i.test(err)) throw new ServerError(`There is no container called ${t.container} on ${t.target}`);
    throw new ServerError(`docker ${t.action} ${t.container} failed: ${err}`);
  }
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  } catch {
    // inspect output is best-effort
  }
  return { target: t.target, container: t.container, action: t.action, status: clean(state.Status), running: state.Running === true, startedAt: clean(state.StartedAt), ...pinNote(t, res.hostKeySha256) };
}

export async function hostReboot(t: SshTarget & { delayMinutes: number }, ssh: SshRun = sshRun) {
  const res = await run(t, `sudo -n shutdown -r +${Math.trunc(t.delayMinutes)} 'Reboot by an approved MOSS change'`, ssh);
  if (res.code !== 0) throw sudoHint(res.stderr, "shutdown") ?? new ServerError(`shutdown failed: ${clean(res.stderr) ?? `exit ${res.code}`}`);
  return {
    target: t.target,
    scheduled: true,
    inMinutes: t.delayMinutes,
    note: "The server will reboot shortly. Verify with ping or host_facts once it is back.",
    ...pinNote(t, res.hostKeySha256),
  };
}

// --- Home Assistant ------------------------------------------------------------------------------

async function haState(send: RawRequest, a: Base & { token: string }, entity: string) {
  const { json } = await call(send, "Home Assistant", a, "GET", `/api/states/${entity}`, { Authorization: `Bearer ${a.token}` });
  return clean(obj(json).state);
}

async function haService(send: RawRequest, a: Base & { token: string }, entity: string, service: string) {
  const domain = entity.split(".")[0]!;
  await call(send, "Home Assistant", a, "POST", `/api/services/${domain}/${service}`, { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" }, JSON.stringify({ entity_id: entity }));
}

export async function homeassistantSwitch(a: Base & { token: string; entity: string; action: string }, send: RawRequest = sendRequest) {
  const before = await haState(send, a, a.entity);
  await haService(send, a, a.entity, a.action);
  await sleep(1000);
  return { entity: a.entity, action: a.action, before, after: await haState(send, a, a.entity) };
}

export async function homeassistantPowerCycle(a: Base & { token: string; entity: string; offSeconds: number }, send: RawRequest = sendRequest, wait = sleep) {
  const before = await haState(send, a, a.entity);
  await haService(send, a, a.entity, "turn_off");
  await wait(a.offSeconds * 1000);
  const whileOff = await haState(send, a, a.entity);
  await haService(send, a, a.entity, "turn_on");
  await wait(2000);
  const after = await haState(send, a, a.entity);
  return { entity: a.entity, before, whileOff, after, offSeconds: a.offSeconds, ok: whileOff === "off" && after === "on" };
}

// --- Pi-hole v6 ----------------------------------------------------------------------------------

async function piholeSession<T>(send: RawRequest, a: Base & { password: string }, fn: (h: Record<string, string>) => Promise<T>) {
  const auth = await call(send, "Pi-hole", a, "POST", "/api/auth", { "Content-Type": "application/json" }, JSON.stringify({ password: a.password }));
  const session = obj(obj(auth.json).session);
  const sid = clean(session.sid);
  if (session.valid !== true || !sid) throw new HomelabError("Pi-hole refused the password (Pi-hole v6 is required)");
  const h = { "X-FTL-SID": sid };
  try {
    return await fn(h);
  } finally {
    await call(send, "Pi-hole", a, "DELETE", "/api/auth", h).catch(() => {});
  }
}

export async function piholeDomainRule(a: Base & { password: string; domain: string; list: "deny" | "allow"; action: "add" | "remove" }, send: RawRequest = sendRequest) {
  return piholeSession(send, a, async (h) => {
    if (a.action === "add") {
      await call(send, "Pi-hole", a, "POST", `/api/domains/${a.list}/exact`, { ...h, "Content-Type": "application/json" }, JSON.stringify({ domain: a.domain, comment: "Added by an approved MOSS change" }));
    } else {
      await call(send, "Pi-hole", a, "DELETE", `/api/domains/${a.list}/exact/${encodeURIComponent(a.domain)}`, h).catch((err: Error) => {
        // Pi-hole answers 404 for a domain that isn't on the list; removing it is then already done.
        if (!/HTTP 404/.test(err.message)) throw err;
      });
    }
    const { json } = await call(send, "Pi-hole", a, "GET", `/api/domains/${a.list}/exact/${encodeURIComponent(a.domain)}`, h);
    return { domain: a.domain, list: a.list, action: a.action, onList: arr(obj(json).domains).length > 0 };
  });
}

export async function piholeLocalDns(a: Base & { password: string; hostname: string; ip: string; action: "add" | "remove" }, send: RawRequest = sendRequest) {
  return piholeSession(send, a, async (h) => {
    const entry = encodeURIComponent(`${a.ip} ${a.hostname}`);
    await call(send, "Pi-hole", a, a.action === "add" ? "PUT" : "DELETE", `/api/config/dns/hosts/${entry}`, h);
    const { json } = await call(send, "Pi-hole", a, "GET", "/api/config/dns/hosts", h);
    const hosts = obj(obj(obj(json).config).dns).hosts;
    const present = Array.isArray(hosts) && hosts.includes(`${a.ip} ${a.hostname}`);
    return { hostname: a.hostname, ip: a.ip, action: a.action, present };
  });
}

// --- AdGuard Home --------------------------------------------------------------------------------

const adguardAuth = (a: { user: string; password: string }) => ({ Authorization: `Basic ${Buffer.from(`${a.user}:${a.password}`).toString("base64")}` });

export async function adguardRule(a: Base & { user: string; password: string; domain: string; action: "block" | "unblock" | "remove" }, send: RawRequest = sendRequest) {
  const h = adguardAuth(a);
  const { json } = await call(send, "AdGuard Home", a, "GET", "/control/filtering/status", h);
  const rules = (Array.isArray(obj(json).user_rules) ? (obj(json).user_rules as unknown[]) : []).filter((r): r is string => typeof r === "string");
  const block = `||${a.domain}^`;
  const unblock = `@@||${a.domain}^`;
  // MOSS only touches its own two rule forms for this domain; everything else is left exactly as it was.
  const next = rules.filter((r) => r !== block && r !== unblock);
  if (a.action === "block") next.push(block);
  if (a.action === "unblock") next.push(unblock);
  await call(send, "AdGuard Home", a, "POST", "/control/filtering/set_rules", { ...h, "Content-Type": "application/json" }, JSON.stringify({ rules: next }));
  return { domain: a.domain, action: a.action, rule: a.action === "remove" ? null : a.action === "block" ? block : unblock, customRules: next.length };
}

export async function adguardRewrite(a: Base & { user: string; password: string; domain: string; answer: string; action: "add" | "remove" }, send: RawRequest = sendRequest) {
  const h = { ...adguardAuth(a), "Content-Type": "application/json" };
  await call(send, "AdGuard Home", a, "POST", a.action === "add" ? "/control/rewrite/add" : "/control/rewrite/delete", h, JSON.stringify({ domain: a.domain, answer: a.answer }));
  const { json } = await call(send, "AdGuard Home", a, "GET", "/control/rewrite/list", h);
  const present = arr(json).some((r) => r.domain === a.domain && r.answer === a.answer);
  return { domain: a.domain, answer: a.answer, action: a.action, present };
}

// --- UniFi (the console's network API, signed in with an API key or a local account) -------------

type UnifiArgs = UnifiAuth;

/** One call in its own session (a username and password sign in, and out again, around it). */
async function unifi(send: RawRequest, a: UnifiArgs, method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
  return withUnifi(send, a, async (req) => dataOf(await req(method, `/api/s/${a.site}${path}`, body)));
}

export async function unifiClientBlock(a: UnifiArgs & { mac: string; action: "block" | "unblock" }, send: RawRequest = sendRequest) {
  await unifi(send, a, "POST", "/cmd/stamgr", { cmd: a.action === "block" ? "block-sta" : "unblock-sta", mac: a.mac });
  const [client] = await unifi(send, a, "GET", `/stat/user/${a.mac}`);
  return { mac: a.mac, action: a.action, blocked: client?.blocked === true, name: clean(client?.name) ?? clean(client?.hostname) };
}

export async function unifiDhcpReservation(a: UnifiArgs & { mac: string; ip?: string }, send: RawRequest = sendRequest) {
  const [client] = await unifi(send, a, "GET", `/stat/user/${a.mac}`);
  const id = clean(client?._id);
  if (!id || !/^[0-9a-f]{24}$/.test(id)) throw new HomelabError(`The UniFi console doesn't know a client with MAC ${a.mac}`);
  const [updated] = await unifi(send, a, "PUT", `/rest/user/${id}`, a.ip ? { use_fixedip: true, fixed_ip: a.ip } : { use_fixedip: false });
  return { mac: a.mac, reserved: updated?.use_fixedip === true, ip: clean(updated?.fixed_ip) ?? null, note: "The client gets the address when it next renews its lease." };
}

export async function unifiWlanEnable(a: UnifiArgs & { ssid: string; enabled: boolean }, send: RawRequest = sendRequest) {
  const wlans = await unifi(send, a, "GET", "/rest/wlanconf");
  const wlan = wlans.find((w) => w.name === a.ssid);
  const id = clean(wlan?._id);
  if (!id || !/^[0-9a-f]{24}$/.test(id)) throw new HomelabError(`No Wi-Fi network called "${a.ssid}" (networks: ${wlans.map((w) => clean(w.name)).filter(Boolean).join(", ") || "none"})`);
  const [updated] = await unifi(send, a, "PUT", `/rest/wlanconf/${id}`, { enabled: a.enabled });
  return { ssid: a.ssid, enabled: updated?.enabled === true };
}
