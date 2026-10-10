"use client";

/** Clickable task ideas that fill the task box in the same form (they don't start anything). */
export function TaskSuggestionButtons({ suggestions }: { suggestions: string[] }) {
  return (
    <div className="grid gap-1.5">
      <span className="font-mono text-[11px] tracking-wider text-dim uppercase">Suggestions</span>
      <ul className="grid gap-1.5">
        {suggestions.map((s) => (
          <li key={s}>
            <button
              type="button"
              className="min-h-11 w-full border-2 px-3 py-2 text-left text-sm hover:border-phosphor hover:bg-accent"
              onClick={(e) => {
                const box = e.currentTarget.form?.elements.namedItem("task");
                if (box instanceof HTMLTextAreaElement) {
                  box.value = s;
                  box.focus();
                }
              }}
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
