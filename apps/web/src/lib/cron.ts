// When a recurring task's cron expression fires, for calendars. Five fields (minute hour day month weekday),
// with *, numbers, ranges, lists and steps, in local time like the worker that runs them.

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

/** When a cron expression fires between two times (local time, like the worker), at most `limit` times. */
export function cronOccurrences(cron: string, start: Date, end: Date, limit = 200): Date[] {
  const [mi, ho, dom, mon, dow] = cron.trim().split(/\s+/);
  if (!mi || !ho || !dom || !mon || !dow) return [];
  const out: Date[] = [];
  const t = new Date(start);
  t.setSeconds(0, 0);
  for (let day = 0; day < 400 && t < end && out.length < limit; day++) {
    const dayOk =
      fieldMatches(mon, t.getMonth() + 1, 1) &&
      (dom === "*" || dow === "*" ? fieldMatches(dom, t.getDate(), 1) && fieldMatches(dow, t.getDay(), 0) : fieldMatches(dom, t.getDate(), 1) || fieldMatches(dow, t.getDay(), 0));
    if (dayOk) {
      for (let h = 0; h < 24; h++) {
        if (!fieldMatches(ho, h, 0)) continue;
        for (let m = 0; m < 60; m++) {
          if (!fieldMatches(mi, m, 0)) continue;
          const at = new Date(t.getFullYear(), t.getMonth(), t.getDate(), h, m);
          if (at >= start && at < end) out.push(at);
          if (out.length >= limit) return out;
        }
      }
    }
    t.setDate(t.getDate() + 1);
    t.setHours(0, 0, 0, 0);
  }
  return out;
}
