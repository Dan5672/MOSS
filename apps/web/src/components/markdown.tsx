import Link from "next/link";
import type { ReactNode } from "react";

// A small Markdown renderer for wiki pages. Pages are written by agents (model output that may quote network
// data) and by people, so it builds React elements only: no HTML is ever passed through, and links go only
// to other wiki pages ([[Page title]]) or to http(s) addresses.
//
// Supported: # to ###### headings, paragraphs, "- " / "* " and "1. " lists, | pipe | tables |, ``` code blocks,
// --- rules, `code`, **bold**, *italic*, [[Page title]] / [[Page title|text]] and [text](https://...).

export type PageLinks = (title: string) => string | null;

const INLINE = /(\[\[([^\]|]{1,120})(?:\|([^\]]{1,120}))?\]\]|\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)|`([^`]{1,500})`|\*\*([^*]{1,500})\*\*|(?<![\w*])\*(?![\s*])([^*\n]{1,500}?)\*(?![\w*]))/g;

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
          {/* Link text is the writer's (often a model's) choice: show where it really goes. */}
          {URL.canParse(m[5]) && <span className="ml-1 font-mono text-[0.8em] text-muted-foreground">({new URL(m[5]).host})</span>}
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
    } else if (m[8]) {
      out.push(<em key={k}>{m[8]}</em>);
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const isTableRow = (line: string | undefined) => !!line && line.includes("|");
/** A pipe-table row's cells; "\|" is a literal pipe inside a cell. */
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
const startsTable = (lines: string[], i: number) => isTableRow(lines[i]) && TABLE_DIVIDER.test(lines[i + 1] ?? "") && lines[i + 1]!.includes("-");
const BLOCK_START = /^(#{1,6}\s|```|\s*([-*]|\d+\.)\s+|\s*([-*_])(\s*\3){2,}\s*$)/;

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
    if (startsTable(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c): "left" | "center" | "right" => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
      const rows: string[][] = [];
      for (i += 2; i < lines.length && isTableRow(lines[i]) && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      blocks.push(
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                {head.map((h, j) => (
                  <th key={j} style={{ textAlign: align[j] }} className="border-2 bg-muted px-2 py-1 font-semibold">
                    {inline(h, links, `${key}-h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] }} className="border-2 px-2 py-1 align-top">
                      {inline(r[j] ?? "", links, `${key}-${ri}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key} className="border-t-2" />);
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
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
    while (i < lines.length && lines[i]!.trim() && !BLOCK_START.test(lines[i]!) && !startsTable(lines, i)) para.push(lines[i++]!);
    blocks.push(
      <p key={key} className="whitespace-pre-wrap">
        {inline(para.join("\n"), links, key)}
      </p>,
    );
  }
  return <div className="grid gap-3 text-sm leading-relaxed">{blocks}</div>;
}
