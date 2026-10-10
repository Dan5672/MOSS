import Link from "next/link";
import { formatUsd, Section } from "@/components/page";
import type { tokenSpend } from "@/server/queries";

type Spend = Awaited<ReturnType<typeof tokenSpend>>;

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(Math.round(n)));

/** Token use and cost: today and this month, a 30-day chart, and this month by agent and by model. */
export function TokenSpendCard({ t, cap }: { t: Spend; cap: number | null }) {
  const max = Math.max(...t.days.map((d) => d.usd), 0.000001);
  const barW = 100 / t.days.length;
  const top = (list: Spend["byAgent"]) => list.slice(0, 5);
  return (
    <Section
      title="Token spend"
      actions={
        <Link href="/agents" className="text-sm underline">
          Budgets
        </Link>
      }
    >
      <div className="px-frame grid gap-4 bg-card p-4 text-sm">
        <dl className="grid grid-cols-2 gap-3">
          {(
            [
              ["Today", t.today],
              ["This month", t.month],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="grid gap-0.5">
              <dt className="font-mono text-[11px] tracking-wider text-dim uppercase">{label}</dt>
              <dd className="font-mono text-2xl tabular-nums">{formatUsd(v.usd)}</dd>
              <dd className="font-mono text-xs text-muted-foreground">
                {tokens(v.input)} in · {tokens(v.output)} out
              </dd>
            </div>
          ))}
        </dl>
        {cap !== null && (
          <p className="text-xs text-muted-foreground">
            {Math.round((100 * t.month.usd) / cap)}% of the {formatUsd(cap)} monthly cap.
          </p>
        )}
        {t.days.every((d) => d.usd === 0) ? (
          <p className="text-xs text-muted-foreground">No spend in the last 30 days.</p>
        ) : (
          <figure className="grid gap-1">
            <svg
              viewBox="0 0 100 30"
              preserveAspectRatio="none"
              role="img"
              aria-label={`Cost per day for the last 30 days, up to ${formatUsd(max)} a day`}
              className="h-16 w-full"
            >
              {t.days.map((d, i) => {
                const h = (d.usd / max) * 28;
                return (
                  <rect
                    key={d.day}
                    x={i * barW + barW * 0.15}
                    y={30 - Math.max(h, d.usd > 0 ? 0.6 : 0)}
                    width={barW * 0.7}
                    height={Math.max(h, d.usd > 0 ? 0.6 : 0)}
                    className="fill-phosphor"
                  >
                    <title>{`${d.day}: ${formatUsd(d.usd)}, ${tokens(d.tokens)} tokens`}</title>
                  </rect>
                );
              })}
            </svg>
            <figcaption className="flex justify-between font-mono text-[11px] text-dim">
              <span>30 days ago</span>
              <span>today</span>
            </figcaption>
          </figure>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ["By agent", top(t.byAgent)],
              ["By model", top(t.byModel)],
            ] as const
          ).map(([label, rows]) => (
            <div key={label} className="grid gap-1">
              <span className="font-mono text-[11px] tracking-wider text-dim uppercase">{label} · this month</span>
              {rows.length === 0 ? (
                <span className="text-xs text-muted-foreground">Nothing yet.</span>
              ) : (
                <ul className="grid gap-1" aria-label={`Spend ${label.toLowerCase()}`}>
                  {rows.map((r) => (
                    <li key={r.name} className="flex justify-between gap-2">
                      <span className="truncate">{r.name}</span>
                      <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">
                        {formatUsd(r.usd)} · {tokens(r.tokens)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
