"use client";

import { startTransition, useActionState, useState } from "react";
import { toast } from "sonner";
import { SelectField, TextField } from "@/components/field";
import { Button } from "@/components/ui/button";
import { createSourceAction, type SourceCreated } from "../actions";

type Kind = "uptime_kuma" | "beszel" | "alertmanager" | "generic";

const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: "uptime_kuma", label: "Uptime Kuma" },
  { value: "beszel", label: "Beszel" },
  { value: "alertmanager", label: "Prometheus Alertmanager" },
  { value: "generic", label: "Generic JSON (scripts, cron jobs, anything else)" },
];

function Snippet({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-16 text-xs whitespace-pre-wrap break-all">{children}</pre>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="absolute top-1.5 right-1.5 h-7"
        onClick={() => navigator.clipboard.writeText(children).then(() => toast.success("Copied"))}
      >
        Copy
      </Button>
    </div>
  );
}

/** Setup steps for each sender, with the URL and token filled in. */
export function SetupInstructions({ kind, url, token }: { kind: Kind; url: string; token: string }) {
  const host = url.replace(/^https?:\/\//, "");
  switch (kind) {
    case "uptime_kuma":
      return (
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>In Uptime Kuma, open Settings → Notifications → Setup Notification and choose type <strong>Webhook</strong>.</li>
          <li>
            Post URL: <Snippet>{url}</Snippet>
          </li>
          <li>Request body: <strong>Preset - application/json</strong>.</li>
          <li>
            Enable <strong>Additional Headers</strong> and paste: <Snippet>{JSON.stringify({ Authorization: `Bearer ${token}` })}</Snippet>
          </li>
          <li>Apply it to the monitors you want MOSS to act on, and press Test. Each Uptime Kuma monitor becomes a MOSS monitor on its first alert.</li>
        </ol>
      );
    case "beszel":
      return (
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>In Beszel, open Settings → Notifications and add a webhook / push URL:</li>
          <li>
            <Snippet>{`generic://${host}?template=json&token=${token}`}</Snippet>
            <p className="mt-1 text-xs text-muted-foreground">
              Shoutrrr&apos;s generic service posts over HTTPS by default. If MOSS is on plain HTTP, add <code>&amp;disabletls=yes</code>.
            </p>
          </li>
          <li>Turn on the alerts you want (status, CPU, memory, disk…) for each system. &quot;Above threshold&quot; is treated as down, &quot;below threshold&quot; as recovered.</li>
        </ol>
      );
    case "alertmanager":
      return (
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Add a receiver to alertmanager.yml and route the alerts you want to it:</li>
          <li>
            <Snippet>{`receivers:
  - name: moss
    webhook_configs:
      - url: ${url}
        send_resolved: true
        http_config:
          authorization:
            credentials: ${token}`}</Snippet>
          </li>
          <li>Alerts with severity warning or info are degraded; anything else firing is down.</li>
        </ol>
      );
    case "generic":
      return (
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>POST JSON with a stable key and a status of up, down or degraded:</li>
          <li>
            <Snippet>{`curl -X POST '${url}' \\
  -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' \\
  -d '{"key":"nightly-backup","name":"Nightly backup","status":"down","message":"rsync exited 23"}'`}</Snippet>
          </li>
          <li>Send status up when it recovers. Several alerts can go in one request as {"{\"alerts\": [...]}"}.</li>
        </ol>
      );
  }
}

export function NewSourceForm({ baseUrl, agents }: { baseUrl: string; agents: { value: string; label: string }[] }) {
  const [kind, setKind] = useState<Kind>("uptime_kuma");
  const [state, formAction, pending] = useActionState(async (prev: SourceCreated, form: FormData) => {
    const result = await createSourceAction(prev, form);
    if (result?.ok && result.message) toast.success(result.message);
    return result;
  }, undefined);

  if (state?.ok && state.token && state.sourceId) {
    const url = `${baseUrl}/api/hooks/monitoring/${state.sourceId}`;
    return (
      <div className="grid gap-4">
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          This is the only time the token is shown. Set up the sender now, or delete the source and create a new one later.
        </div>
        <div className="grid gap-1.5 text-sm">
          <span className="font-medium">Token</span>
          <Snippet>{state.token}</Snippet>
        </div>
        <SetupInstructions kind={kind} url={url} token={state.token} />
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
      className="grid gap-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="Sends from" name="kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} options={KIND_OPTIONS} />
        <TextField label="Name" name="name" placeholder="Uptime Kuma on the NAS" required />
        <SelectField
          label="Default responder"
          name="defaultResponderAgentId"
          options={[{ value: "", label: "Nobody (incidents unassigned)" }, ...agents]}
          hint="Assigned to monitors this source creates. Change it per monitor later."
        />
        <SelectField label="Default priority" name="defaultPriority" defaultValue="P3" options={["P1", "P2", "P3", "P4"].map((p) => ({ value: p, label: p }))} />
      </div>
      {state?.error && (
        <p role="alert" className="text-sm whitespace-pre-line text-destructive">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Working…" : "Create source"}
        </Button>
      </div>
    </form>
  );
}
