// Agent schedules are stored as 5-field cron (minute hour day-of-month month day-of-week), which is
// what the worker hands to the queue. People pick a repeat from a short list instead; this module
// converts between the two and describes any cron in words. Pure, so the form and server share it.

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export type Repeat =
  | { kind: "hourly"; minute: number }
  | { kind: "every_hours"; hours: number; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; days: number[]; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number }
  | { kind: "custom"; cron: string };

export type RepeatKind = Repeat["kind"];

export const REPEAT_OPTIONS: { value: RepeatKind; label: string }[] = [
  { value: "hourly", label: "Every hour" },
  { value: "every_hours", label: "Every few hours" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday (Mon–Fri)" },
  { value: "weekly", label: "On chosen days of the week" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom (cron)" },
];

/** Hour intervals that divide the day evenly, so "every N hours" fires at the same times each day. */
export const HOUR_STEPS = [2, 3, 4, 6, 8, 12] as const;

const FIELD_RANGES: [min: number, max: number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are Sunday)
];

/** Why a cron expression is unusable, or null if it's fine. Every-minute schedules are refused. */
export function cronProblem(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return "Use five fields: minute, hour, day of month, month, day of week.";
  for (const [i, field] of fields.entries()) {
    const [min, max] = FIELD_RANGES[i]!;
    for (const part of field.split(",")) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
      if (!m) return `"${part}" isn't a valid cron value.`;
      const [, , from, to, step] = m;
      if (step !== undefined && Number(step) < 1) return "A step must be 1 or more.";
      for (const n of [from, to].filter((n) => n !== undefined).map(Number)) {
        if (n < min || n > max) return `${n} is out of range (${min}–${max}).`;
      }
      if (from !== undefined && to !== undefined && Number(from) > Number(to)) return `"${part}" runs backwards.`;
    }
  }
  // Agent runs cost money and take minutes; once a minute is never what anyone means.
  if (fields[0] === "*" || /^\*\/[1-4]$/.test(fields[0]!)) return "That would run more than every 5 minutes. Pick a less frequent schedule.";
  return null;
}

export function toCron(r: Repeat): string {
  switch (r.kind) {
    case "hourly":
      return `${r.minute} * * * *`;
    case "every_hours":
      return `${r.minute} */${r.hours} * * *`;
    case "daily":
      return `${r.minute} ${r.hour} * * *`;
    case "weekdays":
      return `${r.minute} ${r.hour} * * 1-5`;
    case "weekly":
      return `${r.minute} ${r.hour} * * ${[...new Set(r.days)].sort((a, b) => a - b).join(",")}`;
    case "monthly":
      return `${r.minute} ${r.hour} ${r.day} * *`;
    case "custom":
      return r.cron.trim().split(/\s+/).join(" ");
  }
}

const num = (s: string, min: number, max: number) => (/^\d+$/.test(s) && Number(s) >= min && Number(s) <= max ? Number(s) : null);

/** Reads a cron back into one of the simple repeats; anything else is "custom". */
export function fromCron(cron: string): Repeat {
  const custom: Repeat = { kind: "custom", cron };
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return custom;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  const minute = num(mi, 0, 59);
  if (minute === null || mon !== "*") return custom;
  if (h === "*" && dom === "*" && dow === "*") return { kind: "hourly", minute };
  const step = /^\*\/(\d+)$/.exec(h);
  if (step && dom === "*" && dow === "*" && (HOUR_STEPS as readonly number[]).includes(Number(step[1]))) {
    return { kind: "every_hours", hours: Number(step[1]), minute };
  }
  const hour = num(h, 0, 23);
  if (hour === null) return custom;
  if (dom === "*" && dow === "*") return { kind: "daily", hour, minute };
  if (dom === "*" && dow === "1-5") return { kind: "weekdays", hour, minute };
  if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
    return { kind: "weekly", days: [...new Set(dow.split(",").map((d) => Number(d) % 7))].sort((a, b) => a - b), hour, minute };
  }
  // Days 29–31 are skipped in short months, so those stay "custom" rather than claiming "every month".
  const day = num(dom, 1, 28);
  if (day !== null && dow === "*") return { kind: "monthly", day, hour, minute };
  return custom;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clockTime = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;

function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

function listDays(days: number[]) {
  const names = days.map((d) => WEEKDAYS[d]!);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A schedule in words, e.g. "Every hour, on the hour" or "Sundays at 03:00". */
export function describeCron(cron: string): string {
  const r = fromCron(cron);
  switch (r.kind) {
    case "hourly":
      return r.minute === 0 ? "Every hour, on the hour" : `Every hour at ${pad(r.minute)} past`;
    case "every_hours":
      return `Every ${r.hours} hours, at ${pad(r.minute)} past`;
    case "daily":
      return `Every day at ${clockTime(r.hour, r.minute)}`;
    case "weekdays":
      return `Weekdays at ${clockTime(r.hour, r.minute)}`;
    case "weekly":
      return r.days.length === 7 ? `Every day at ${clockTime(r.hour, r.minute)}` : `${listDays(r.days).replace(/day\b/g, "days")} at ${clockTime(r.hour, r.minute)}`;
    case "monthly":
      return `Monthly on the ${ordinal(r.day)} at ${clockTime(r.hour, r.minute)}`;
    case "custom":
      return `Custom schedule (${r.cron})`;
  }
}

/** Builds a Repeat from submitted form fields; throws a readable error when they don't add up. */
export function repeatFromForm(get: (name: string) => string | undefined): Repeat {
  const kind = get("repeat") as RepeatKind | undefined;
  const time = (get("time") ?? "").match(/^(\d{1,2}):(\d{2})$/);
  const hour = time ? num(time[1]!, 0, 23) : null;
  const minuteOfTime = time ? num(time[2]!, 0, 59) : null;
  const minute = num(get("minute") ?? "", 0, 59);
  const needTime = () => {
    if (hour === null || minuteOfTime === null) throw new Error("Choose a time.");
    return { hour, minute: minuteOfTime };
  };
  const needMinute = () => {
    if (minute === null) throw new Error("Choose the minute past the hour (0–59).");
    return minute;
  };
  switch (kind) {
    case "hourly":
      return { kind, minute: needMinute() };
    case "every_hours": {
      const hours = Number(get("hours"));
      if (!(HOUR_STEPS as readonly number[]).includes(hours)) throw new Error("Choose how many hours between runs.");
      return { kind, hours, minute: needMinute() };
    }
    case "daily":
    case "weekdays":
      return { kind, ...needTime() };
    case "weekly": {
      const days = (get("days") ?? "").split(",").filter(Boolean).map(Number).filter((d) => d >= 0 && d <= 6);
      if (!days.length) throw new Error("Choose at least one day.");
      return { kind, days, ...needTime() };
    }
    case "monthly": {
      const day = num(get("day") ?? "", 1, 28);
      if (day === null) throw new Error("Choose a day of the month (1–28, so it runs every month).");
      return { kind, day, ...needTime() };
    }
    case "custom": {
      const cron = (get("cron") ?? "").trim();
      const problem = cronProblem(cron);
      if (problem) throw new Error(problem);
      return { kind, cron };
    }
    default:
      throw new Error("Choose how often it repeats.");
  }
}
