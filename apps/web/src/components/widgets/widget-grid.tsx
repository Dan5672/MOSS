"use client";

import { startTransition, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SIZE_CLASS, type WidgetInfo, type WidgetLayoutItem, type WidgetSize } from "./registry";

const SIZE_NAMES: Record<WidgetSize, string> = { s: "Small", m: "Medium", l: "Wide" };
const SIZE_LETTER: Record<WidgetSize, string> = { s: "S", m: "M", l: "W" };
const TOOL = "h-7 px-2 text-xs";
const NEXT_SIZE: Record<WidgetSize, WidgetSize> = { s: "m", m: "l", l: "s" };

/**
 * A grid of cards in a person's own order and sizes. Customise lets them move, resize, remove and add
 * cards, or go back to the default; Done saves. Cards are rendered on the server and passed in by id.
 */
export function WidgetGrid({
  cards,
  layout: saved,
  widgets,
  defaultLayout,
  save,
  label,
}: {
  cards: Record<string, ReactNode>;
  layout: WidgetLayoutItem[];
  widgets: WidgetInfo[];
  defaultLayout: WidgetLayoutItem[];
  save: (layout: WidgetLayoutItem[]) => Promise<{ ok?: boolean; error?: string } | undefined>;
  label: string;
}) {
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState(saved);
  const [adding, setAdding] = useState("");
  const hidden = widgets.filter((w) => !layout.some((l) => l.id === w.id));
  const title = (id: string) => widgets.find((w) => w.id === id)?.title ?? id;

  const move = (i: number, by: number) => {
    const next = [...layout];
    const [item] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, item!);
    setLayout(next);
  };
  const done = () =>
    startTransition(async () => {
      const result = await save(layout);
      if (result?.error) toast.error(result.error);
      else {
        toast.success("Dashboard saved.");
        setEditing(false);
      }
    });

  return (
    <section aria-label={label} className="grid gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {editing ? (
          <>
            {hidden.length > 0 && (
              <span className="flex items-center gap-2">
                <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Card to add" className="h-9 border bg-transparent px-2 text-sm">
                  <option value="">Add a card…</option>
                  {hidden.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.title}: {w.description}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!adding}
                  onClick={() => {
                    const w = widgets.find((x) => x.id === adding);
                    if (w) setLayout([...layout, { id: w.id, size: w.size }]);
                    setAdding("");
                  }}
                >
                  Add
                </Button>
              </span>
            )}
            <Button type="button" variant="outline" onClick={() => setLayout(defaultLayout)}>
              Reset to default
            </Button>
            <Button type="button" onClick={done}>
              Done
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" onClick={() => setEditing(true)}>
            Customise
          </Button>
        )}
      </div>
      {layout.length === 0 && <p className="border-2 border-dashed p-8 text-center text-sm text-muted-foreground">No cards. Customise to add some.</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        {layout.map((item, i) => (
          <div key={item.id} className={cn("relative min-w-0", SIZE_CLASS[item.size], editing && "outline-2 outline-offset-2 outline-dashed outline-dim")}>
            {editing && (
              <div role="toolbar" aria-label={`${title(item.id)} card`} className="mb-1.5 flex items-center gap-1 font-mono text-xs">
                <span className="mr-auto min-w-0 truncate font-sans font-medium" title={title(item.id)}>
                  {title(item.id)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={TOOL}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${title(item.id)} earlier`}
                >
                  ←
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={TOOL}
                  disabled={i === layout.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${title(item.id)} later`}
                >
                  →
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={TOOL}
                  onClick={() => setLayout(layout.map((l, j) => (j === i ? { ...l, size: NEXT_SIZE[l.size] } : l)))}
                  aria-label={`${title(item.id)} size: ${SIZE_NAMES[item.size]}. Change size`}
                >
                  {SIZE_LETTER[item.size]}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={TOOL}
                  onClick={() => setLayout(layout.filter((_, j) => j !== i))}
                  aria-label={`Remove ${title(item.id)}`}
                >
                  ✕
                </Button>
              </div>
            )}
            <div className={cn("h-full", editing && "pointer-events-none opacity-80")}>{cards[item.id]}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
