import { getSetting, HA_SELF_HEAL_AGENT_TOOLS, HA_TOKEN_SECRET, listIntegrationTokens } from "@moss/core";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { CheckboxField, SelectField, TextField } from "@/components/field";
import { NoPermission, PageHeader, timeAgo } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeCron } from "@/lib/schedule";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { blockedByRole, homeAssistantPage } from "@/server/home-assistant";
import {
  revokeHomeAssistantTokenAction,
  saveHomeAssistantConnectionAction,
  saveHomeAssistantLogReviewAction,
  saveHomeAssistantNotifyAction,
  saveHomeAssistantSelfHealAction,
  saveHomeAssistantSimpleAction,
  setHomeAssistantAllowResumeAction,
  setHomeAssistantEnabledAction,
  syncHomeAssistantInventoryAction,
  testHomeAssistantAction,
} from "../actions";
import { AlertsForm } from "./alerts-form";
import { TokenForm } from "./token-form";

export const metadata = { title: "Home Assistant" };

const LOG_REVIEW_TOOLS = ["incident_create", "incident_list", "incident_comment", "kb_search", "kb_write"];

/** The address this browser used to reach MOSS, so the webhook URL is one that resolves on the LAN. */
async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (process.env.MOSS_SECURE_COOKIES === "true" ? "https" : "http");
  return `${proto}://${host}`;
}

function Feature({ id, title, on, description, children }: { id: string; title: string; on: boolean; description: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title} <Badge variant={on ? "default" : "outline"}>{on ? "On" : "Off"}</Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  );
}

function RoleWarning({ agent, tools }: { agent: string; tools: string[] }) {
  if (!tools.length) return null;
  return (
    <p className="border-2 border-amber bg-amber/10 p-2 text-sm">
      {agent}&apos;s role doesn&apos;t allow {tools.join(", ")}, so it can&apos;t finish this job. Give it a role with those permissions on its agent page.
    </p>
  );
}

