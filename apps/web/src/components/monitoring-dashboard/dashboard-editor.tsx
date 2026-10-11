"use client";

import type { DashboardWidget } from "@moss/db";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { deleteDashboardAction, saveDashboardAction } from "@/app/(app)/monitoring/dashboards/actions";
import { WIDGET_LABELS } from "./labels";
import { WidgetSettings, type MonitorOption } from "./widget-settings";

const ROW_PX = 160;
const GAP_PX = 12;
const TOOL = "h-8 px-2 text-xs";
const DEFAULT_SIZE: Record<DashboardWidget["type"], { w: number; h: number }> = {
  graph: { w: 6, h: 2 },
  gauge: { w: 3, h: 2 },
  value: { w: 3, h: 1 },
  history: { w: 12, h: 2 },
  status: { w: 6, h: 2 },
  top: { w: 4, h: 2 },
  incidents: { w: 4, h: 2 },
  note: { w: 4, h: 1 },
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `w${Date.now()}${Math.random().toString(36).slice(2)}`);

/**
 * A dashboard, and (for people who may edit it) its edit mode: drag cards to reorder, drag a corner to resize
 * (or use the buttons, from the keyboard), change each card's settings, add and remove cards, rename and share.
 * Cards are rendered on the server and passed in by widget id; new ones show once saved.
 */
