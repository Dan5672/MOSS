// Host pinning for calls that carry a credential. The gate sends the fingerprints it knows for this call's
// devices; every TLS or SSH connection the call makes is checked against them before anything is sent, and
// what each device presented goes back to the gate so it can remember new ones.
import { canonicalAddress } from "@moss/policy";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, rootCertificates } from "node:tls";

/**
 * The owner's own authority for device certificates (deploy/device-ca/ca.pem), trusted only for connections to
 * devices when certificates are checked, never for the toolbox's cloud or sign-in traffic.
 */
const DEVICE_CA = (() => {
  try {
    return readFileSync(process.env.MOSS_DEVICE_CA_FILE ?? "/device-ca/ca.pem", "utf8");
  } catch {
    return null;
  }
})();
export const deviceCa = DEVICE_CA ? [...rootCertificates, DEVICE_CA] : undefined;

export interface PinScope {
  /** "tls:<address>:<port>" or "ssh:<address>:<port>" → the fingerprint the device must present. */
  known: Record<string, string>;
  /** What each device presented during this call. */
  seen: Record<string, string>;
  /** The owner wants every device's certificate checked, whatever the tool asked for (Settings, Safety). */
  verifyTls?: boolean;
}

export const pinScope = new AsyncLocalStorage<PinScope>();

export class PinMismatch extends Error {}

const KEY = /^(tls|ssh):(.+):(\d+)$/;
const what = (kind: "tls" | "ssh") => (kind === "tls" ? "TLS certificate" : "SSH host key");
const TRUST_HINT = "A person can check the device and trust it in Settings, Security.";

/** The fingerprints a device presented on its other ports. */
function otherPorts(scope: PinScope, kind: "tls" | "ssh", host: string) {
  return Object.entries(scope.known).flatMap(([k, v]) => {
    const m = KEY.exec(k);
    return m && m[1] === kind && m[2] === host ? [v] : [];
  });
}

/**
 * Records what a device presented and refuses it when it isn't the pinned one. A port MOSS hasn't used before on a
 * device it knows only passes with a key the device already showed on another port. `trusted`: the certificate
 * was verified against a certificate authority, so a renewed one is fine. Does nothing outside a pinned call.
 */
export function checkPin(kind: "tls" | "ssh", target: string, port: number, fingerprint: string, opts: { trusted?: boolean } = {}) {
  const scope = pinScope.getStore();
  if (!scope) return;
  const host = canonicalAddress(target) ?? target;
  const key = `${kind}:${host}:${port}`;
  scope.seen[key] = fingerprint;
  const pinned = scope.known[key];
  if (pinned === fingerprint || opts.trusted) return;
  if (pinned) throw new PinMismatch(`${host}:${port} presented a different ${what(kind)} from the one MOSS remembered, so no credential was sent. ${TRUST_HINT}`);
  const others = otherPorts(scope, kind, host);
  if (others.length && !others.includes(fingerprint)) {
    throw new PinMismatch(`${host}:${port} is a new port on a device MOSS knows, with a ${what(kind)} MOSS hasn't seen there, so no credential was sent. ${TRUST_HINT}`);
  }
}

/** Refuses a plain-text request to a device that has used TLS before, so a credential can't be downgraded to HTTP. */
export function checkPlainText(target: string) {
  const scope = pinScope.getStore();
  if (!scope) return;
  const host = canonicalAddress(target) ?? target;
  if (otherPorts(scope, "tls", host).length) {
    throw new PinMismatch(`${host} has used HTTPS with MOSS before, so its credential won't be sent over plain HTTP. Use https.`);
  }
}

/**
 * For https requests in a pinned call: connects, checks the certificate, and only then hands the socket to the
 * request, so not even the request line is sent to the wrong device.
 */
export function pinnedConnection(target: string, port: number, verifyTls: boolean, timeoutMs: number) {
  if (!pinScope.getStore()) return undefined;
  return (_opts: unknown, done: (err: Error | null, socket?: Duplex) => void) => {
    const socket = tlsConnect({ host: target, port, rejectUnauthorized: verifyTls, ...(verifyTls && deviceCa ? { ca: deviceCa } : {}) });
    const timer = setTimeout(() => socket.destroy(new Error(`No answer within ${timeoutMs} ms`)), timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      try {
        // A renewed certificate is accepted only when the owner asked for verified certificates, not because a tool did.
        const ownerVerifies = pinScope.getStore()?.verifyTls === true;
        checkPin("tls", target, port, socket.getPeerCertificate().fingerprint256, { trusted: ownerVerifies && socket.authorized });
        done(null, socket);
      } catch (err) {
        socket.destroy();
        done(err as Error);
      }
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      done(err);
    });
    return undefined;
  };
}
