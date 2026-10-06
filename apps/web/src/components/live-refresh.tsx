"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the page on an interval while the tab is visible. Renders nothing. */
export function LiveRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(tick, everyMs);
    // Catch up straight away when the tab comes back.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, everyMs]);
  return null;
}
