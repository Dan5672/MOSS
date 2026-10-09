"use client";

import { startTransition, useActionState, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { GROUP_LABEL, toolGroup } from "@/lib/tool-groups";
import { cn } from "@/lib/utils";
import { setupAssetAccessAction } from "./access-actions";

type CredType = "password" | "ssh_key" | "api_token" | "snmp_community";

export interface AccessWizardProps {
  asset: { id: string; name: string; ip: string };
  level: "off_limits" | "not_allowed" | "look" | "sign_in";
  /** The network to allow, when it isn't yet. */
  suggestedCidr: string | null;
  can: { networks: boolean; secrets: boolean; agents: boolean };
  secrets: { id: string; name: string; type: string }[];
  agents: { id: string; name: string; title: string; tools: string[] }[];
  toolsByType: Record<CredType, string[]>;
  /** Open straight away (from the access badge on the asset list). */
  defaultOpen?: boolean;
}

const TYPES: { value: CredType; label: string; hint: string }[] = [
  { value: "password", label: "Username and password", hint: "Web admin pages: routers, NAS boxes, Pi-hole, UniFi." },
  { value: "ssh_key", label: "SSH key", hint: "Linux servers and anything you'd SSH into." },
  { value: "api_token", label: "API token", hint: "Home Assistant, Proxmox, TrueNAS and other apps with API keys." },
  { value: "snmp_community", label: "SNMP community", hint: "Switches, printers and UPSes that speak SNMP." },
];
const STEPS = ["Network", "Sign-in", "Agents", "Check"] as const;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "device";

/** A short wizard on an asset: make it reachable, give agents a way in, and choose which agents. */
export function AccessWizard(p: AccessWizardProps) {
  const [open, setOpen] = useState(!!p.defaultOpen);
  const [step, setStep] = useState(0);
  const [allow, setAllow] = useState(p.level === "not_allowed" && !!p.suggestedCidr && p.can.networks);
  const [cidr, setCidr] = useState(p.suggestedCidr ?? "");
  const [mode, setMode] = useState<"look" | "new" | "existing">(p.can.secrets ? "new" : "look");
  const [type, setType] = useState<CredType>("password");
  const [secretId, setSecretId] = useState(p.secrets[0]?.id ?? "");
  const existingType = (p.secrets.find((s) => s.id === secretId)?.type ?? "password") as CredType;
  const credType = mode === "existing" ? existingType : type;
  const suggestedTools = mode === "look" ? [] : (p.toolsByType[credType] ?? []);
  const [tools, setTools] = useState<string[] | null>(null); // null: the suggestions for the chosen type
  const chosenTools = tools ?? suggestedTools;
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const secretName = name || `${slug(p.asset.name)}-${credType.replace("_", "-")}`;

  const [state, formAction, pending] = useActionState(async (_: unknown, form: FormData) => {
    const result = await setupAssetAccessAction(p.asset.id, undefined, form);
    if (result?.ok) {
      toast.success(result.message ?? "Done.");
      setOpen(false);
      setStep(0);
    }
    return result;
  }, undefined);

  const blocked = p.level === "off_limits";
  const reachable = p.level !== "not_allowed" || allow;
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Set up agent access</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Agent access to {p.asset.name}</DialogTitle>
          <DialogDescription>
            {p.asset.ip} · step {step + 1} of {STEPS.length}: {STEPS[step]}
          </DialogDescription>
        </DialogHeader>
        <ol className="flex gap-1" aria-hidden>
          {STEPS.map((s, i) => (
            <li key={s} className={cn("h-1.5 flex-1", i <= step ? "bg-phosphor" : "bg-muted")} />
          ))}
        </ol>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            startTransition(() => formAction(data));
          }}
          className="grid gap-4 text-sm"
        >
          {/* Step 1: the network. Every step stays in the form so its answers are submitted at the end. */}
          <fieldset hidden={step !== 0} className="grid gap-3">
            <legend className="sr-only">Network</legend>
            {blocked ? (
              <p className="text-alarm">
                {p.asset.ip} is in a network marked off limits, so no agent may touch it. If that&apos;s wrong, change the network under Settings → Networks first.
              </p>
            ) : p.level === "not_allowed" ? (
              <>
                <p>Agents can only reach devices on networks you&apos;ve allowed. {p.asset.ip} isn&apos;t on one yet.</p>
                {p.can.networks ? (
                  <>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} /> Allow this network
                    </label>
                    {allow && (
                      <label className="grid gap-1.5 font-medium">
                        Network
                        <Input name="allowNetwork" value={cidr} onChange={(e) => setCidr(e.target.value)} className="font-mono font-normal" />
                        <span className="text-xs font-normal text-muted-foreground">Agents may scan anything in it. Make it smaller (e.g. {p.asset.ip}/32) to allow just this device.</span>
                      </label>
                    )}
                  </>
                ) : (
                  <p className="text-muted-foreground">Ask someone who manages networks to allow it.</p>
                )}
              </>
            ) : (
              <p>{p.asset.ip} is on an allowed network: agents can already scan it and check its services.</p>
            )}
          </fieldset>

          {/* Step 2: how agents sign in. */}
          <fieldset hidden={step !== 1} className="grid gap-3">
            <legend className="sr-only">Sign-in</legend>
            <input type="hidden" name="mode" value={mode} />
            {(
              [
                ["look", "Look only", "Scans, ping and web checks. No sign-in, nothing stored."],
                ["new", "Give agents a new credential", "Stored encrypted; only usable against this device."],
                ["existing", "Use a credential you've already stored", "It's extended to this device."],
              ] as const
            )
              .filter(([m]) => m === "look" || (p.can.secrets && (m === "new" || p.secrets.length > 0)))
              .map(([m, label, hint]) => (
                <label key={m} className={cn("flex gap-2 border-2 p-3", mode === m && "border-phosphor")}>
                  <input type="radio" name="modeChoice" checked={mode === m} onChange={() => (setMode(m), setTools(null))} />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">{hint}</span>
                  </span>
                </label>
              ))}
            {mode === "new" && (
              <div className="grid gap-3 border-l-2 pl-3">
                <label className="grid gap-1.5 font-medium">
                  Kind
                  <select name="type" value={type} onChange={(e) => (setType(e.target.value as CredType), setTools(null))} className="h-9 border bg-transparent px-2 font-normal">
                    {TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs font-normal text-muted-foreground">{TYPES.find((t) => t.value === type)!.hint}</span>
                </label>
                <label className="grid gap-1.5 font-medium">
                  Secret name
                  <Input name="secretName" value={secretName} onChange={(e) => setName(e.target.value)} className="font-mono font-normal" />
                </label>
                {type === "password" && (
                  <label className="grid gap-1.5 font-medium">
                    Username
                    <Input name="username" autoComplete="off" className="font-normal" />
                  </label>
                )}
                <label className="grid gap-1.5 font-medium">
                  {type === "password" ? "Password" : type === "ssh_key" ? "Private key" : type === "api_token" ? "Token" : "Community"}
                  {type === "ssh_key" ? (
                    <textarea name="value" rows={4} autoComplete="off" className="border bg-transparent p-2 font-mono text-xs font-normal" />
                  ) : (
                    <Input name="value" type="password" autoComplete="new-password" className="font-normal" />
                  )}
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" name="allowOdd" /> Save it even if it looks unusual
                </label>
              </div>
            )}
            {mode === "existing" && (
              <label className="grid gap-1.5 border-l-2 pl-3 font-medium">
                Secret
                <select name="secretId" value={secretId} onChange={(e) => (setSecretId(e.target.value), setTools(null))} className="h-9 border bg-transparent px-2 font-normal">
                  {p.secrets.map((s) => (
                    <option key={s.id} value={s.id}>
                      secret:{s.name} ({s.type.replace("_", " ")})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>

          {/* Step 3: which tools and which agents. */}
          <fieldset hidden={step !== 2} className="grid gap-3">
            <legend className="sr-only">Agents</legend>
            {mode !== "look" && (
              <div className="grid gap-1.5">
                <span className="font-medium">Tools it may be used with</span>
                {suggestedTools.length === 0 && <span className="text-xs text-muted-foreground">No built-in tool takes this kind of credential.</span>}
                <div className="grid gap-1 sm:grid-cols-2">
                  {suggestedTools.map((t) => (
                    <label key={t} className="flex items-center gap-2 text-xs">
                      <input type="checkbox" name="tools" value={t} checked={chosenTools.includes(t)} onChange={() => setTools(toggle(chosenTools, t))} />
                      <span className="font-mono">{t}</span> <span className="text-muted-foreground">{GROUP_LABEL[toolGroup(t)]}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="grid gap-1.5">
              <span className="font-medium">{mode === "look" ? "Nothing to hand out: agents can already look once the network is allowed." : "Agents who get it"}</span>
              {mode !== "look" &&
                p.agents.map((a) => {
                  const has = chosenTools.filter((t) => a.tools.includes(t)).length;
                  return (
                    <label key={a.id} className="flex items-center gap-2">
                      <input type="checkbox" name="agents" value={a.id} checked={agentIds.includes(a.id)} onChange={() => setAgentIds(toggle(agentIds, a.id))} />
                      {a.name} <span className="text-xs text-muted-foreground">{a.title}</span>
                      {chosenTools.length > 0 && (
                        <span className="ml-auto font-mono text-xs text-dim">
                          has {has}/{chosenTools.length} tools
                        </span>
                      )}
                    </label>
                  );
                })}
            </div>
            {mode !== "look" && p.can.agents && (
              <label className="flex items-center gap-2">
                <input type="checkbox" name="grantTools" defaultChecked /> Also give them any of these tools they don&apos;t have
              </label>
            )}
          </fieldset>

          {/* Step 4: what will happen. */}
          <fieldset hidden={step !== 3} className="grid gap-2">
            <legend className="sr-only">Check</legend>
            <ul className="grid list-disc gap-1 pl-5">
              {p.level === "not_allowed" && <li>{allow ? `Allow ${cidr} for agents.` : "Leave the network as it is: agents still can't reach this device."}</li>}
              {mode === "look" && <li>No credential: agents can scan and check {p.asset.ip}.</li>}
              {mode === "new" && <li>Store secret:{secretName}, usable only against {p.asset.ip}{chosenTools.length ? ` with ${chosenTools.length} tool${chosenTools.length === 1 ? "" : "s"}` : ""}.</li>}
              {mode === "existing" && <li>Let secret:{p.secrets.find((s) => s.id === secretId)?.name} be used against {p.asset.ip}.</li>}
              {mode !== "look" && <li>{agentIds.length ? `Give it to ${p.agents.filter((a) => agentIds.includes(a.id)).map((a) => a.name).join(", ")}.` : "Give it to no agents yet."}</li>}
            </ul>
            {!reachable && <p className="text-amber">Agents won&apos;t be able to use it until the network is allowed.</p>}
          </fieldset>

          {state?.error && (
            <p role="alert" className="text-sm whitespace-pre-line text-destructive">
              {state.error}
            </p>
          )}
          <div className="flex justify-between gap-2">
            <Button type="button" variant="outline" disabled={step === 0} onClick={() => setStep(step - 1)}>
              Back
            </Button>
            {step < STEPS.length - 1 ? (
              // Separate keys: if React reused this button as the submit one, the click that moves to the last
              // step would also submit the form.
              <Button key="next" type="button" disabled={blocked} onClick={() => setStep(step + 1)}>
                Next
              </Button>
            ) : (
              <Button key="submit" type="submit" disabled={pending}>
                {pending ? "Working…" : "Set up access"}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
