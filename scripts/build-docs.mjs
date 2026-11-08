#!/usr/bin/env node
// Builds the website's docs pages (site/docs/*.html) from library/docs/*.md, the same docs Moss reads in the app.
// Rerun after editing a doc:  node scripts/build-docs.mjs
// It also rewrites the docs part of site/sitemap.xml. Pages not in PAGES (welcome.md, changelog.md) aren't published.
// Links, canonicals and the sitemap use clean URLs (/docs/safety): Cloudflare Pages serves safety.html there and redirects the .html URL.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "library/docs");
const OUT = join(ROOT, "site/docs");
const SITE = "https://moss-ops.com";

// One entry per published doc, in the order the docs index lists them. The doc's own "# " heading is replaced by h1.
const PAGES = [
  {
    name: "overview",
    h1: "MOSS overview",
    title: "What MOSS is: a self-hosted AI IT department · MOSS",
    description:
      "What MOSS is and how it fits together: the web, worker, gate and toolbox services, the pages in the app, and how agent runs work.",
    related: ["safety", "agents", "monitoring"],
  },
  {
    name: "safety",
    h1: "MOSS safety model",
    title: "MOSS safety model: how AI changes are approved · MOSS",
    description:
      "How MOSS keeps AI agents in check: the policy gate, allowed networks, change requests that need your approval, secrets and the audit log.",
    related: ["troubleshooting", "settings-and-integrations", "reference"],
  },
  {
    name: "agents",
    h1: "MOSS agents",
    title: "MOSS agents: hiring, skills, budgets and tasks · MOSS",
    description:
      "Hire AI agents in MOSS, give them skills and tool access, set budgets and models, schedule recurring tasks and talk to them in chat.",
    related: ["overview", "safety", "reference"],
  },
  {
    name: "monitoring",
    h1: "Monitoring in MOSS",
    title: "Monitoring in MOSS: checks, dashboards and device logs · MOSS",
    description:
      "Watch your services with MOSS: built-in and external monitors, dependencies, dashboards, syslog device logs, and agents that respond to outages.",
    related: ["agents", "settings-and-integrations", "troubleshooting"],
  },
  {
    name: "settings-and-integrations",
    h1: "MOSS settings and integrations",
    title: "MOSS settings and integrations: UniFi, Home Assistant and more · MOSS",
    description:
      "Set up MOSS: security, secrets, backups, networks and users, plus integrations such as UniFi, Home Assistant, Proxmox, Docker and Slack.",
    related: ["safety", "monitoring", "reference"],
  },
  {
    name: "troubleshooting",
    h1: "Troubleshooting MOSS",
    title: "Troubleshooting MOSS: denied tools, silent agents and more · MOSS",
    description:
      "Fix common MOSS problems: tools an agent was denied, agents that don't reply, rejected credentials, empty discovery, monitors and upgrades.",
    related: ["safety", "agents", "settings-and-integrations"],
  },
  {
    name: "reference",
    h1: "MOSS reference",
    title: "MOSS reference: every setting, tool and agent template · MOSS",
    description:
      "The full MOSS reference: every setting with its default, every network and MOSS tool agents can use, and the agent templates you can hire.",
    related: ["safety", "settings-and-integrations", "agents"],
  },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s) => s.toLowerCase().replace(/<[^>]+>|&\w+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const PAGE_NAMES = new Set(PAGES.map((p) => p.name));

// Escaped text in, inline HTML out: `code`, **bold**, *italic* and [text](url). Links to other docs (foo.md) go to their page.
function inline(text) {
  const parts = text.split(/(`[^`]+`)/);
  return parts
    .map((part, i) => {
      if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
          const doc = href.match(/^(?:\.\/)?([\w-]+)\.md(#.*)?$/);
          if (doc && PAGE_NAMES.has(doc[1])) href = `${doc[1]}${doc[2] ?? ""}`;
          return `<a href="${href}">${label}</a>`;
        });
    })
    .join("");
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => inline(c.trim().replace(/\\\|/g, "|")));
const LIST = /^\s*([-*]|\d+\.)\s+/;
const BLOCK = /^(#{1,6}\s|```|\s*([-*]|\d+\.)\s+|\|)/;

// The subset of Markdown the library docs use: headings, paragraphs, lists (with indented continuation lines),
// pipe tables, ``` code blocks and the inline marks above.
function markdown(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (line.startsWith("```")) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      const html = inline(line.slice(level).trim());
      out.push(level === 1 ? `<h1>${html}</h1>` : `<h${level} id="${slug(html)}">${html}</h${level}>`);
      i++;
    } else if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes("|"); i++) rows.push(cells(lines[i]));
      out.push(
        `<div class="table"><table>\n<thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>\n<tbody>\n` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n") +
          `\n</tbody>\n</table></div>`,
      );
    } else if (LIST.test(line)) {
      const tag = /^\s*\d+\./.test(line) ? "ol" : "ul";
      const items = [];
      while (i < lines.length && LIST.test(lines[i])) {
        let item = lines[i++].replace(LIST, "");
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !LIST.test(lines[i])) item += " " + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<${tag}>\n${items.join("\n")}\n</${tag}>`);
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !BLOCK.test(lines[i])) para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

const nav = `<nav class="nav" aria-label="Main">
          <a href="../#features">What it does</a>
          <a href="../#safety">Safety</a>
          <a href="../#integrations">Integrations</a>
          <a href="../#pricing">Free &amp; business</a>
          <a href="./">Docs</a>
          <a href="https://github.com/Dan5672/MOSS">GitHub</a>
          <a class="btn small" href="../#contact">Contact</a>
        </nav>`;

function page({ path, title, description, ogTitle, body }) {
  const url = `${SITE}/docs/${path}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <meta name="theme-color" content="#0b0f0d" />
    <link rel="canonical" href="${url}" />
    <link rel="icon" href="../assets/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="../assets/apple-icon.png" />

    <meta property="og:type" content="article" />
    <meta property="og:url" content="${url}" />
    <meta property="og:title" content="${esc(ogTitle)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:image" content="${SITE}/assets/moss-banner.png" />
    <meta name="twitter:card" content="summary_large_image" />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;600&family=Press+Start+2P&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="../styles.css" />
  </head>
  <body>
    <a class="skip" href="#main">Skip to the content</a>

    <header class="top">
      <div class="wrap">
        <a class="brand" href="../" aria-label="MOSS home">
          <img src="../assets/icon.svg" alt="" width="32" height="32" />
          <span>MOSS<br /><small>B1 · IT DEPT</small></span>
        </a>
        ${nav}
      </div>
    </header>

    <main id="main">
      <section class="doc">
        <div class="wrap">
${body}
        </div>
      </section>
    </main>

    <footer>
      <div class="wrap">
        <a class="brand" href="../" aria-label="MOSS home">
          <img src="../assets/icon.svg" alt="" width="28" height="28" />
          <span>MOSS</span>
        </a>
        <span>Managed Operations &amp; Systems Service</span>
        <nav aria-label="Footer">
          <a href="https://github.com/Dan5672/MOSS">GitHub</a>
          <a href="./">Docs</a>
          <a href="https://github.com/Dan5672/MOSS/blob/main/docs/getting-started.md">Getting started</a>
          <a href="https://github.com/Dan5672/MOSS/blob/main/docs/integrations.md">Integrations</a>
          <a href="https://github.com/Dan5672/MOSS/blob/main/LICENSE">Licence</a>
          <a href="../#contact">Contact</a>
        </nav>
      </div>
    </footer>

    <!-- TODO: Cloudflare Web Analytics beacon -->
  </body>
</html>
`;
}

const byName = Object.fromEntries(PAGES.map((p) => [p.name, p]));
const crumb = `<p class="eyebrow"><a href="./">Docs</a></p>`;

function main() {
  mkdirSync(OUT, { recursive: true });
  for (const p of PAGES) {
    const md = readFileSync(join(SRC, `${p.name}.md`), "utf8").replace(/^# .*\n/, "");
    const related = p.related.map((r) => `<li><a href="${r}">${esc(byName[r].h1)}</a>: ${esc(byName[r].description)}</li>`);
    const body = `${crumb}\n<h1>${esc(p.h1)}</h1>\n<article>\n${markdown(md)}\n</article>\n<aside class="related">\n<h2>Related docs</h2>\n<ul>\n${related.join("\n")}\n</ul>\n</aside>`;
    writeFileSync(join(OUT, `${p.name}.html`), page({ path: p.name, title: p.title, description: p.description, ogTitle: p.h1, body }));
  }

  const cards = PAGES.map(
    (p) => `<article class="card frame">\n<h2><a href="${p.name}">${esc(p.h1)}</a></h2>\n<p>${esc(p.description)}</p>\n</article>`,
  );
  writeFileSync(
    join(OUT, "index.html"),
    page({
      path: "",
      title: "MOSS docs: how the self-hosted AI IT department works · MOSS",
      description: "The MOSS docs: how the AI agents work, the safety model and approvals, monitoring, settings and integrations, troubleshooting and the full reference.",
      ogTitle: "MOSS docs",
      body: `<h1>MOSS docs</h1>\n<p class="lede">How MOSS works, how it keeps your network safe, and how to set it up. New to MOSS? Start with the <a href="https://github.com/Dan5672/MOSS/blob/main/docs/getting-started.md">getting started guide</a>.</p>\n<div class="grid">\n${cards.join("\n")}\n</div>`,
    }),
  );

  const urls = [`${SITE}/`, `${SITE}/docs/`, ...PAGES.map((p) => `${SITE}/docs/${p.name}`)];
  writeFileSync(
    join(ROOT, "site/sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}\n</urlset>\n`,
  );
  console.log(`Built ${PAGES.length} docs pages, the docs index and the sitemap.`);
}

main();
