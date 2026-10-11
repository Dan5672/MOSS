import { Markdown } from "@/components/markdown";

/** A note widget's Markdown. Links go only to http(s) addresses; [[wiki links]] open the wiki's search. */
export function NoteText({ text }: { text: string }) {
  return (
    <div className="prose-sm text-sm">
      <Markdown text={text} links={(title) => `/wiki?q=${encodeURIComponent(title)}`} />
    </div>
  );
}
