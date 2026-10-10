"use client";

import { useState } from "react";
import { CheckboxField, SelectField, TextField } from "@/components/field";

export type MonitorKind = "ping" | "tcp" | "http" | "tls" | "dns" | "snmp" | "host" | "ha_sensor";

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
  secret?: string;
  ifIndex?: number;
  oid?: string;
  counter?: boolean;
  user?: string;
  hostKeySha256?: string;
  metric?: string;
  unit?: string;
  warnAbove?: number;
  critAbove?: number;
  warnBelow?: number;
  critBelow?: number;
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
  { value: "snmp", label: "SNMP — interface traffic, or any numeric value" },
  { value: "host", label: "Host stats — load, memory and disk over SSH" },
  { value: "ha_sensor", label: "Home Assistant sensor — any entity's value" },
];

const METRIC_KINDS = new Set<MonitorKind>(["snmp", "host", "ha_sensor"]);

/** The values each metric monitor records; the thresholds apply to the one chosen. */
const METRICS: Record<string, { value: string; label: string }[]> = {
  snmpInterface: [
    { value: "", label: "Busiest direction (bits per second)" },
    { value: "inBps", label: "Traffic in (bits per second)" },
    { value: "outBps", label: "Traffic out (bits per second)" },
    { value: "inErrorsPerMin", label: "Errors in (per minute)" },
    { value: "outErrorsPerMin", label: "Errors out (per minute)" },
  ],
  value: [{ value: "", label: "The value" }],
  host: [
    { value: "", label: "Memory used (%)" },
    { value: "diskUsedPercent", label: "Fullest disk (%)" },
    { value: "load1", label: "Load, 1 minute" },
    { value: "load5", label: "Load, 5 minutes" },
    { value: "load15", label: "Load, 15 minutes" },
  ],
};

/** Common numeric OIDs, offered as suggestions. */
const COMMON_OIDS = [
  { oid: "1.3.6.1.2.1.1.3.0", label: "Uptime (hundredths of a second)" },
  { oid: "1.3.6.1.2.1.25.1.6.0", label: "Running processes" },
  { oid: "1.3.6.1.2.1.6.9.0", label: "Open TCP connections" },
  { oid: "1.3.6.1.4.1.2021.10.1.5.1", label: "Load, 1 minute ×100 (Linux net-snmp)" },
  { oid: "1.3.6.1.4.1.2021.4.6.0", label: "Free memory, kB (Linux net-snmp)" },
  { oid: "1.3.6.1.4.1.2021.11.11.0", label: "CPU idle % (Linux net-snmp)" },
  { oid: "1.3.6.1.4.1.318.1.1.1.2.2.1.0", label: "UPS battery % (APC)" },
  { oid: "1.3.6.1.4.1.318.1.1.1.4.2.3.0", label: "UPS load % (APC)" },
];

const TARGET_HINT: Record<MonitorKind, string> = {
  http: "IP or hostname. A hostname is resolved by MOSS and sent as the Host header.",
  tcp: "IP or hostname of the host.",
  ping: "IP or hostname of the host.",
  tls: "IP or hostname. A hostname is also used for SNI.",
  dns: "The name to resolve, e.g. nas.home.lan (or an IP with record type PTR).",
  snmp: "IP or hostname of the device. It must be in an allowed network.",
  host: "IP or hostname of the server. It must be in an allowed network.",
  ha_sensor: "The entity, e.g. sensor.ups_load. It's read through Settings → Integrations → Home Assistant.",
};

