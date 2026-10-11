import Link from "next/link";
import { Pill } from "@/components/badges";
import { Empty, NoPermission, PageHeader, Section, timeAgo } from "@/components/page";
import { SortableHead } from "@/components/sortable-head";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { readSort, sortRows } from "@/lib/sort";
import { requireUser } from "@/server/auth";
import { recentDenials, toolAccess } from "@/server/tool-catalog";
import { ActionForm } from "@/components/action-form";
import { CheckboxField } from "@/components/field";
import { groupTools, toolGroup } from "@/lib/tool-groups";
import { setToolAccessAction } from "./actions";

export const metadata = { title: "Tool access" };

const SOURCES = [
  { key: "network", title: "Network tools", blurb: "Run in the toolbox. Every call is checked by the policy gate: allowed networks, budgets, and an approved change for writes." },
  { key: "moss", title: "MOSS tools", blurb: "Work on MOSS's own records: inventory, tickets, monitors, the knowledge base. Limited by the agent's role permissions." },
  { key: "custom", title: "Custom tools", blurb: "Your own HTTP tools, granted to agents directly. They go through the policy gate like network tools." },
] as const;

export default async function ToolAccessPage({ searchParams }: PageProps<"/agents/tools">) {
  const user = await requireUser();
  if (!user.permissions.has("agents.read")) return <NoPermission />;
  const sp = await searchParams;
  const [{ tools: allTools, agents, sinceDays }, denials] = await Promise.all([toolAccess(user.orgId), recentDenials(user.orgId)]);
  const sort = readSort(sp, ["tool", "type", "agents", "calls", "denied", "used"] as const);
  const tools = sortRows(allTools, sort, {
    tool: (t) => t.name,
    type: (t) => t.kind,
    agents: (t) => t.holders.length,
    calls: (t) => t.calls,
    denied: (t) => t.denied,
    used: (t) => t.lastUsed,
  });
  const head = (label: string, key: string, className?: string) => <SortableHead label={label} sortKey={key} state={sort} path="/agents/tools" sp={sp} className={className} />;
  const unused = tools.filter((t) => t.holders.length === 0).length;
  const canManage = user.permissions.has("agents.manage");

  return (
    <>
      <PageHeader
        title="Agents"
        description="Which tools each agent can use, where that access comes from, and how much they use it. Agents get tools only through their skills."
      />

      <div className="mb-8 grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-3">
        {[
          ["Tools", tools.length],
          ["Agents", agents.length],
          [`Calls, ${sinceDays} days`, tools.reduce((n, t) => n + t.calls, 0)],
          [`Denied, ${sinceDays} days`, tools.reduce((n, t) => n + t.denied, 0)],
          ["Not granted to anyone", unused],
        ].map(([label, value]) => (
          <div key={label} className="px-frame grid gap-1 bg-card p-4">
            <span className="font-mono text-[11px] tracking-wider text-dim uppercase">{label}</span>
            <span className="font-mono text-2xl tabular-nums">{value}</span>
          </div>
        ))}
      </div>

      <div className="grid gap-8">
        <p className="text-sm text-muted-foreground">{SOURCES[0].blurb}</p>
        {groupTools(tools, (t) => toolGroup(t.name, t.source)).map((group) => (
          <Section key={group.key} title={group.label}>
            {group.key === "moss" && <p className="text-sm text-muted-foreground">{SOURCES[1].blurb}</p>}
            {group.key === "custom" && <p className="text-sm text-muted-foreground">{SOURCES[2].blurb}</p>}
            <div className="px-frame overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {head("Tool", "tool")}
                    {head("Type", "type")}
                    {head("Agents with access", "agents")}
                    {head("Calls", "calls", "text-right")}
                    {head("Denied", "denied", "text-right")}
                    {head("Last used", "used", "text-right")}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.items
                    .map((t) => (
                      <TableRow key={t.name}>
                        <TableCell className="max-w-md align-top whitespace-normal">
                          <div className="font-mono text-sm">{t.name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{t.description}</div>
                        </TableCell>
                        <TableCell className="align-top">
                          <Pill tone={t.kind === "write" ? "orange" : "gray"}>{t.kind}</Pill>
                        </TableCell>
                        <TableCell className="align-top whitespace-normal">
                          {t.holders.length === 0 && !t.holdings.some((h) => h.override === "removed") ? (
                            <span className="text-xs text-dim">Nobody</span>
                          ) : (
                            <ul className="flex flex-wrap gap-1.5">
                              {t.holders.map((h) => (
                                <li key={h.id}>
                                  <Link
                                    href={`/agents/${h.id}`}
                                    title={`Through ${h.via.join(", ")}`}
                                    className="inline-flex items-center gap-1 border-2 px-2 py-0.5 text-xs hover:bg-accent"
                                  >
                                    {h.name}
                                    {h.override === "granted" && <span className="text-phosphor">(added)</span>}
                                    {h.status === "paused" && <span className="text-amber">(paused)</span>}
                                    <span className="sr-only"> through {h.via.join(", ")}</span>
                                  </Link>
                                </li>
                              ))}
                              {t.holdings
                                .filter((h) => h.override === "removed")
                                .map((h) => (
                                  <li key={`removed-${h.id}`}>
                                    <span title="Removed on this page, though a skill grants it" className="inline-flex items-center gap-1 border-2 border-dashed px-2 py-0.5 text-xs text-dim line-through">
                                      {h.name}
                                    </span>
                                    <span className="sr-only"> (access removed)</span>
                                  </li>
                                ))}
                            </ul>
                          )}
                          {t.holdings.some((h) => h.blockedByRole) && (
                            <p className="mt-1 text-xs text-amber">
                              Granted but blocked by role permission: {t.holdings.filter((h) => h.blockedByRole).map((h) => h.name).join(", ")}
                            </p>
                          )}
                          {canManage && t.holdings.length > 0 && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-xs text-muted-foreground">Change access</summary>
                              <ActionForm action={setToolAccessAction.bind(null, t.name)} submitLabel="Save access" submitVariant="outline" className="mt-2 gap-2">
                                <fieldset className="grid gap-1.5">
                                  <legend className="sr-only">Agents that may use {t.name}</legend>
                                  {t.holdings.map((h) => (
                                    <CheckboxField
                                      key={h.id}
                                      label={h.name}
                                      name="agents"
                                      value={h.id}
                                      defaultChecked={h.override ? h.override === "granted" : h.base}
                                      hint={h.base ? `Given by ${h.via.join(", ")}` : undefined}
                                    />
                                  ))}
                                </fieldset>
                                {t.kind === "write" && <p className="text-xs text-muted-foreground">A write tool still only runs as part of an approved change request.</p>}
                              </ActionForm>
                            </details>
                          )}
                        </TableCell>
                        <TableCell className="text-right align-top font-mono tabular-nums">{t.calls || "—"}</TableCell>
                        <TableCell className={`text-right align-top font-mono tabular-nums ${t.denied ? "text-alarm" : ""}`}>{t.denied || "—"}</TableCell>
                        <TableCell className="text-right align-top font-mono text-xs whitespace-nowrap">{t.lastUsed ? timeAgo(t.lastUsed) : "—"}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          </Section>
        ))}

        <Section title="Recent denials">
          <p className="text-sm text-muted-foreground">Tool calls that were refused: outside allowed networks, without an approved change, over budget, or not granted.</p>
          {denials.length === 0 ? (
            <Empty>No denials. Every tool call so far was allowed.</Empty>
          ) : (
            <ul className="px-frame divide-y-2 text-sm">
              {denials.map((d, i) => (
                <li key={`${d.runId}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3">
                  <span className="font-mono text-xs text-dim">{timeAgo(d.at)}</span>
                  <Link href={`/agents/${d.agentId}`} className="font-medium hover:underline">
                    {d.agentName}
                  </Link>
                  <span className="font-mono">{d.tool}</span>
                  {d.code && <Pill tone="red">{d.code.replace(/_/g, " ")}</Pill>}
                  <span className="min-w-0 flex-1 text-muted-foreground">{d.reason}</span>
                  <Link href={`/runs/${d.runId}`} className="text-xs underline">
                    See the run
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
