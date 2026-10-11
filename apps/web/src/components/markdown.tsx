import Link from "next/link";
import type { ReactNode } from "react";

// A small Markdown renderer for wiki pages. Pages are written by agents (model output that may quote network
// data) and by people, so it builds React elements only: no HTML is ever passed through, and links go only
// to other wiki pages ([[Page title]]) or to http(s) addresses.
//
// Supported: # to ### headings, paragraphs, "- " / "* " and "1. " lists, ``` code blocks, `code`,
// **bold**, [[Page title]] / [[Page title|text]] and [text](https://...).

export type PageLinks = (title: string) => string | null;

const INLINE = /(\[\[([^\]|]{1,120})(?:\|([^\]]{1,120}))?\]\]|\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)|`([^`]{1,500})`|\*\*([^*]{1,500})\*\*)/g;

function inline(text: string, links: PageLinks, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[2]) {
      const href = links(m[2].trim());
      out.push(
        href ? (
          <Link key={k} href={href} className="text-phosphor underline underline-offset-2">
            {m[3] ?? m[2]}
          </Link>
        ) : (
          <span key={k} className="text-muted-foreground underline decoration-dashed" title="No page with this title yet">
            {m[3] ?? m[2]}
          </span>
        ),
      );
    } else if (m[4] && m[5]) {
      out.push(
        <a key={k} href={m[5]} rel="noopener noreferrer nofollow" target="_blank" className="underline underline-offset-2">
          {m[4]}
        </a>,
      );
    } else if (m[6]) {
      out.push(
        <code key={k} className="bg-muted px-1 font-mono text-[0.9em]">
          {m[6]}
        </code>,
      );
    } else if (m[7]) {
      out.push(<strong key={k}>{m[7]}</strong>);
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, links }: { text: string; links: PageLinks }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${n++}`;
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) code.push(lines[i]!);
      i++;
      blocks.push(
        <pre key={key} className="overflow-x-auto bg-muted p-3 font-mono text-xs">
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const content = inline(heading[2]!, links, key);
      blocks.push(
        level === 1 ? (
          <h2 key={key} className="mt-2 text-xl font-semibold">
            {content}
          </h2>
        ) : level === 2 ? (
          <h3 key={key} className="mt-2 text-lg font-semibold">
            {content}
          </h3>
        ) : (
          <h4 key={key} className="mt-1 font-semibold">
            {content}
          </h4>
        ),
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key} className={ordered ? "list-decimal space-y-1 pl-6" : "list-disc space-y-1 pl-6"}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, links, `${key}-${j}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|```|\s*([-*]|\d+\.)\s+)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(
      <p key={key} className="whitespace-pre-wrap">
        {inline(para.join("\n"), links, key)}
      </p>,
    );
  }
  return <div className="grid gap-3 text-sm leading-relaxed">{blocks}</div>;
}
