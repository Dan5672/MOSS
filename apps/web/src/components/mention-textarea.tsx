"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface MentionOption {
  name: string;
  /** "agent" or "person", shown next to the name. */
  kind: string;
}

/** The "@word" being typed just before the cursor, if any. */
function activeQuery(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at === -1 || (at > 0 && /[\w.]/.test(before[at - 1]!))) return null;
  const query = before.slice(at + 1);
  if (query.length > 30 || /[\n@]/.test(query) || /\s\s/.test(query)) return null;
  return { start: at, query };
}

/**
 * A textarea that suggests agents and people after "@". Up/Down choose, Enter or Tab inserts, Escape
 * closes. The server works out mentions from the text itself, so typing a name by hand works too.
 */
export function MentionTextarea({ name, label, options, rows = 3, required }: { name: string; label: string; options: MentionOption[]; rows?: number; required?: boolean }) {
  const id = useId();
  const listId = `${id}-mentions`;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);

  // The form resets after a successful post; follow it, since the value lives in state here.
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const clear = () => setValue("");
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, []);

  const q = activeQuery(value, cursor);
  const matches = q && !closed ? options.filter((o) => o.name.toLowerCase().startsWith(q.query.toLowerCase())).slice(0, 6) : [];
  const open = matches.length > 0 && !(matches.length === 1 && matches[0]!.name.toLowerCase() === q!.query.toLowerCase());

  const insert = (o: MentionOption) => {
    if (!q) return;
    const next = `${value.slice(0, q.start)}@${o.name} ${value.slice(cursor)}`;
    const pos = q.start + o.name.length + 2;
    setValue(next);
    setCursor(pos);
    setActive(0);
    requestAnimationFrame(() => ref.current?.setSelectionRange(pos, pos));
  };

  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <textarea
          ref={ref}
          id={id}
          name={name}
          rows={rows}
          required={required}
          value={value}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
          onChange={(e) => {
            setValue(e.target.value);
            setCursor(e.target.selectionStart);
            setClosed(false);
            setActive(0);
          }}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === "ArrowDown") setActive((a) => (a + 1) % matches.length);
            else if (e.key === "ArrowUp") setActive((a) => (a - 1 + matches.length) % matches.length);
            else if (e.key === "Enter" || e.key === "Tab") insert(matches[active]!);
            else if (e.key === "Escape") setClosed(true);
            else return;
            e.preventDefault();
          }}
        />
        {open && (
          <ul id={listId} role="listbox" aria-label="Mention someone" className="absolute left-2 z-20 mt-1 grid min-w-48 border-2 bg-card py-1 shadow-md">
            {matches.map((o, i) => (
              <li
                key={`${o.kind}-${o.name}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={cn("flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-sm", i === active && "bg-accent")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insert(o);
                }}
              >
                <span>@{o.name}</span>
                <span className="font-mono text-xs text-dim">{o.kind}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Type @ to mention an agent or a person. Agents you mention are asked to reply.</p>
    </div>
  );
}

/** Comment text with @mentions of known names emphasised. Text only: never rendered as HTML. */
export function CommentText({ text, names }: { text: string; names: string[] }) {
  const sorted = [...names].filter(Boolean).sort((a, b) => b.length - a.length);
  const parts: React.ReactNode[] = [];
  let i = 0;
  let plain = "";
  while (i < text.length) {
    const hit = text[i] === "@" && (i === 0 || !/[\w.]/.test(text[i - 1]!)) ? sorted.find((n) => text.slice(i + 1, i + 1 + n.length).toLowerCase() === n.toLowerCase() && !/[\w-]/.test(text[i + 1 + n.length] ?? "")) : undefined;
    if (hit) {
      if (plain) parts.push(plain);
      plain = "";
      parts.push(
        <strong key={i} className="font-medium text-phosphor">
          @{text.slice(i + 1, i + 1 + hit.length)}
        </strong>,
      );
      i += hit.length + 1;
    } else {
      plain += text[i];
      i++;
    }
  }
  if (plain) parts.push(plain);
  return <p className="whitespace-pre-wrap">{parts}</p>;
}