export default async function HomeAssistantModulePage() {
  const user = await requireUser();
  if (!user.permissions.has("integrations.manage")) return <NoPermission />;
  const [p, base, tokens, allowResume] = await Promise.all([
    homeAssistantPage(user.orgId),
    baseUrl(),
    listIntegrationTokens(db(), user.orgId),
    getSetting(db(), user.orgId, "homeassistant.allow_resume"),
  ]);
  const c = p.config;
  const s = p.state;
  const agentOptions = p.agents.map((a) => ({ value: a.id, label: `${a.name} (${a.title})` }));
  const agentById = new Map(p.agents.map((a) => [a.id, a]));
  const healAgent = c.selfHeal.agentId ? agentById.get(c.selfHeal.agentId) : undefined;
  const logAgent = c.logReview.agentId ? agentById.get(c.logReview.agentId) : undefined;
  const [healBlocked, logBlocked] = await Promise.all([
    healAgent && c.selfHeal.enabled ? blockedByRole(healAgent.roleId, HA_SELF_HEAL_AGENT_TOOLS) : [],
    logAgent && c.logReview.enabled ? blockedByRole(logAgent.roleId, LOG_REVIEW_TOOLS) : [],
  ]);
  const connected = !!c.host && !!p.token;
  const off = !p.enabled;

  return (
    <>
      <PageHeader
        title="Home Assistant"
        description="Let MOSS and your Home Assistant work together. Each feature below has its own switch; none of them runs while the integration is off."
        actions={
          <ActionForm
            action={setHomeAssistantEnabledAction.bind(null, !p.enabled)}
            submitLabel={p.enabled ? "Switch integration off" : "Switch integration on"}
            submitVariant={p.enabled ? "outline" : "default"}
            confirm={p.enabled ? "Switch the Home Assistant integration off? Health checks, sensors, notifications, self-heal and log review stop, and agents lose its tools." : undefined}
          />
        }
      />
      <p className="mb-4 text-sm">
        <Link href="/settings/integrations" className="underline underline-offset-2">
          Integrations
        </Link>{" "}
        / Home Assistant · <strong>{p.enabled ? "On" : "Off"}</strong>
      </p>
      {off && (
        <p role="status" className="mb-6 border-2 p-3 text-sm">
          The integration is off. You can set up the connection and test it first; nothing runs until you switch it on.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card id="connection" className="scroll-mt-6 lg:col-span-2">
          <CardHeader>
            <CardTitle>Connection</CardTitle>
            <CardDescription>
              Home Assistant must be on an allowed network. Create the token in Home Assistant: your profile, Security, Long-lived access tokens. An
              administrator&apos;s token lets MOSS also read integrations and the error log. It is stored encrypted as <code>secret:{HA_TOKEN_SECRET}</code>,
              usable only against this address.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <ActionForm action={saveHomeAssistantConnectionAction} submitLabel="Save connection" resetOnSuccess>
              <div className="grid gap-3 sm:grid-cols-4">
                <TextField label="Address" name="host" placeholder="10.0.0.20" defaultValue={c.host ?? ""} required />
                <TextField label="Port" name="port" type="number" min={1} max={65535} defaultValue={c.port} required />
                <SelectField label="Protocol" name="scheme" defaultValue={c.scheme} options={[{ value: "http", label: "http" }, { value: "https", label: "https" }]} />
                <div className="self-end pb-2">
                  <CheckboxField label="Verify TLS certificate" name="verifyTls" defaultChecked={c.verifyTls} />
                </div>
              </div>
              <TextField
                label="Access token"
                name="token"
                type="password"
                autoComplete="off"
                placeholder={p.token ? `Stored (updated ${timeAgo(p.token.lastRotatedAt)}). Paste a new one to replace it.` : "Paste a long-lived access token"}
              />
              <TextField
                label="MOSS address for links"
                name="mossUrl"
                placeholder={base}
                defaultValue={c.mossUrl ?? ""}
                hint="How your phone reaches MOSS, so a notification opens the incident. Optional."
              />
            </ActionForm>
            <div className="flex flex-wrap items-center gap-3 border-t-2 pt-4">
              <ActionForm action={testHomeAssistantAction} submitLabel="Test connection" submitVariant="outline" inline />
              {s.lastHealth && (
                <span className="text-sm text-muted-foreground">
                  Last health check {timeAgo(s.lastHealthAt)}: {s.lastHealth.ok ? s.lastHealth.message : <span className="text-destructive">{s.lastHealth.message}</span>}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          <Feature
            id="integration"
            title="MOSS in Home Assistant"
            on={tokens.length > 0}
            description="The other direction: an add-on you install in Home Assistant that shows MOSS there. Sensors for incidents, monitors, agents and spending, events for automations (like a new device joining the network), safe controls, Assist voice and the Basement card. It works whether or not the switch above is on."
          >
            <ol className="grid list-decimal gap-1.5 pl-5 text-sm">
              <li>
                Install the integration. With HACS: HACS, the three-dot menu, Custom repositories, add <code>https://github.com/Dan5672/MOSS</code> as an
                Integration, then install MOSS. Without HACS:{" "}
                <a href="/api/integrations/home-assistant.zip" className="underline underline-offset-2">
                  download it
                </a>{" "}
                and unzip it into Home Assistant&apos;s <code>config/custom_components</code> folder. Restart Home Assistant.
              </li>
              <li>Make a token below. It acts as you, so Home Assistant can never do more than you can.</li>
              <li>
                In Home Assistant: Settings, Devices &amp; services, Add integration, MOSS. Enter <code>{c.mossUrl || base}</code> and the token.
              </li>
            </ol>
            <TokenForm />
            {tokens.length > 0 && (
              <ul className="grid gap-2 text-sm" aria-label="Home Assistant tokens">
                {tokens.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 border-2 p-2">
                    <span>
                      <span className="font-medium">{t.name}</span> <span className="text-muted-foreground">made by {t.createdBy} {timeAgo(t.createdAt)}</span>
                      <span className="block font-mono text-xs text-dim">{t.lastUsedAt ? `last used ${timeAgo(t.lastUsedAt)}` : "not used yet"}</span>
                    </span>
                    <ActionForm action={revokeHomeAssistantTokenAction.bind(null, t.id)} submitLabel="Revoke" submitVariant="outline" confirm={`Revoke ${t.name}? Home Assistant stops working until you give it a new token.`} />
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-2 border-t-2 pt-4 text-sm">
              <p>
                Home Assistant can read MOSS, pause agents, put monitoring in maintenance mode, raise incidents, ask agents questions, check monitors and run
                recurring tasks. It can never approve changes or touch secrets, tools, networks or settings.
              </p>
              <ActionForm action={setHomeAssistantAllowResumeAction} submitLabel="Save" submitVariant="outline">
                <CheckboxField label="Let Home Assistant resume agents too (pausing is always allowed)" name="allowResume" defaultChecked={allowResume} />
              </ActionForm>
            </div>
          </Feature>
        </div>

        <div className="lg:col-span-2">
          <Feature
            id="alerts"
            title="Alerts and health checks"
            on={p.enabled && (c.alerts.enabled || c.health.enabled)}
            description="Home Assistant events and Home Assistant's own health become monitors in MOSS. A problem opens an incident for the responder."
          >
            <AlertsForm
              baseUrl={base}
              alerts={c.alerts.enabled}
              health={c.health.enabled}
              priority={p.source?.defaultPriority ?? "P3"}
              responder={p.source?.defaultResponderAgentId ?? ""}
              unavailableThreshold={c.health.unavailableThreshold}
              agents={agentOptions}
              hasSource={!!p.source && c.alerts.enabled}
            />
            {p.source && (
              <p className="text-sm text-muted-foreground">
                Webhook: <code className="break-all">{`${base}/api/hooks/monitoring/${p.source.id}`}</code>
                {p.source.lastReceivedAt ? ` · last event ${timeAgo(p.source.lastReceivedAt)}` : ""}.{" "}
                <Link href="/monitoring" className="underline underline-offset-2">
                  See the monitors
                </Link>
              </p>
            )}
          </Feature>
        </div>

        <Feature
          id="notify"
          title="Phone notifications"
          on={p.enabled && c.notify.enabled}
          description="New incidents are sent to your phone through the Home Assistant companion app."
        >
          <ActionForm action={saveHomeAssistantNotifyAction} submitLabel="Save notifications">
            <CheckboxField label="Send new incidents to my phone" name="enabled" defaultChecked={c.notify.enabled} />
            <TextField
              label="Notify services"
              name="services"
              placeholder="mobile_app_pixel_8"
              defaultValue={c.notify.services.join(", ")}
              hint="In Home Assistant: Developer tools, Actions, search notify.mobile_app. Separate several with commas."
            />
            <SelectField
              label="Send incidents of priority"
              name="minPriority"
              defaultValue={c.notify.minPriority}
              options={[
                { value: "P1", label: "P1 only" },
                { value: "P2", label: "P1 and P2" },
                { value: "P3", label: "P1 to P3" },
                { value: "P4", label: "All" },
              ]}
            />
          </ActionForm>
          {s.lastNotifyError && <p className="text-sm text-destructive">Last notification failed: {s.lastNotifyError}</p>}
        </Feature>

        <Feature
          id="sensors"
          title="MOSS status in Home Assistant"
          on={p.enabled && c.sensors.enabled}
          description="MOSS keeps a few entities up to date in Home Assistant, for your dashboards and automations (a hallway light that turns red when a monitor is down)."
        >
          <ActionForm action={saveHomeAssistantSimpleAction.bind(null, "sensors")} submitLabel="Save status sensors">
            <CheckboxField label="Publish MOSS's status" name="enabled" defaultChecked={c.sensors.enabled} />
          </ActionForm>
          <ul className="grid gap-1 font-mono text-xs">
            <li>sensor.moss_open_incidents (with highest_priority)</li>
            <li>sensor.moss_monitors_down (with the names of what is down)</li>
            <li>sensor.moss_changes_pending</li>
            <li>binary_sensor.moss_agents_paused</li>
          </ul>
          {s.lastPublishAt && <p className="text-sm text-muted-foreground">Last updated {timeAgo(s.lastPublishAt)}.</p>}
        </Feature>

        <Feature
          id="inventory"
          title="Inventory sync"
          on={p.enabled && c.inventory.enabled}
          description="Home Assistant's names, rooms, makers and models fill in your assets, matched by MAC or IP address. Runs daily. Names people gave assets, and locked assets, are kept."
        >
          <ActionForm action={saveHomeAssistantSimpleAction.bind(null, "inventory")} submitLabel="Save inventory sync">
            <CheckboxField label="Sync the inventory from Home Assistant" name="enabled" defaultChecked={c.inventory.enabled} />
          </ActionForm>
          {p.enabled && c.inventory.enabled && <ActionForm action={syncHomeAssistantInventoryAction} submitLabel="Sync now" submitVariant="outline" inline />}
          {s.lastInventory && (
            <p className="text-sm text-muted-foreground">
              Last sync {timeAgo(s.lastInventoryAt)}:{" "}
              {"error" in s.lastInventory ? (
                <span className="text-destructive">{s.lastInventory.error}</span>
              ) : (
                `${s.lastInventory.matched} matched, ${s.lastInventory.created} added, ${s.lastInventory.skipped} skipped.`
              )}
            </p>
          )}
        </Feature>

        <Feature
          id="self-heal"
          title="Internet self-heal"
          on={p.enabled && c.selfHeal.enabled}
          description="When the internet monitor has been down for a while, an agent power-cycles the modem's smart plug through a pre-approved change, then checks the connection came back."
        >
          <ActionForm action={saveHomeAssistantSelfHealAction} submitLabel="Save self-heal">
            <CheckboxField label="Power-cycle the modem automatically" name="enabled" defaultChecked={c.selfHeal.enabled} />
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                label="When this monitor is down"
                name="monitorId"
                defaultValue={c.selfHeal.monitorId ?? ""}
                options={[{ value: "", label: "Choose a monitor" }, ...p.monitors.map((m) => ({ value: m.id, label: m.name }))]}
              />
              <TextField label="For (minutes)" name="afterMinutes" type="number" min={1} max={120} defaultValue={c.selfHeal.afterMinutes} />
              <TextField label="Modem plug" name="entity" placeholder="switch.modem_plug" defaultValue={c.selfHeal.entity ?? ""} />
              <TextField label="Off for (seconds)" name="offSeconds" type="number" min={5} max={120} defaultValue={c.selfHeal.offSeconds} />
              <SelectField label="Agent that does it" name="agentId" defaultValue={c.selfHeal.agentId ?? ""} options={[{ value: "", label: "Choose an agent" }, ...agentOptions]} />
            </div>
            <p className="text-xs text-muted-foreground">
              Saving pre-approves exactly this power-cycle as a standard change, and gives the agent the plug, the token and the change and monitor tools it
              needs. It runs at most once per incident.
            </p>
          </ActionForm>
          {healAgent && <RoleWarning agent={healAgent.name} tools={healBlocked} />}
          {s.selfHealAt && <p className="text-sm text-muted-foreground">Last self-heal {timeAgo(s.selfHealAt)}.</p>}
        </Feature>

        <Feature
          id="log-review"
          title="Log review"
          on={p.enabled && c.logReview.enabled}
          description="Every day an agent reads Home Assistant's error log, compares it with what's normal for your home, and raises incidents for anything unusual."
        >
          <ActionForm action={saveHomeAssistantLogReviewAction} submitLabel="Save log review">
            <CheckboxField label="Review the log every day" name="enabled" defaultChecked={c.logReview.enabled} />
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="Agent" name="agentId" defaultValue={c.logReview.agentId ?? ""} options={[{ value: "", label: "Choose an agent" }, ...agentOptions]} />
              <SelectField
                label="At"
                name="hour"
                defaultValue={c.logReview.cron.split(" ")[1] ?? "7"}
                options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }))}
              />
            </div>
            <p className="text-xs text-muted-foreground">Saving gives the agent the Home Assistant skill and the token, and adds a recurring task to its page.</p>
          </ActionForm>
          {logAgent && <RoleWarning agent={logAgent.name} tools={logBlocked} />}
          {p.schedule && c.logReview.enabled && (
            <p className="text-sm text-muted-foreground">
              <Link href={`/agents/${p.schedule.agentId}`} className="underline underline-offset-2">
                {logAgent?.name ?? "The agent"}
              </Link>{" "}
              reviews it {describeCron(p.schedule.cron).toLowerCase()}.
            </p>
          )}
        </Feature>
      </div>
      {!connected && <p className="mt-6 text-sm text-muted-foreground">Set up the connection first: every feature needs it.</p>}
    </>
  );
}
