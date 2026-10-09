import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { cn } from "@/lib/utils";
import type { CurrentUser } from "@/server/auth";
import type { setupProgress } from "@/server/queries";
import { runNowAction } from "./agents/actions";
import { setSetupChecklistHiddenAction } from "./settings/actions";

const DISCOVERY_TASK = "Discover devices on all allowed networks, then identify and classify any new or unidentified ones.";

interface Step {
  done: boolean;
  title: string;
  detail: string;
  action: React.ReactNode;
}

const linkClass = "inline-flex min-h-11 items-center border-2 px-4 text-sm hover:bg-accent";

/** Suggested first steps, worked out from what's set up. Hidden once everything is done. */
export function SetupChecklist({ s, user }: { s: Awaited<ReturnType<typeof setupProgress>>; user: CurrentUser }) {
  const canRun = user.permissions.has("agents.manage");
  const steps: Step[] = [
    { done: s.hasModel, title: "Add a model", detail: "Agents need an LLM to think with: an API key, a Claude subscription or a local Ollama.", action: <Link href="/models" className={linkClass}>Models</Link> },
    { done: s.hasAllowedNetwork, title: "Allow your network", detail: "Add your LAN (for example 10.0.0.0/24) and mark it allowed. Nothing is scanned until you do.", action: <Link href="/networks" className={linkClass}>Networks</Link> },
    { done: s.hasAgent, title: "Hire an agent", detail: "A Network Admin is a good first hire: it finds and names your devices. (Moss, who knows MOSS itself, joins on its own once you add a model.)", action: <Link href="/agents" className={linkClass}>Agents</Link> },
    {
      done: s.hasAssets,
      title: "Run a network discovery",
      detail: s.discoveryAgent
        ? `${s.discoveryAgent.name} can scan your allowed networks and fill in the inventory.`
        : "No agent can scan yet. Hire a Network Admin, or give an agent the Network Discovery skill.",
      action:
        s.discoveryAgent && s.hasAllowedNetwork && canRun ? (
          <ActionForm action={runNowAction.bind(null, s.discoveryAgent.id)} submitLabel={`Start discovery with ${s.discoveryAgent.name}`}>
            <input type="hidden" name="task" value={DISCOVERY_TASK} />
          </ActionForm>
        ) : (
          <Link href="/agents" className={linkClass}>
            Agents
          </Link>
        ),
    },
    { done: s.hasMonitor, title: "Add a monitor", detail: "Watch the services you care about; a responder agent opens an incident when one goes down.", action: <Link href="/monitoring" className={linkClass}>Monitoring</Link> },
    { done: user.totpEnabled, title: "Turn on two-factor sign-in", detail: "Protect the account that approves changes.", action: <Link href="/settings" className={linkClass}>Settings</Link> },
  ];
  const remaining = steps.filter((x) => !x.done).length;
  if (remaining === 0 || user.preferences.hideSetupChecklist) return null;

  return (
    <section aria-labelledby="getting-started" className="px-frame mb-8 grid gap-3 bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="getting-started" className="text-base font-semibold text-ink dark:text-beige">
          Getting started
        </h2>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-dim">
            {steps.length - remaining} of {steps.length} done
          </span>
          <ActionForm action={setSetupChecklistHiddenAction.bind(null, true)} submitLabel="Dismiss" submitVariant="outline" inline />
        </div>
      </div>
      <ol className="grid gap-2">
        {steps.map((step, i) => (
          <li key={step.title} className={cn("flex flex-wrap items-center gap-3 border-t-2 pt-2 first:border-t-0 first:pt-0", step.done && "text-muted-foreground")}>
            <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center font-mono text-xs", step.done ? "bg-phosphor text-on-brand" : "border-2 text-dim")}>
              {step.done ? "✓" : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn("text-sm font-medium", step.done && "line-through")}>
                {step.title}
                <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
              </div>
              {!step.done && <div className="text-xs text-muted-foreground">{step.detail}</div>}
            </div>
            {!step.done && step.action}
          </li>
        ))}
      </ol>
    </section>
  );
}
