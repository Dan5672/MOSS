"use client";

import { useEffect, useState } from "react";

/** The time, so a wall screen shows it's live (and when it last refreshed if it isn't). */
export function TvClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <time className="tabular-nums">{now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</time>;
}
