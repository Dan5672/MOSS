// Table sorting from the URL (?sort=<column>&dir=asc|desc), so a sorted view can be linked and survives a
// reload. Only columns a page names are accepted. Rows are sorted on the server before rendering.

export type SortDir = "asc" | "desc";
export interface SortState<K extends string = string> {
  key: K | null;
  dir: SortDir;
}
export type SearchParams = Record<string, string | string[] | undefined>;
type Value = string | number | boolean | Date | null | undefined;

export function readSort<K extends string>(sp: SearchParams, keys: readonly K[]): SortState<K> {
  const key = typeof sp.sort === "string" && (keys as readonly string[]).includes(sp.sort) ? (sp.sort as K) : null;
  return { key, dir: sp.dir === "desc" ? "desc" : "asc" };
}

/** An IPv4 address as a number, so 10.0.0.9 sorts before 10.0.0.10. Anything else sorts as text. */
export function ipKey(ip: string | null | undefined): Value {
  if (!ip) return null;
  const parts = ip.split("/")[0]!.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return ip;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

function compare(a: Value, b: Value): number {
  const na = a === null || a === undefined || a === "";
  const nb = b === null || b === undefined || b === "";
  if (na || nb) return na === nb ? 0 : na ? 1 : -1; // empty values last, either direction
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (typeof x === "number" && typeof y === "number") return x - y;
  if (typeof x === "boolean" && typeof y === "boolean") return Number(y) - Number(x);
  return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
}

/** A sorted copy. Ties keep their original order; empty values always go last. */
export function sortRows<T, K extends string>(rows: readonly T[], state: SortState<K>, by: Record<K, (row: T) => Value>): T[] {
  if (!state.key) return [...rows];
  const get = by[state.key];
  const sign = state.dir === "desc" ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((p, q) => {
      const empty = (v: Value) => v === null || v === undefined || v === "";
      if (empty(p.v) || empty(q.v)) return compare(p.v, q.v) || p.i - q.i;
      return sign * compare(p.v, q.v) || p.i - q.i;
    })
    .map((x) => x.row);
}

/** The link for a column header: ascending first, then descending, keeping the page's other parameters. */
export function sortHref(path: string, sp: SearchParams, state: SortState, key: string): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "sort" || k === "dir" || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) params.append(k, one);
  }
  params.set("sort", key);
  params.set("dir", state.key === key && state.dir === "asc" ? "desc" : "asc");
  return `${path}?${params}`;
}
