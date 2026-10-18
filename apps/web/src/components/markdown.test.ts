import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text, links: () => null }));

describe("Markdown", () => {
  it("renders a pipe table, with alignment, inline formatting and escaped pipes", () => {
    const out = html("Intro\n| Host | Port | Note |\n|:-----|-----:|:----:|\n| nas | 22 | **ssh** |\n| a\\|b | 443 |\n\nAfter");
    expect(out).toContain("<p");
    expect(out).toContain('<th style="text-align:left"');
    expect(out).toContain('<td style="text-align:right" class="border-2 px-2 py-1 align-top">22</td>');
    expect(out).toContain("<strong>ssh</strong>");
    expect(out).toContain(">a|b</td>");
    expect(out.match(/<tr>/g)).toHaveLength(3); // header and two rows, the short row padded
    expect(out).toContain("After</p>");
  });

  it("shows where a link really goes", () => {
    expect(html("[your bank](https://evil.example/login)")).toContain("(evil.example)</span></a>");
  });

  it("leaves a line with a pipe but no divider as text", () => {
    expect(html("a | b\nc")).not.toContain("<table");
  });

  it("renders italics, deeper headings and rules, and never raw HTML", () => {
    const out = html("#### Four\n*soft* and **hard** and 2 * 3 * 4\n\n---\n<script>x</script>");
    expect(out).toContain("<h4");
    expect(out).toContain("<em>soft</em>");
    expect(out).toContain("<strong>hard</strong>");
    expect(out).toContain("2 * 3 * 4");
    expect(out).toContain("<hr");
    expect(out).toContain("&lt;script&gt;");
  });
});
