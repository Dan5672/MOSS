"use client";

import { formatMetric } from "@moss/core/metrics";
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Point } from "./widgets";

/** Colours for up to eight lines; the theme's signal colours first. */
const PALETTE = ["--phosphor", "--signal", "--amber", "--alarm", "#9b7bd8", "#2bb3a3", "#d6609b", "#7a8c3c"];

function cssColour(token: string, el: HTMLElement) {
  return token.startsWith("--") ? getComputedStyle(el).getPropertyValue(token).trim() || "#888" : token;
}

/**
 * Lines for one metric across monitors (uPlot: small and fast). Monitors are checked at different moments, so
 * their times are merged and gaps bridged. Hovering shows each value in the legend.
 */
export function TimeSeriesChart({ series, unit, from, to }: { series: { name: string; points: Point[] }[]; unit: string; from: number; to: number }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
    const index = new Map(times.map((t, i) => [t, i]));
    const columns = series.map((s) => {
      const col: (number | null)[] = new Array(times.length).fill(null);
      for (const p of s.points) col[index.get(p.t)!] = p.avg;
      return col;
    });
    const axis = cssColour("--muted-foreground", el);
    const grid = cssColour("--border", el);
    const fmt = (v: number | null) => (v === null ? "—" : unit === "up" ? `${Math.round(v * 100)}%` : formatMetric(v, unit));
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: Math.max(80, el.clientHeight - 36),
      scales: { x: { time: true, range: [from / 1000, to / 1000] } },
      axes: [
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 64, values: (_u, vals) => vals.map((v) => fmt(v)) },
      ],
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.name,
          stroke: cssColour(PALETTE[i % PALETTE.length]!, el),
          width: 1.5,
          spanGaps: true,
          points: { show: false },
          value: (_u: uPlot, v: number | null) => fmt(v),
        })),
      ],
      legend: { live: true },
      cursor: { drag: { x: false, y: false } },
    };
    const plot = new uPlot(opts, [times.map((t) => t / 1000), ...columns] as uPlot.AlignedData, el);
    const resize = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: Math.max(80, el.clientHeight - 36) }));
    resize.observe(el);
    return () => {
      resize.disconnect();
      plot.destroy();
    };
  }, [series, unit, from, to]);

  if (!series.some((s) => s.points.length)) {
    return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">No data in this range yet.</p>;
  }
  return <div ref={box} className="moss-chart h-full w-full min-w-0 overflow-hidden text-xs" />;
}
