"use client";

import { startTransition, useActionState } from "react";
import { toast } from "sonner";
import { CheckboxField, SelectField, TextField } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Snippet } from "../../../monitoring/sources/new-source-form";
import { newHomeAssistantTokenAction, saveHomeAssistantAlertsAction, type AlertsSaved } from "../actions";

/** What to paste into Home Assistant: a rest_command that sends alerts to MOSS, and an example automation. */
export function AlertsSetup({ url, token }: { url: string; token: string }) {
  return (
    <div className="grid gap-3 text-sm">
      <p>
        1. Add this to Home Assistant&apos;s <code>configuration.yaml</code> and restart Home Assistant:
      </p>
      <Snippet>{`rest_command:
  moss_alert:
    url: "${url}"
    method: POST
    headers:
      Authorization: "Bearer ${token}"
    content_type: "application/json"
    payload: >-
      {"key": {{ key | tojson }}, "name": {{ name | tojson }},
       "problem": {{ problem | lower }}, "message": {{ message | tojson }}}`}</Snippet>
      <p>2. Call it from an automation. For example, a leak sensor (problem is true while it&apos;s wet):</p>
      <Snippet>{`alias: "MOSS: kitchen leak"
triggers:
  - trigger: state
    entity_id: binary_sensor.kitchen_leak
actions:
  - action: rest_command.moss_alert
    data:
      key: kitchen_leak
      name: Kitchen leak sensor
      problem: "{{ trigger.to_state.state == 'on' }}"
      message: "Kitchen leak sensor is {{ trigger.to_state.state }}"`}</Snippet>
      <p className="text-muted-foreground">
        Each key becomes one monitor in MOSS. problem: true opens an incident for the responder below; problem: false marks it recovered. Use any
        trigger: the UPS going on battery, a NAS temperature, an integration going unavailable.
      </p>
    </div>
  );
}

export function AlertsForm({
  baseUrl,
  alerts,
  health,
  priority,
  responder,
  unavailableThreshold,
  agents,
  hasSource,
}: {
  baseUrl: string;
  alerts: boolean;
  health: boolean;
  priority: string;
  responder: string;
  unavailableThreshold: number;
  agents: { value: string; label: string }[];
  hasSource: boolean;
}) {
  const [state, formAction, pending] = useActionState(async (prev: AlertsSaved, form: FormData) => {
    const result = await saveHomeAssistantAlertsAction(prev, form);
    if (result?.ok && result.message) toast.success(result.message);
    return result;
  }, undefined);
  const [rotated, rotate, rotating] = useActionState(async (prev: AlertsSaved) => {
    const result = await newHomeAssistantTokenAction(prev);
    if (result?.ok && result.message) toast.success(result.message);
    return result;
  }, undefined);
  const shown = (rotated?.ok && rotated.token ? rotated : null) ?? (state?.ok && state.token ? state : null);
  const error = state?.error ?? rotated?.error;

  return (
    <div className="grid gap-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          startTransition(() => formAction(data));
        }}
        className="grid gap-4"
      >
        <CheckboxField
          label="Alerts from Home Assistant automations"
          name="alerts"
          defaultChecked={alerts}
          hint="Your automations send events to MOSS (a leak, the UPS on battery, a freezer warming up) and MOSS opens incidents for them."
        />
        <CheckboxField
          label="Health checks"
          name="health"
          defaultChecked={health}
          hint="Every 5 minutes: is Home Assistant answering, have integrations failed, are updates pending, are many entities unavailable."
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <SelectField label="Priority" name="priority" defaultValue={priority} options={["P1", "P2", "P3", "P4"].map((p) => ({ value: p, label: p }))} />
          <SelectField label="Responder" name="responder" defaultValue={responder} options={[{ value: "", label: "Nobody (incidents unassigned)" }, ...agents]} />
          <TextField label="Unavailable entities before warning" name="unavailableThreshold" type="number" min={1} max={10000} defaultValue={unavailableThreshold} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving..." : "Save alerts and health checks"}
          </Button>
        </div>
      </form>
      {hasSource && !shown && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!window.confirm("Issue a new webhook token? The current one stops working.")) return;
            startTransition(() => rotate());
          }}
        >
          <Button type="submit" variant="outline" size="sm" disabled={rotating}>
            New webhook token
          </Button>
        </form>
      )}
      {shown?.token && shown.sourceId && (
        <div className="grid gap-4">
          <div className="border-2 border-amber bg-amber/10 p-3 text-sm">This is the only time the webhook token is shown. Set up Home Assistant now, or issue a new token later.</div>
          <AlertsSetup url={`${baseUrl}/api/hooks/monitoring/${shown.sourceId}`} token={shown.token} />
        </div>
      )}
    </div>
  );
}
