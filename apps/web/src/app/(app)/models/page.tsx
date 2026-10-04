import { models, providers } from "@moss/db";
import { KNOWN_PRICING } from "@moss/llm";
import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { SelectField, TextField } from "@/components/field";
import { Empty, PageHeader, Section } from "@/components/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { addModelAction, addProviderAction, toggleModelAction } from "./actions";

export const metadata = { title: "Models" };

const KINDS = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "openai_compatible", label: "Other OpenAI-compatible" },
];

export default async function ModelsPage() {
  const user = await requireUser();
  const [providerRows, modelRows] = await Promise.all([
    db().select().from(providers).where(eq(providers.orgId, user.orgId)),
    db().select().from(models).where(eq(models.orgId, user.orgId)),
  ]);
  const canManage = user.permissions.has("models.manage");
  const providerName = (id: string) => providerRows.find((p) => p.id === id)?.name ?? "?";

  return (
    <>
      <PageHeader
        title="Models"
        description="The LLM providers and models your agents can use. API keys are encrypted by the gate and are never shown again."
      />
      <div className="space-y-8">
        <Section title="Models">
          {modelRows.length === 0 ? (
            <Empty>No models yet. Add a provider, then a model.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">$ / 1M input</TableHead>
                  <TableHead className="text-right">$ / 1M output</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {modelRows.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="font-medium">{m.displayName}</div>
                      <div className="font-mono text-xs text-muted-foreground">{m.modelId}</div>
                    </TableCell>
                    <TableCell className="text-sm">{providerName(m.providerId)}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(m.inputPricePerMTok).toFixed(2)}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(m.outputPricePerMTok).toFixed(2)}</TableCell>
                    <TableCell className="text-right">
                      {!m.enabled && <Pill className="mr-2">disabled</Pill>}
                      {canManage && (
                        <ActionForm action={toggleModelAction.bind(null, m.id, !m.enabled)} submitLabel={m.enabled ? "Disable" : "Enable"} submitVariant="outline" />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>

        {canManage && (
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Add a provider</CardTitle>
                <CardDescription>For Ollama, use the address of your Ollama server, e.g. http://192.168.1.20:11434/v1.</CardDescription>
              </CardHeader>
              <CardContent>
                <ActionForm action={addProviderAction} submitLabel="Add provider" resetOnSuccess>
                  <SelectField label="Type" name="kind" options={KINDS} />
                  <TextField label="Name" name="name" placeholder="Claude" required />
                  <TextField label="Base URL (optional for hosted providers)" name="baseUrl" type="url" />
                  <TextField label="API key" name="apiKey" type="password" autoComplete="off" hint="Not needed for Ollama." />
                </ActionForm>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Add a model</CardTitle>
                <CardDescription>Prices are filled in automatically for known Claude models; you can override them.</CardDescription>
              </CardHeader>
              <CardContent>
                {providerRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Add a provider first.</p>
                ) : (
                  <ActionForm action={addModelAction} submitLabel="Add model" resetOnSuccess>
                    <SelectField label="Provider" name="providerId" options={providerRows.map((p) => ({ value: p.id, label: p.name }))} />
                    <TextField label="Model ID" name="modelId" list="known-models" placeholder="claude-opus-5-5" required />
                    <datalist id="known-models">
                      {Object.keys(KNOWN_PRICING).map((id) => (
                        <option key={id} value={id} />
                      ))}
                    </datalist>
                    <TextField label="Display name" name="displayName" placeholder="Claude Opus 5.5" />
                    <div className="grid grid-cols-2 gap-2">
                      <TextField label="$ / 1M input" name="inputPrice" type="number" step="any" min="0" />
                      <TextField label="$ / 1M output" name="outputPrice" type="number" step="any" min="0" />
                    </div>
                  </ActionForm>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        <Section title="Providers">
          {providerRows.length === 0 ? (
            <Empty>No providers yet.</Empty>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {providerRows.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 p-3">
                  <span>
                    <span className="font-medium">{p.name}</span> <span className="text-muted-foreground">({p.kind})</span>
                    {p.baseUrl && <span className="ml-2 font-mono text-xs text-muted-foreground">{p.baseUrl}</span>}
                  </span>
                  <Pill tone={p.apiKeySecretId ? "green" : "gray"}>{p.apiKeySecretId ? "key stored" : "no key"}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
