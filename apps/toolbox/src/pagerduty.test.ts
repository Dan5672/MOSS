// PagerDuty against stand-in APIs.
import { describe, expect, it } from "vitest";
import { pagerdutyChange, pagerdutyEvent, pagerdutyIncidents } from "./pagerduty.js";

function api(status: number, body: unknown) {
  const calls: { url: string; body?: unknown; headers?: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers });
    return { status, json: async () => body };
  };
  return { fetchImpl, calls };
}

const ID = "3f6a1d2e-4b5c-4d6e-8f70-112233445566";

describe("PagerDuty", () => {
  it("triggers a page keyed by the MOSS incident, and resolves it by the same key", async () => {
    const { fetchImpl, calls } = api(202, { status: "success", dedup_key: ID });
    expect(await pagerdutyEvent({ routingKey: "R".repeat(32), action: "trigger", dedupKey: ID, summary: "INC-0007 NAS web is down", severity: "critical", source: "MOSS", timeoutMs: 5000 }, fetchImpl)).toEqual({ status: "success", dedupKey: ID });
    expect(calls[0]).toMatchObject({
      url: "https://events.pagerduty.com/v2/enqueue",
      body: { routing_key: "R".repeat(32), event_action: "trigger", dedup_key: ID, payload: { summary: "INC-0007 NAS web is down", source: "MOSS", severity: "critical" } },
    });
    await pagerdutyEvent({ routingKey: "R".repeat(32), action: "resolve", dedupKey: ID, severity: "error", source: "MOSS", timeoutMs: 5000 }, fetchImpl);
    expect(calls[1]!.body).toEqual({ routing_key: "R".repeat(32), event_action: "resolve", dedup_key: ID });
  });

  it("tests with a change event, and says why PagerDuty refused", async () => {
    const ok = api(202, { status: "success" });
    await pagerdutyChange({ routingKey: "R".repeat(32), summary: "MOSS connected", timeoutMs: 5000 }, ok.fetchImpl);
    expect(ok.calls[0]!.url).toBe("https://events.pagerduty.com/v2/change/enqueue");
    await expect(pagerdutyChange({ routingKey: "bad", summary: "x", timeoutMs: 5000 }, api(400, { status: "invalid event", errors: ["Invalid routing key"] }).fetchImpl)).rejects.toThrow("PagerDuty refused the event: Invalid routing key");
  });

  it("reads who acknowledged or resolved each page", async () => {
    const { fetchImpl, calls } = api(200, {
      incidents: [
        { id: "P1", incident_key: ID, status: "acknowledged", acknowledgements: [{ acknowledger: { summary: "Dana Owner" } }], html_url: "https://acme.pagerduty.com/incidents/P1" },
        { id: "P2", incident_key: "other", status: "resolved", last_status_change_by: { summary: "Sam" } },
      ],
    });
    expect((await pagerdutyIncidents({ apiKey: "k", timeoutMs: 5000 }, fetchImpl)).incidents).toEqual([
      { id: "P1", key: ID, status: "acknowledged", by: "Dana Owner", at: undefined, url: "https://acme.pagerduty.com/incidents/P1" },
      { id: "P2", key: "other", status: "resolved", by: "Sam", at: undefined, url: undefined },
    ]);
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Token token=k", Accept: "application/vnd.pagerduty+json;version=2" });
  });
});
