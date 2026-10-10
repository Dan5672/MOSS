// Is there a newer MOSS? The running version is what deploy/upgrade.sh built (git describe: v0.2.0, or
// v0.2.0-14-gabc1234 for a build 14 commits after it); releases are the repository's vX.Y.Z tags.

export const MOSS_REPOSITORY = "https://github.com/Dan5672/MOSS";

interface Parsed {
  parts: [number, number, number];
  /** Commits after the tag (a development build), 0 for the release itself. */
  ahead: number;
}

export function parseMossVersion(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+)-g[0-9a-f]+)?(?:-dirty)?$/.exec(v.trim());
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], ahead: Number(m[4] ?? 0) } : null;
}

const cmp = (a: Parsed["parts"], b: Parsed["parts"]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The newest release among the tags (only plain vX.Y.Z; pre-releases are left out). */
export function newestRelease(tags: string[]): string | null {
  let best: { tag: string; parts: Parsed["parts"] } | null = null;
  for (const tag of tags) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue;
    const p = parseMossVersion(tag)!;
    if (!best || cmp(p.parts, best.parts) > 0) best = { tag, parts: p.parts };
  }
  return best?.tag ?? null;
}

export interface ReleaseCheck {
  running: string;
  latest: string | null;
  /** update: a newer release is out; current: on the newest; ahead: a development build past it; unknown: can't tell. */
  status: "update" | "current" | "ahead" | "unknown";
  /** Where to read about the newest release. */
  url: string | null;
}

export function compareRelease(running: string, tags: string[]): ReleaseCheck {
  const latest = newestRelease(tags);
  const url = latest ? `${MOSS_REPOSITORY}/releases/tag/${latest}` : null;
  const r = parseMossVersion(running);
  const l = latest ? parseMossVersion(latest) : null;
  if (!r || !l) return { running, latest, status: "unknown", url };
  const c = cmp(l.parts, r.parts);
  const status = c > 0 ? "update" : c === 0 && r.ahead === 0 ? "current" : "ahead";
  return { running, latest, status, url };
}
