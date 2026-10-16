"use client";

import { useState } from "react";
import { groupTools, toolGroup } from "@/lib/tool-groups";

/** The first sentence of a tool's description, shown under its name. */
const summary = (d: string) => d.match(/^.*?\.(?=\s|$)/)?.[0] ?? d;

/** Tool checkboxes (name="tools") in collapsible groups, each with a tick-all box and what each tool does. */
export function ToolPicker({ tools, initial }: { tools: { name: string; description: string }[]; initial: string[] }) {
  const [picked, setPicked] = useState(() => new Set(initial));
  const toggle = (names: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const n of names) {
        if (on) next.add(n);
        else next.delete(n);
      }
      return next;
    });

  return (
    <div className="grid gap-2">
      {groupTools(tools, (t) => toolGroup(t.name)).map((g) => {
        const names = g.items.map((t) => t.name);
        const all = names.every((t) => picked.has(t));
        const some = names.filter((t) => picked.has(t)).length;
        return (
          <details key={g.key} open={some > 0} className="border-2 px-3 py-2">
            <summary className="cursor-pointer text-sm">
              {g.label} <span className="font-mono text-xs text-dim">{some ? `${some} of ${g.items.length}` : `${g.items.length}`}</span>
            </summary>
            <div className="mt-2 grid gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" className="size-4 accent-primary" checked={all} onChange={(e) => toggle(names, e.target.checked)} />
                All {g.label.toLowerCase()} tools
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                {g.items.map(({ name, description }) => (
                  <label key={name} title={description} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      name="tools"
                      value={name}
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                      checked={picked.has(name)}
                      onChange={(e) => toggle([name], e.target.checked)}
                    />
                    <span className="grid">
                      <span className="font-mono text-sm">{name}</span>
                      <span className="text-xs text-muted-foreground">{summary(description)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
}
