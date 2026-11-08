"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { formatTokens, formatUsd } from "@/components/page";

type Unit = "usd" | "tokens";
const KEY = "moss.dashboard.spend-unit";

/**
 * The dashboard's spend tile, in dollars or tokens. A subscription (Claude Pro/Max) costs nothing per token, so
 * its spend is always $0: tokens are the default then, and the choice is remembered in this browser.
 */
export function SpendStat({ usd, tokens, bar }: { usd: { today: number; month: number }; tokens: { today: number; month: number }; bar?: ReactNode }) {
  const [unit, setUnit] = useState<Unit>(usd.month === 0 && tokens.month > 0 ? "tokens" : "usd");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "usd" || saved === "tokens") setUnit(saved);
    } catch {}
  }, []);
  const choose = (u: Unit) => {
    setUnit(u);
    try {
      localStorage.setItem(KEY, u);
    } catch {}
  };
  const show = unit === "usd" ? (n: number) => formatUsd(n) : formatTokens;
  const v = unit === "usd" ? usd : tokens;

  return (
    <div className="relative h-full">
      <Link href="/agents" className="px-frame grid h-full content-start gap-2 bg-card p-4 transition-colors hover:bg-accent">
        <span className="font-mono text-[11px] tracking-wider text-dim uppercase">{unit === "usd" ? "Spend this month" : "Tokens this month"}</span>
        <span className="font-mono text-[34px] leading-none tabular-nums text-foreground">{show(v.month)}</span>
        <span className="text-[13px] text-muted-foreground">{show(v.today)} today</span>
        {unit === "usd" && bar}
      </Link>
      <div role="group" aria-label="Show spend as" className="absolute top-3 right-3 flex font-mono text-[11px]">
        {(
          [
            ["usd", "$"],
            ["tokens", "Tokens"],
          ] as const
        ).map(([u, label]) => (
          <button
            key={u}
            type="button"
            aria-pressed={unit === u}
            onClick={() => choose(u)}
            className="border px-1.5 py-0.5 text-dim aria-pressed:bg-foreground aria-pressed:text-background"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
