"use client";

import { useState } from "react";
import { groupTools, toolGroup } from "@/lib/tool-groups";

/** Tool checkboxes (name="tools") in collapsible groups, each with a tick-all box. */
export function ToolPicker({ tools, initial }: { tools: string[]; initial: string[] }) {
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
      {groupTools(tools, (t) => toolGroup(t)).map((g) => {
        const all = g.items.every((t) => picked.has(t));
        const some = g.items.filter((t) => picked.has(t)).length;
        return (
          <details key={g.key} open={some > 0} className="border-2 px-3 py-2">
            <summary className="cursor-pointer text-sm">
              {g.label} <span className="font-mono text-xs text-dim">{some ? `${some} of ${g.items.length}` : `${g.items.length}`}</span>
            </summary>
            <div className="mt-2 grid gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" className="size-4 accent-primary" checked={all} onChange={(e) => toggle(g.items, e.target.checked)} />
                All {g.label.toLowerCase()} tools
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                {g.items.map((t) => (
                  <label key={t} className="flex items-center gap-2 font-mono text-sm">
                    <input type="checkbox" name="tools" value={t} className="size-4 accent-primary" checked={picked.has(t)} onChange={(e) => toggle([t], e.target.checked)} />
                    {t}
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
