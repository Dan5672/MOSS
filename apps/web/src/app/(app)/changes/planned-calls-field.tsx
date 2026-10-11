"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export interface ToolOption {
  name: string;
  kind: string;
  description: string;
  /** Arguments to start from: the tool's required ones, with placeholder values. */
  skeleton: Record<string, unknown>;
}

interface Call {
  tool: string;
  args: string;
}

/**
 * The tool calls an agent will run for the change, as a hidden JSON field. Each call's arguments are
 * checked against the tool's own schema when the change is saved, so mistakes come back as form errors.
 */
export function PlannedCallsField({ tools }: { tools: ToolOption[] }) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [pick, setPick] = useState(tools.find((t) => t.kind !== "read")?.name ?? tools[0]?.name ?? "");
  const byName = new Map(tools.map((t) => [t.name, t]));
  const value = JSON.stringify(
    calls.map((c) => {
      try {
        return { tool: c.tool, args: JSON.parse(c.args) };
      } catch {
        return { tool: c.tool, args: c.args }; // left as text: the server says which call isn't valid JSON
      }
    }),
  );

  return (
    <fieldset className="grid gap-3">
      <legend className="text-sm font-medium">Tool calls the agent will run</legend>
      <input type="hidden" name="plannedCalls" value={value} />
      {calls.map((c, i) => (
        <div key={i} className="grid gap-1.5 border-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm">
              {i + 1}. {c.tool}
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCalls(calls.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Arguments (JSON). Secrets are written as secret:&lt;name&gt;.
            <textarea
              aria-label={`Arguments for call ${i + 1}, ${c.tool}`}
              className="min-h-24 rounded-md border border-input bg-transparent p-2 font-mono text-xs text-foreground"
              value={c.args}
              onChange={(e) => setCalls(calls.map((x, j) => (j === i ? { ...x, args: e.target.value } : x)))}
            />
          </label>
          <p className="text-xs text-muted-foreground">{byName.get(c.tool)?.description}</p>
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid flex-1 gap-1 text-sm">
          <span className="font-medium">Tool</span>
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm dark:bg-input/30"
          >
            {tools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.kind})
              </option>
            ))}
          </select>
        </label>
        <Button type="button" variant="outline" onClick={() => pick && setCalls([...calls, { tool: pick, args: JSON.stringify(byName.get(pick)?.skeleton ?? {}, null, 2) }])}>
          Add call
        </Button>
      </div>
    </fieldset>
  );
}
