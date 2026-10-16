// Lays out monitor dependencies as trees, left to right: what everything depends on in the first column, its
// dependents in the next. Each leaf gets a row of its own; a parent sits level with the middle of its children.

export interface MapNode {
  id: string;
  parentId: string | null;
  name: string;
}

export interface PlacedNode<T extends MapNode> {
  node: T;
  depth: number;
  row: number;
}

/**
 * Places every monitor that is part of a dependency (has a parent or a dependent). Monitors on their own are left
 * out. A parent that isn't in the list, or a loop, starts a new tree rather than hiding monitors.
 */
export function layoutDependencies<T extends MapNode>(nodes: T[]): { placed: PlacedNode<T>[]; rows: number; depth: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, T[]>();
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
  }
  const placed: PlacedNode<T>[] = [];
  const done = new Set<string>();
  let nextRow = 0;
  let maxDepth = 0;

  const place = (n: T, depth: number): number => {
    done.add(n.id);
    maxDepth = Math.max(maxDepth, depth);
    const kids = (children.get(n.id) ?? []).filter((c) => !done.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
    let row: number;
    if (!kids.length) row = nextRow++;
    else {
      const rows = kids.map((c) => place(c, depth + 1));
      row = (rows[0]! + rows[rows.length - 1]!) / 2;
    }
    placed.push({ node: n, depth, row });
    return row;
  };

  const inTree = (n: T) => (n.parentId && byId.has(n.parentId)) || children.has(n.id);
  const roots = nodes.filter((n) => inTree(n) && !(n.parentId && byId.has(n.parentId))).sort((a, b) => a.name.localeCompare(b.name));
  for (const r of roots) place(r, 0);
  // Whatever is left is in a loop (a bad edit the checks should have stopped): show it from any member.
  for (const n of nodes) if (inTree(n) && !done.has(n.id)) place(n, 0);
  return { placed, rows: nextRow, depth: maxDepth };
}
