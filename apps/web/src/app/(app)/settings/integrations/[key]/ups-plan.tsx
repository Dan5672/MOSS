import { approvedInAdvance, getIntegration, getUpsPlan, loadIntegration } from "@moss/core";
import { secrets } from "@moss/db";
import { asc, eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { SelectField, TextField } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/server/db";
import { addUpsStepAction, approveUpsPlanAction, moveUpsStepAction, removeUpsStepAction, saveUpsPlanSettingsAction } from "./ups-actions";

/** The UPS shutdown plan: what to switch off, in order, when the battery runs low, and how it's approved. */
export async function UpsPlanCard({ orgId, agents, canApprove }: { orgId: string; agents: { id: string; name: string; title: string }[]; canApprove: boolean }) {
  const [plan, secretRows, pve] = await Promise.all([
    getUpsPlan(db(), orgId),
    db().select({ name: secrets.name }).from(secrets).where(eq(secrets.orgId, orgId)).orderBy(asc(secrets.name)),
    loadIntegration(db(), orgId, getIntegration("proxmox")!),
  ]);
  const approved = approvedInAdvance(plan);

  return (
    <Card id="shutdown-plan" className="scroll-mt-6 lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Shutdown plan{" "}
          <Badge variant={plan.mode === "off" ? "outline" : "default"}>{plan.mode === "off" ? "Off" : plan.mode === "ask" ? "Asks each time" : approved ? "Approved in advance" : "Waiting for approval"}</Badge>
        </CardTitle>
        <CardDescription>
          When a UPS on battery is down to the minutes below (or reports a low battery), MOSS raises this plan as a change for the agent to carry out,
          step by step, so things go down in order before the battery runs out. If the power comes back first, MOSS cancels it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 text-sm">
        <ActionForm action={saveUpsPlanSettingsAction} submitLabel="Save plan settings">
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField
              label="How it runs"
              name="mode"
              defaultValue={plan.mode}
              options={[
                { value: "off", label: "Off" },
                { value: "ask", label: "Ask for approval each time" },
                { value: "auto", label: "Approved in advance" },
              ]}
              hint="Asking each time sends Approve and Reject to Telegram or Discord, if they're set up."
            />
            <SelectField
              label="Carried out by"
              name="agentId"
              defaultValue={plan.agentId ?? ""}
              options={[{ value: "", label: "Choose an agent" }, ...agents.map((a) => ({ value: a.id, label: `${a.name} (${a.title})` }))]}
              hint="It's given the plan's tools and secrets."
            />
            <TextField label="Act at (minutes left)" name="runtimeMinutes" type="number" min={1} max={120} defaultValue={plan.runtimeMinutes} />
          </div>
        </ActionForm>

        <div className="grid gap-2">
          <p className="font-medium">Steps, in order</p>
          {plan.steps.length === 0 ? (
            <p className="text-muted-foreground">No steps yet. Add the VMs and servers to switch off, the NAS last.</p>
          ) : (
            <ol className="grid gap-1.5" aria-label="Shutdown steps">
              {plan.steps.map((s, i) => (
                <li key={`${i}-${s.label}`} className="flex flex-wrap items-center gap-2 border-2 px-3 py-2">
                  <span className="font-mono text-xs text-muted-foreground">{i + 1}.</span>
                  <span className="font-medium">{s.label}</span>
                  <span className="flex-1 font-mono text-xs text-muted-foreground">
                    {s.type === "proxmox" ? `Proxmox ${s.kind} ${s.vmid} on ${s.node}` : `${s.user}@${s.target} (secret:${s.secret})`}
                  </span>
                  <ActionForm action={moveUpsStepAction.bind(null, i, -1)} submitLabel="↑" submitVariant="outline" inline />
                  <ActionForm action={moveUpsStepAction.bind(null, i, 1)} submitLabel="↓" submitVariant="outline" inline />
                  <ActionForm action={removeUpsStepAction.bind(null, i)} submitLabel="Remove" submitVariant="outline" inline />
                </li>
              ))}
            </ol>
          )}
          <div className="flex flex-wrap gap-2">
            <FormDialog label="Add a Proxmox VM or container" variant="outline" title="Add a Proxmox VM or container" description="Shut down cleanly through the Proxmox VE integration's connection.">
              {pve.config.host ? (
                <ActionForm action={addUpsStepAction.bind(null, "proxmox")} submitLabel="Add step">
                  <TextField label="Name" name="label" placeholder="Plex VM" required />
                  <div className="grid gap-3 sm:grid-cols-3">
                    <TextField label="Node" name="node" placeholder="pve1" required />
                    <SelectField
                      label="Type"
                      name="kind"
                      options={[
                        { value: "vm", label: "VM" },
                        { value: "container", label: "Container" },
                      ]}
                    />
                    <TextField label="ID" name="vmid" type="number" min={100} placeholder="101" required />
                  </div>
                </ActionForm>
              ) : (
                <p className="text-sm">Set up the Proxmox VE integration first; these steps use its connection.</p>
              )}
            </FormDialog>
            <FormDialog label="Add a Linux server" variant="outline" title="Add a Linux server" description="Powered off over SSH (sudo -n shutdown -h), with a stored key. The account needs passwordless sudo for shutdown.">
              <ActionForm action={addUpsStepAction.bind(null, "ssh")} submitLabel="Add step">
                <TextField label="Name" name="label" placeholder="NAS" required />
                <div className="grid gap-3 sm:grid-cols-3">
                  <TextField label="Address" name="target" placeholder="192.168.1.10" required />
                  <TextField label="Sign in as" name="user" placeholder="moss" required />
                  <TextField label="SSH port" name="port" type="number" min={1} max={65535} defaultValue={22} />
                </div>
                <SelectField label="SSH key (stored secret)" name="secret" options={secretRows.map((r) => ({ value: r.name, label: r.name }))} required />
              </ActionForm>
            </FormDialog>
          </div>
        </div>

        {plan.mode === "auto" && (
          <div className="grid gap-2 border-t-2 pt-4">
            {approved ? (
              <p>Approved in advance on {new Date(plan.approval!.at).toLocaleString()}. Changing the steps withdraws the approval.</p>
            ) : canApprove ? (
              <ActionForm action={approveUpsPlanAction} submitLabel="Approve this plan in advance">
                <p>
                  Approving lets MOSS run these steps in a power cut without asking anyone. It&apos;s recorded as a standard change in your name. Enter a
                  code from your authenticator app to confirm.
                </p>
                <TextField label="Authenticator code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
              </ActionForm>
            ) : (
              <p>Someone who can approve changes needs to approve the plan before it can run without asking.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
