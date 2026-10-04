"use client";

import { useState } from "react";
import { CheckboxField, SelectField, TextField } from "@/components/field";

export type MonitorKind = "ping" | "tcp" | "http" | "tls" | "dns";

export interface MonitorDefaults {
  name?: string;
  kind?: MonitorKind;
  target?: string;
  port?: number;
  scheme?: "http" | "https";
  path?: string;
  keyword?: string;
  expectStatus?: number[];
  verifyTls?: boolean;
  warnDays?: number;
  recordType?: "A" | "AAAA" | "PTR";
  expectAnswer?: string;
  degradedMs?: number;
  incidentOnDegraded?: boolean;
  assetId?: string | null;
  intervalSeconds?: number;
  failureThreshold?: number;
  recoveryThreshold?: number;
  priority?: string;
  responder?: string;
  autoResolve?: boolean;
}

const KINDS: { value: MonitorKind; label: string }[] = [
  { value: "http", label: "HTTP(S) — status code and optional keyword" },
  { value: "tcp", label: "TCP port — is the port accepting connections" },
  { value: "ping", label: "Ping — is the host reachable" },
  { value: "tls", label: "TLS certificate — expiry and trust" },
  { value: "dns", label: "DNS — does a name resolve (to the right address)" },
];

const TARGET_HINT: Record<MonitorKind, string> = {
  http: "IP or hostname. A hostname is resolved by MOSS and sent as the Host header.",
  tcp: "IP or hostname of the host.",
  ping: "IP or hostname of the host.",
  tls: "IP or hostname. A hostname is also used for SNI.",
  dns: "The name to resolve, e.g. nas.home.lan (or an IP with record type PTR).",
};

/** Kind-specific monitor fields. Shared by the create form and the edit panel. */
export function MonitorFields({
  defaults = {},
  assets,
  responders,
  compact = false,
}: {
  defaults?: MonitorDefaults;
  assets: { value: string; label: string }[];
  responders: { value: string; label: string }[];
  compact?: boolean;
}) {
  const [kind, setKind] = useState<MonitorKind>(defaults.kind ?? "http");
  const [scheme, setScheme] = useState(defaults.scheme ?? "http");
  const grid = compact ? "grid gap-3" : "grid gap-3 sm:grid-cols-2";

  return (
    <>
      <div className={grid}>
        <TextField label="Name" name="name" defaultValue={defaults.name} placeholder="NAS web UI" required />
        <SelectField label="Check type" name="kind" value={kind} onChange={(e) => setKind(e.target.value as MonitorKind)} options={KINDS} />
      </div>
      <div className={grid}>
        <TextField label="Target" name="target" defaultValue={defaults.target} placeholder="192.168.1.10" hint={TARGET_HINT[kind]} required />
        {(kind === "tcp" || kind === "http" || kind === "tls") && (
          <TextField
            label="Port"
            name="port"
            type="number"
            min={1}
            max={65535}
            defaultValue={defaults.port}
            placeholder={kind === "tcp" ? "22" : kind === "tls" || scheme === "https" ? "443" : "80"}
            required={kind === "tcp"}
          />
        )}
        {kind === "dns" && (
          <SelectField
            label="Record type"
            name="recordType"
            defaultValue={defaults.recordType ?? "A"}
            options={["A", "AAAA", "PTR"].map((t) => ({ value: t, label: t }))}
          />
        )}
      </div>

      {kind === "http" && (
        <div className={grid}>
          <SelectField
            label="Scheme"
            name="scheme"
            value={scheme}
            onChange={(e) => setScheme(e.target.value as "http" | "https")}
            options={[
              { value: "http", label: "http" },
              { value: "https", label: "https" },
            ]}
          />
          <TextField label="Path" name="path" defaultValue={defaults.path} placeholder="/" />
          <TextField label="Keyword (optional)" name="keyword" defaultValue={defaults.keyword} hint="Must appear in the first 256 KB of the response." />
          <TextField
            label="Expected status (optional)"
            name="expectStatus"
            defaultValue={defaults.expectStatus?.join(", ")}
            placeholder="200, 204"
            hint="Default: any 2xx or 3xx."
          />
        </div>
      )}
      {kind === "tls" && <TextField label="Warn when expiring within (days)" name="warnDays" type="number" min={1} max={365} defaultValue={defaults.warnDays ?? 14} />}
      {kind === "dns" && (
        <TextField label="Expected answer (optional)" name="expectAnswer" defaultValue={defaults.expectAnswer} placeholder="192.168.1.10" />
      )}
      {((kind === "http" && scheme === "https") || kind === "tls") && (
        <CheckboxField
          label="Require a trusted certificate"
          name="verifyTls"
          defaultChecked={defaults.verifyTls ?? true}
          hint="Turn off for devices with self-signed certificates."
        />
      )}

      <div className={grid}>
        <SelectField label="Asset" name="assetId" defaultValue={defaults.assetId ?? ""} options={[{ value: "", label: "None" }, ...assets]} />
        <TextField
          label="Check every (seconds)"
          name="intervalSeconds"
          type="number"
          min={30}
          max={86400}
          defaultValue={defaults.intervalSeconds ?? 60}
        />
        <TextField
          label="Down after (failed checks)"
          name="failureThreshold"
          type="number"
          min={1}
          max={20}
          defaultValue={defaults.failureThreshold ?? 3}
        />
        <TextField
          label="Up after (good checks)"
          name="recoveryThreshold"
          type="number"
          min={1}
          max={20}
          defaultValue={defaults.recoveryThreshold ?? 2}
        />
        <TextField
          label="Degraded above (ms, optional)"
          name="degradedMs"
          type="number"
          min={1}
          max={60000}
          defaultValue={defaults.degradedMs}
        />
      </div>

      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">When it goes down</legend>
        <div className={grid}>
          <SelectField
            label="Responder"
            name="responder"
            defaultValue={defaults.responder ?? ""}
            options={responders}
            hint="An incident is raised and assigned to them. An agent starts working it straight away."
          />
          <SelectField
            label="Incident priority"
            name="priority"
            defaultValue={defaults.priority ?? "P3"}
            options={["P1", "P2", "P3", "P4"].map((p) => ({ value: p, label: p }))}
          />
        </div>
        <CheckboxField
          label="Resolve the incident automatically on recovery"
          name="autoResolve"
          defaultChecked={defaults.autoResolve ?? false}
          hint="Otherwise the responder is told it recovered and confirms the fix before resolving."
        />
        <CheckboxField label="Raise a P4 incident when degraded (not only a notification)" name="incidentOnDegraded" defaultChecked={defaults.incidentOnDegraded ?? false} />
      </fieldset>
    </>
  );
}
