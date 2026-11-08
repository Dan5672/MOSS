// Holidays the Basement decorates for: from 5 days before until the day itself (Oktoberfest: until it ends).
// Dates are local to the server, which runs in the org's time zone (Settings).

export const HOLIDAYS = ["australia_day", "valentines", "st_patricks", "easter", "star_wars", "oktoberfest", "halloween", "christmas"] as const;
export type Holiday = (typeof HOLIDAYS)[number];

const LEAD_DAYS = 5;
const DAY = 86_400_000;

/** Easter Sunday (Gregorian, the anonymous algorithm), as [month 0-11, day]. */
export function easterSunday(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return [month - 1, ((h + l - 7 * m + 114) % 31) + 1];
}

/** Munich's Oktoberfest: from the Saturday after 15 September to the first Sunday of October, or 3 October if later. */
function oktoberfest(year: number): [Date, Date] {
  const sep15 = new Date(year, 8, 15);
  const start = new Date(year, 8, 15 + (((6 - sep15.getDay() + 7) % 7) || 7));
  const oct1 = new Date(year, 9, 1);
  const firstSunday = new Date(year, 9, 1 + ((7 - oct1.getDay()) % 7));
  return [start, firstSunday.getDate() < 3 ? new Date(year, 9, 3) : firstSunday];
}

/** Each holiday's first and last day in a year. */
function spans(year: number): [Holiday, Date, Date][] {
  const one = (h: Holiday, month: number, day: number): [Holiday, Date, Date] => [h, new Date(year, month, day), new Date(year, month, day)];
  const [em, ed] = easterSunday(year);
  return [
    one("australia_day", 0, 26),
    one("valentines", 1, 14),
    one("st_patricks", 2, 17),
    one("easter", em, ed),
    one("star_wars", 4, 4),
    ["oktoberfest", ...oktoberfest(year)],
    one("halloween", 9, 31),
    one("christmas", 11, 25),
  ];
}

/** The holiday being decorated for on this date, if any. Where two overlap, the sooner one wins. */
export function holidayOn(now: Date): Holiday | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let best: { h: Holiday; until: number } | null = null;
  for (const [h, start, end] of spans(today.getFullYear())) {
    const until = Math.round((start.getTime() - today.getTime()) / DAY);
    if (until > LEAD_DAYS || today > end) continue;
    if (!best || Math.max(until, 0) < best.until) best = { h, until: Math.max(until, 0) };
  }
  return best?.h ?? null;
}
