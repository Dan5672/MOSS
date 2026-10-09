"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { SelectField, TextAreaField, TextField } from "@/components/field";
import { createChangeAction } from "./actions";
import { PlannedCallsField, type ToolOption } from "./planned-calls-field";

type Option = { value: string; label: string };

/** The "Raise a change" form: carried out by an agent (with its exact tool calls) or by hand. */
export function RaiseChangeForm({ agents, incidents, assets, tools }: { agents: Option[]; incidents: Option[]; assets: Option[]; tools: ToolOption[] }) {
  const [by, setBy] = useState("hand");
  return (
    <ActionForm action={createChangeAction} submitLabel="Submit for approval">
      <TextField label="Title" name="title" placeholder="Replace the garage switch" required maxLength={200} />
      <TextAreaField label="What and why" name="description" rows={3} />
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField
          label="Type"
          name="type"
          options={[
            { value: "normal", label: "Normal (needs approval)" },
            { value: "emergency", label: "Emergency (runs now, reviewed after)" },
          ]}
        />
        <SelectField
          label="Risk"
          name="risk"
          defaultValue="medium"
          options={["low", "medium", "high"].map((r) => ({ value: r, label: r }))}
        />
        <SelectField label="Carried out by" name="carriedOutBy" value={by} onChange={(e) => setBy(e.target.value)} options={[{ value: "hand", label: "A person, by hand" }, ...agents]} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="For incident" name="incidentId" options={[{ value: "", label: "None" }, ...incidents]} />
        <label className="grid gap-1.5 text-sm font-medium">
          Affected assets
          <select
            name="assetIds"
            multiple
            size={4}
            className="w-full min-w-0 rounded-md border border-input bg-transparent px-2 py-1 text-sm font-normal dark:bg-input/30"
          >
            {assets.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Window starts" name="windowStart" type="datetime-local" hint="Optional. Nothing runs before it." />
        <TextField label="Window ends" name="windowEnd" type="datetime-local" />
      </div>
      {by !== "hand" && <PlannedCallsField tools={tools} />}
      <TextAreaField label="How it will be checked" name="verificationPlan" rows={2} />
      <TextAreaField label="How to undo it" name="rollbackPlan" rows={2} />
      <p className="text-xs text-muted-foreground">Only the title is required. The more you say, the easier it is to approve.</p>
    </ActionForm>
  );
}
