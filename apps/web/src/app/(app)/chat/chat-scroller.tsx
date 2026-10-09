"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * The message history: scrolls on its own so the message box stays at the bottom of the screen. Opens
 * at the newest message, and follows new ones as they arrive unless you've scrolled up to read.
 */
export function ChatScroller({ count, children }: { count: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto pr-2"
    >
      {children}
    </div>
  );
}
