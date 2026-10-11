import Link from "next/link";
import { TableHead } from "@/components/ui/table";
import { sortHref, type SearchParams, type SortState } from "@/lib/sort";
import { cn } from "@/lib/utils";

/** A column header that sorts the table by that column (a link, so it works without JavaScript). */
export function SortableHead({
  label,
  sortKey,
  state,
  path,
  sp,
  className,
}: {
  label: string;
  sortKey: string;
  state: SortState;
  path: string;
  sp: SearchParams;
  className?: string;
}) {
  const active = state.key === sortKey;
  return (
    <TableHead aria-sort={active ? (state.dir === "asc" ? "ascending" : "descending") : "none"} className={className}>
      <Link href={sortHref(path, sp, state, sortKey)} className={cn("inline-flex items-center gap-1 hover:underline", active && "text-foreground")} scroll={false}>
        {label}
        <span aria-hidden className={cn("font-mono text-[10px]", active ? "text-phosphor" : "text-dim")}>
          {active ? (state.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
        <span className="sr-only">{active ? `, sorted ${state.dir === "asc" ? "ascending" : "descending"}` : ", sort"}</span>
      </Link>
    </TableHead>
  );
}
