// When a recurring task's cron expression fires, for calendars. Five fields (minute hour day month weekday),
// with *, numbers, ranges, lists and steps, in the install's time zone like the worker that runs them.

/** Does one cron field (like *, 5, 1-5, a step such as every 15, or a list 1,3) match a value? */
function fieldMatches(field: string, value: number, min: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [min, 59];
    else if (range!.includes("-")) [lo, hi] = range!.split("-").map(Number) as [number, number];
    else [lo, hi] = [Number(range), stepText ? 59 : Number(range)];
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** A moment's wall-clock date and time in a time zone. */
function wallClock(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(d);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: n("year"), mo: n("month"), d: n("day"), h: n("hour"), mi: n("minute") };
}

/** The moment a wall-clock time happens in a time zone. */
function inZone(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const w = wallClock(new Date(guess), timeZone);
  return new Date(guess - (Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - guess));
}

/** When a cron expression fires between two times, in a time zone (the worker's, by default), at most `limit` times. */
export function cronOccurrences(cron: string, start: Date, end: Date, limit = 200, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Date[] {
  const [mi, ho, dom, mon, dow] = cron.trim().split(/\s+/);
  if (!mi || !ho || !dom || !mon || !dow) return [];
  const out: Date[] = [];
  // Walk calendar days in the zone; a UTC date is used only as a day counter.
  const first = wallClock(start, timeZone);
  const day = new Date(Date.UTC(first.y, first.mo - 1, first.d));
  for (let n = 0; n < 400 && out.length < limit; n++, day.setUTCDate(day.getUTCDate() + 1)) {
    const [y, mo, d, wd] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCDay()];
    if (inZone(y, mo, d, 0, 0, timeZone) >= end) break;
    const dayOk = fieldMatches(mon, mo, 1) && (dom === "*" || dow === "*" ? fieldMatches(dom, d, 1) && fieldMatches(dow, wd, 0) : fieldMatches(dom, d, 1) || fieldMatches(dow, wd, 0));
    if (!dayOk) continue;
    for (let h = 0; h < 24; h++) {
      if (!fieldMatches(ho, h, 0)) continue;
      for (let m = 0; m < 60; m++) {
        if (!fieldMatches(mi, m, 0)) continue;
        const at = inZone(y, mo, d, h, m, timeZone);
        if (at >= start && at < end) out.push(at);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