/** Kind-specific monitor fields. Shared by the create form and the edit panel. */
export function MonitorFields({
  defaults = {},
  assets,
  responders,
  secrets = [],
  compact = false,
}: {
  defaults?: MonitorDefaults;
  assets: { value: string; label: string }[];
  responders: { value: string; label: string }[];
  /** Stored secrets by name, for SNMP and host monitors' credentials. */
  secrets?: { value: string; label: string }[];
  compact?: boolean;
}) {
  const [kind, setKind] = useState<MonitorKind>(defaults.kind ?? "http");
  const [scheme, setScheme] = useState(defaults.scheme ?? "http");
  const [snmpMode, setSnmpMode] = useState<"interface" | "oid">(defaults.oid ? "oid" : "interface");
  const metrics = kind === "host" ? METRICS.host : kind === "snmp" && snmpMode === "interface" ? METRICS.snmpInterface : METRICS.value;
  const grid = compact ? "grid gap-3" : "grid gap-3 sm:grid-cols-2";

  return (
    <>
      <div className={grid}>
        <TextField label="Name" name="name" defaultValue={defaults.name} placeholder="NAS web UI" required />
        <SelectField label="Check type" name="kind" value={kind} onChange={(e) => setKind(e.target.value as MonitorKind)} options={KINDS} />
      </div>
      <div className={grid}>
        <TextField
          label={kind === "ha_sensor" ? "Entity" : "Target"}
          name="target"
          defaultValue={defaults.target}
          placeholder={kind === "ha_sensor" ? "sensor.ups_load" : "192.168.1.10"}
          hint={TARGET_HINT[kind]}
          required
        />
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
      {(kind === "snmp" || kind === "host") && (
        <div className={grid}>
          <SelectField
            label={kind === "snmp" ? "Community (stored secret)" : "SSH key (stored secret)"}
            name="secret"
            defaultValue={defaults.secret ?? ""}
            options={[{ value: "", label: secrets.length ? "Choose a secret" : "No secrets stored yet" }, ...secrets]}
            hint="Add it in Settings → Secrets first. Using one here needs permission to manage secrets."
            required
          />
          {kind === "snmp" ? (
            <SelectField
              label="Read"
              name="snmpMode"
              value={snmpMode}
              onChange={(e) => setSnmpMode(e.target.value as "interface" | "oid")}
              options={[
                { value: "interface", label: "An interface's traffic and errors" },
                { value: "oid", label: "A numeric OID" },
              ]}
            />
          ) : (
            <TextField label="Sign in as" name="user" defaultValue={defaults.user} placeholder="moss" hint="A read-only account is best." required />
          )}
        </div>
      )}
      {kind === "snmp" && snmpMode === "interface" && (
        <TextField
          label="Interface number (ifIndex)"
          name="ifIndex"
          type="number"
          min={1}
          defaultValue={defaults.ifIndex}
          hint="Ask an agent to run snmp_query with the interfaces preset to list them."
          required
        />
      )}
      {kind === "snmp" && snmpMode === "oid" && (
        <div className={grid}>
          <TextField label="OID" name="oid" defaultValue={defaults.oid} placeholder="1.3.6.1.2.1.25.1.6.0" list="moss-common-oids" required />
          <datalist id="moss-common-oids">
            {COMMON_OIDS.map((o) => (
              <option key={o.oid} value={o.oid}>
                {o.label}
              </option>
            ))}
          </datalist>
          <CheckboxField label="It counts up: show the rate per second" name="counter" defaultChecked={defaults.counter ?? false} />
        </div>
      )}
      {kind === "host" && (
        <div className={grid}>
          <TextField label="SSH port" name="port" type="number" min={1} max={65535} defaultValue={defaults.port ?? 22} />
          <TextField
            label="Host key (optional)"
            name="hostKeySha256"
            defaultValue={defaults.hostKeySha256}
            placeholder="SHA256:…"
            hint="Pin it so a different machine at that address is refused."
          />
        </div>
      )}
      {METRIC_KINDS.has(kind) && (
        <fieldset className="grid gap-3 px-frame p-3">
          <legend className="px-1 text-sm font-medium">Thresholds (optional)</legend>
          <div className={grid}>
            <SelectField label="Apply to" name="metric" defaultValue={defaults.metric ?? ""} options={metrics} />
            <TextField label="Unit (optional)" name="unit" defaultValue={defaults.unit} placeholder={kind === "ha_sensor" ? "From Home Assistant" : "%"} />
            <TextField label="Degraded above" name="warnAbove" type="number" step="any" defaultValue={defaults.warnAbove} />
            <TextField label="Down above" name="critAbove" type="number" step="any" defaultValue={defaults.critAbove} />
            <TextField label="Degraded below" name="warnBelow" type="number" step="any" defaultValue={defaults.warnBelow} />
            <TextField label="Down below" name="critBelow" type="number" step="any" defaultValue={defaults.critBelow} />
          </div>
          <p className="text-xs text-muted-foreground">Down means after the usual number of failed checks, raising an incident as for any monitor.</p>
        </fieldset>
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
        {!METRIC_KINDS.has(kind) && (
          <TextField
            label="Degraded above (ms, optional)"
            name="degradedMs"
            type="number"
            min={1}
            max={60000}
            defaultValue={defaults.degradedMs}
          />
        )}
      </div>

      <fieldset className="grid gap-3 px-frame p-3">
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
