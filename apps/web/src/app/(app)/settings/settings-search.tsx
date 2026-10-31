"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Input } from "@/components/ui/input";

export interface SettingsEntry {
  label: string;
  /** Where it lives, shown under the label. */
  where: string;
  href: string;
  /** More words it's found by. */
  words?: string;
}

/** Entries containing every word of the query, in the label first. */
export function searchSettings(index: SettingsEntry[], query: string): SettingsEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const text = (e: SettingsEntry) => `${e.label} ${e.where} ${e.words ?? ""}`.toLowerCase();
  const hits = index.filter((e) => words.every((w) => text(e).includes(w)));
  const inLabel = (e: SettingsEntry) => words.every((w) => e.label.toLowerCase().includes(w));
  return [...hits.filter(inLabel), ...hits.filter((e) => !inLabel(e))];
}

/** Finds a setting across every Settings page; Enter opens the first match. */
export function SettingsSearch({ index }: { index: SettingsEntry[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const results = searchSettings(index, query).slice(0, 8);
  const go = (href: string) => {
    setQuery("");
    router.push(href);
  };

  return (
    <div role="search" className="relative mb-4 max-w-md">
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) go(results[0].href);
          if (e.key === "Escape") setQuery("");
        }}
        placeholder="Search settings"
        aria-label="Search settings"
        aria-controls="settings-search-results"
      />
      {query.trim() && (
        <ul id="settings-search-results" aria-live="polite" className="absolute inset-x-0 top-full z-20 mt-1 grid border bg-popover text-sm shadow-md">
          {results.length === 0 ? (
            <li className="p-3 text-muted-foreground">No settings match.</li>
          ) : (
            results.map((r) => (
              <li key={`${r.href}-${r.label}`}>
                <Link href={r.href} onClick={() => setQuery("")} className="grid px-3 py-2 hover:bg-accent focus:bg-accent focus:outline-none">
                  <span className="font-medium">{r.label}</span>
                  <span className="text-xs text-muted-foreground">{r.where}</span>
                </Link>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