export function DashboardEditor({
  dashboard,
  cards,
  monitors,
  canEdit,
  canShare,
  startEditing = false,
}: {
  dashboard: { id: string; name: string; shared: boolean; widgets: DashboardWidget[] };
  cards: Record<string, ReactNode>;
  monitors: MonitorOption[];
  canEdit: boolean;
  canShare: boolean;
  startEditing?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(startEditing && canEdit);
  const [widgets, setWidgets] = useState(dashboard.widgets);
  const [name, setName] = useState(dashboard.name);
  const [shared, setShared] = useState(dashboard.shared);
  const [settingsFor, setSettingsFor] = useState<DashboardWidget | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [adding, setAdding] = useState<DashboardWidget["type"] | "">("");
  const [pending, start] = useTransition();
  const grid = useRef<HTMLDivElement>(null);

  const update = (id: string, patch: Partial<DashboardWidget>) => setWidgets((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const move = (from: number, to: number) =>
    setWidgets((ws) => {
      const next = [...ws];
      const [item] = next.splice(from, 1);
      next.splice(clamp(to, 0, next.length), 0, item!);
      return next;
    });

  /** Dragging a card's corner: whole grid columns and rows. */
  function startResize(e: React.PointerEvent, w: DashboardWidget) {
    e.preventDefault();
    const el = grid.current;
    if (!el) return;
    const col = (el.clientWidth - 11 * GAP_PX) / 12 + GAP_PX;
    const [x0, y0, w0, h0] = [e.clientX, e.clientY, w.w, w.h];
    const onMove = (ev: PointerEvent) => update(w.id, { w: clamp(Math.round(w0 + (ev.clientX - x0) / col), 2, 12), h: clamp(Math.round(h0 + (ev.clientY - y0) / (ROW_PX + GAP_PX)), 1, 4) });
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const save = () =>
    start(async () => {
      const res = await saveDashboardAction(dashboard.id, { name, shared, widgets });
      if (res.error) return void toast.error(res.error);
      toast.success("Dashboard saved.");
      setEditing(false);
      router.replace(`/monitoring/dashboards/${dashboard.id}`);
      router.refresh();
    });

  const cancel = () => {
    setWidgets(dashboard.widgets);
    setName(dashboard.name);
    setShared(dashboard.shared);
    setEditing(false);
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {editing ? (
          <>
            <label className="mr-auto flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="h-9 min-w-0 flex-1 border-2 bg-transparent px-2 font-normal" />
            </label>
            {canShare && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="size-4 accent-primary" />
                Shared with everyone
              </label>
            )}
            <span className="flex items-center gap-2">
              <select value={adding} onChange={(e) => setAdding(e.target.value as DashboardWidget["type"])} aria-label="Card to add" className="h-9 border-2 bg-transparent px-2 text-sm">
                <option value="">Add a card…</option>
                {Object.entries(WIDGET_LABELS).map(([t, label]) => (
                  <option key={t} value={t}>
                    {label}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                disabled={!adding}
                onClick={() => {
                  if (!adding) return;
                  const w: DashboardWidget = { id: newId(), type: adding, ...DEFAULT_SIZE[adding], ...(adding === "graph" ? { metric: "latency", range: "24h" } : {}) };
                  setWidgets((ws) => [...ws, w]);
                  setAdding("");
                  if (adding !== "status" && adding !== "incidents") setSettingsFor(w);
                }}
              >
                Add
              </Button>
            </span>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                start(async () => {
                  if (!window.confirm(`Delete the dashboard "${dashboard.name}"?`)) return;
                  const res = await deleteDashboardAction(dashboard.id);
                  if (res?.error) toast.error(res.error);
                })
              }
            >
              Delete
            </Button>
            <Button type="button" variant="outline" onClick={cancel}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={pending || !name.trim()}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </>
        ) : (
          <>
            <Button asChild variant="outline">
              <Link href={`/tv/dashboards/${dashboard.id}`} target="_blank">
                TV mode
              </Link>
            </Button>
            {canEdit && (
              <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </>
        )}
      </div>

      {widgets.length === 0 && (
        <p className="border-2 border-dashed p-8 text-center text-sm text-muted-foreground">{canEdit ? "No cards yet. Edit, then add a card." : "No cards yet."}</p>
      )}
      <div ref={grid} className="grid grid-cols-1 auto-rows-[160px] gap-3 md:grid-cols-12">
        {widgets.map((w, i) => (
          <div
            key={w.id}
            className={cn("relative min-w-0 md:[grid-column:span_var(--w)/span_var(--w)]", editing && "outline-2 outline-offset-2 outline-dashed outline-dim", dragging === w.id && "opacity-50")}
            style={{ "--w": w.w, gridRow: `span ${w.h} / span ${w.h}` } as React.CSSProperties}
            draggable={editing}
            onDragStart={(e) => {
              setDragging(w.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => editing && dragging && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = widgets.findIndex((x) => x.id === dragging);
              if (from !== -1 && from !== i) move(from, i);
              setDragging(null);
            }}
          >
            <div className={cn("h-full", editing && "pointer-events-none")}>{cards[w.id] ?? <NewCard widget={w} />}</div>
            {editing && (
              <>
                <div role="toolbar" aria-label={`${WIDGET_LABELS[w.type]} card ${i + 1}`} className="absolute top-1 right-1 flex flex-wrap justify-end gap-1 bg-card/95 p-1">
                  <Button type="button" size="sm" variant="outline" className={TOOL} disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="Move earlier">
                    ←
                  </Button>
                  <Button type="button" size="sm" variant="outline" className={TOOL} disabled={i === widgets.length - 1} onClick={() => move(i, i + 1)} aria-label="Move later">
                    →
                  </Button>
                  <Button type="button" size="sm" variant="outline" className={TOOL} disabled={w.w <= 2} onClick={() => update(w.id, { w: w.w - 1 })} aria-label="Narrower">
                    −W
                  </Button>
                  <Button type="button" size="sm" variant="outline" className={TOOL} disabled={w.w >= 12} onClick={() => update(w.id, { w: w.w + 1 })} aria-label="Wider">
                    +W
                  </Button>
                  <Button type="button" size="sm" variant="outline" className={TOOL} disabled={w.h <= 1} onClick={() => update(w.id, { h: w.h - 1 })} aria-label="Shorter">
                    −H
                  </Button>
                  <Button type="button" size="sm" variant="outline" className={TOOL} disabled={w.h >= 4} onClick={() => update(w.id, { h: w.h + 1 })} aria-label="Taller">
                    +H
                  </Button>
                  <Button type="button" size="sm" variant="outline" className={TOOL} onClick={() => setSettingsFor(w)} aria-label="Settings">
                    ⚙
                  </Button>
                  <Button type="button" size="sm" variant="outline" className={TOOL} onClick={() => setWidgets((ws) => ws.filter((x) => x.id !== w.id))} aria-label="Remove">
                    ✕
                  </Button>
                </div>
                <span
                  aria-hidden
                  onPointerDown={(e) => startResize(e, w)}
                  className="absolute right-0 bottom-0 hidden size-5 cursor-se-resize border-r-4 border-b-4 border-phosphor md:block"
                  title="Drag to resize"
                />
              </>
            )}
          </div>
        ))}
      </div>

      {settingsFor && (
        <WidgetSettings
          widget={settingsFor}
          monitors={monitors}
          onClose={() => setSettingsFor(null)}
          onSave={(w) => {
            update(w.id, w);
            setSettingsFor(null);
          }}
        />
      )}
    </div>
  );
}

function NewCard({ widget }: { widget: DashboardWidget }) {
  return (
    <section className="flex h-full flex-col items-center justify-center gap-1 border-2 border-dashed p-3 text-center text-sm">
      <span className="font-medium">{widget.title ?? WIDGET_LABELS[widget.type]}</span>
      <span className="text-muted-foreground">Save to see it.</span>
    </section>
  );
}
