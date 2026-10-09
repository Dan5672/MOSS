import { Breadcrumbs, type Crumb } from "./breadcrumbs";
import type { ReactNode } from "react";

export function PageHeader({ title, description, actions, trail }: { title: string; description?: ReactNode; actions?: ReactNode; trail?: Crumb[] }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <Breadcrumbs title={title} trail={trail} />
        <h1 className="font-pixel text-[22px] leading-snug font-normal break-words text-ink dark:text-beige">{title}</h1>
        {description && <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="border-2 border-dashed p-8 text-center font-mono text-sm text-muted-foreground">{children}</div>;
}

export function NoPermission() {
  return <Empty>You don&apos;t have permission to view this page.</Empty>;
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink dark:text-beige">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const seconds = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

export function formatUsd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
