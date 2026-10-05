import type { ComponentProps, ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** The control is nested inside its <label>, so it is labelled for screen readers without ids. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <label className="grid content-start gap-1.5 text-sm font-medium leading-none">
        <span>{label}</span>
        {children}
      </label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function TextField({ label, hint, ...props }: { label: string; hint?: ReactNode } & ComponentProps<typeof Input>) {
  return (
    <Field label={label} hint={hint}>
      <Input {...props} className="font-normal" />
    </Field>
  );
}

export function TextAreaField({ label, hint, ...props }: { label: string; hint?: ReactNode } & ComponentProps<typeof Textarea>) {
  return (
    <Field label={label} hint={hint}>
      <Textarea {...props} className="font-normal" />
    </Field>
  );
}

export function CheckboxField({ label, hint, ...props }: { label: string; hint?: ReactNode } & ComponentProps<"input">) {
  return (
    <div className="grid gap-1">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" {...props} className="size-4 accent-primary" />
        <span>{label}</span>
      </label>
      {hint && <p className="pl-6 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Native select: works inside server-action forms without client state. */
export function SelectField({
  label,
  hint,
  options,
  ...props
}: { label: string; hint?: ReactNode; options: { value: string; label: string }[] } & ComponentProps<"select">) {
  return (
    <Field label={label} hint={hint}>
      <select
        {...props}
        className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm font-normal shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
