"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const ROW = 4;

/**
 * A grid whose items keep their own height instead of stretching to the tallest in their row, so a short card
 * doesn't leave a gap under it. Each item spans as many 4px rows as it is tall, measured in the browser; until
 * then (and without JavaScript) it is an ordinary grid. Items keep their reading order, left to right.
 */
export function Masonry({ children, className, gap }: { children: ReactNode; className?: string; gap: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const items = [...grid.children] as HTMLElement[];
    // Items are aligned to the top, so their height is their content's, whatever rows they span.
    const fit = () => {
      for (const item of items) item.style.gridRowEnd = `span ${Math.ceil((item.getBoundingClientRect().height + gap) / ROW)}`;
      setReady(true);
    };
    const observer = new ResizeObserver(fit);
    for (const item of items) observer.observe(item);
    return () => observer.disconnect();
  }, [children, gap]);

  const style: CSSProperties = ready ? { gridAutoRows: `${ROW}px`, columnGap: gap, rowGap: 0 } : { gap };
  return (
    <div ref={ref} className={cn("grid items-start", className)} style={style}>
      {children}
    </div>
  );
}
