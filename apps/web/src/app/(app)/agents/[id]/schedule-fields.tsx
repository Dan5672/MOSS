"use client";

import { useState } from "react";
import { SelectField, TextAreaField, TextField } from "@/components/field";
import { clockTime, describeCron, fromCron, HOUR_STEPS, REPEAT_OPTIONS, repeatFromForm, toCron, WEEKDAYS, type RepeatKind } from "@/lib/schedule";

/**
 * Fields for one agent schedule: how often it repeats (only the inputs that repeat needs) and the task.
 * Submits plain form fields; the server turns them into cron with the same helpers.
 */
export function ScheduleFields({ cron = "0 9 * * *", task = "" }: { cron?: string; task?: string }) {
  const initial = fromCron(cron);
  const [kind, setKind] = useState<RepeatKind>(initial.kind);
  const [minute, setMinute] = useState(String("minute" in initial ? initial.minute : 0));
  const [hours, setHours] = useState(String(initial.kind === "every_hours" ? initial.hours : 4));
  const [time, setTime] = useState("hour" in initial ? clockTime(initial.hour, initial.minute) : "09:00");
  const [days, setDays] = useState<number[]>(initial.kind === "weekly" ? initial.days : [1]);
  const [day, setDay] = useState(String(initial.kind === "monthly" ? initial.day : 1));
  const [custom, setCustom] = useState(initial.kind === "custom" ? initial.cron : cron);

  const values: Record<string, string> = { repeat: kind, minute, hours, time, days: days.join(","), day, cron: custom };
  let preview: string;
  try {
    preview = describeCron(toCron(repeatFromForm((name) => values[name])));
  } catch (err) {
    preview = (err as Error).message;
  }

  return (
    <div className="grid gap-3">
      <SelectField label="Repeats" name="repeat" value={kind} onChange={(e) => setKind(e.target.value as RepeatKind)} options={REPEAT_OPTIONS} />

      {(kind === "hourly" || kind === "every_hours") && (
        <div className="grid grid-cols-2 gap-2">
          {kind === "every_hours" && (
            <SelectField
              label="Every"
              name="hours"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              options={HOUR_STEPS.map((h) => ({ value: String(h), label: `${h} hours` }))}
            />
          )}
          <TextField label="Minutes past the hour" name="minute" type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(e.target.value)} />
        </div>
      )}

      {kind === "weekly" && (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">On</legend>
          <input type="hidden" name="days" value={days.join(",")} />
          <div className="flex flex-wrap gap-1">
            {/* Monday first, as people read a week. */}
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <label key={d} className="flex min-h-11 cursor-pointer items-center gap-1.5 border-2 px-2 font-mono text-xs has-checked:border-phosphor has-checked:text-phosphor">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={days.includes(d)}
                  onChange={(e) => setDays((cur) => (e.target.checked ? [...cur, d] : cur.filter((x) => x !== d)))}
                />
                {WEEKDAYS[d]!.slice(0, 3)}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {kind === "monthly" && (
        <TextField label="Day of the month" name="day" type="number" min={1} max={28} value={day} onChange={(e) => setDay(e.target.value)} hint="1–28, so it runs every month." />
      )}

      {(kind === "daily" || kind === "weekdays" || kind === "weekly" || kind === "monthly") && (
        <TextField label="At" name="time" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
      )}

      {kind === "custom" && (
        <TextField
          label="Cron expression"
          name="cron"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className="font-mono"
          hint="minute hour day-of-month month day-of-week, e.g. */30 9-17 * * 1-5"
        />
      )}

      <p className="font-mono text-xs text-dim" aria-live="polite">
        Runs: {preview}
      </p>

      <TextAreaField label="Task" name="task" rows={3} maxLength={2000} defaultValue={task} required placeholder="What the agent should do each time." />
    </div>
  );
}
