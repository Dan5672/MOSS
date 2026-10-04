// Scripted OpenAI-compatible model for lab runs, so the whole stack can be exercised without a
// paid API key. It picks a scenario from the task and decides each step from earlier tool
// results, like a (very predictable) real model.
import { createServer } from "node:http";

/** The parsed result of the most recent call to `tool` in the transcript. */
function resultOf(messages, tool) {
  const calls = new Map();
  for (const m of messages) for (const c of m.tool_calls ?? []) calls.set(c.id, c.function.name);
  const m = [...messages].reverse().find((x) => x.role === "tool" && calls.get(x.tool_call_id) === tool);
  if (!m) return null;
  try {
    return JSON.parse(m.content);
  } catch {
    return m.content;
  }
}

const scenarios = {
  // Network Admin: discover, get denied on the off-limits subnet, classify the web server.
  discovery: [
    () => ({ tool: "networks_list", args: {} }),
    () => ({ tool: "nmap_scan", args: { targets: ["172.30.10.0/24"], profile: "top100" } }),
    () => ({ tool: "nmap_scan", args: { targets: ["172.30.66.0/24"], profile: "ping" } }),
    () => ({ tool: "inventory_search", args: { ip: "172.30.10.10" } }),
    (m) => {
      const [asset] = resultOf(m, "inventory_search") ?? [];
      return { tool: "inventory_update", args: { assetId: asset.id, kind: "server", notes: "nginx web server (80/tcp open)", confidence: 85 } };
    },
    () => ({ text: "Scanned 172.30.10.0/24 and classified the nginx host as a server. 172.30.66.0/24 is off-limits, so I did not scan it." }),
  ],
  // Owner reports a powered-off device: raise an incident and a change to wake it, then wait.
  wake: [
    () => ({ tool: "inventory_search", args: { ip: "172.30.10.11" } }),
    (m) => {
      const [asset] = resultOf(m, "inventory_search") ?? [];
      return {
        tool: "incident_create",
        args: { type: "break_fix", title: "Database host is powered off", description: "Owner reports the database host is off.", priority: "P3", assetIds: [asset.id] },
      };
    },
    (m) => {
      const [asset] = resultOf(m, "inventory_search");
      return {
        tool: "change_request_create",
        args: {
          type: "normal",
          title: "Wake the database host with Wake-on-LAN",
          description: `Send a magic packet to ${asset.mac} on 172.30.10.0/24.`,
          risk: "low",
          plannedCalls: [{ tool: "wake_on_lan", args: { mac: asset.mac, broadcast: "172.30.10.255" } }],
          rollbackPlan: "None needed; powering on is not destructive.",
          verificationPlan: "ping 172.30.10.11 responds",
          incidentId: resultOf(m, "incident_create").id,
          assetIds: [asset.id],
        },
      };
    },
    (m) => ({ text: `Raised ${resultOf(m, "change_request_create").ref}; it is waiting for approval.` }),
  ],
  // Change approved: read it, execute exactly the plan, verify, close out, resolve the incident.
  approved: [
    (m, changeId) => ({ tool: "change_get", args: { changeId } }),
    (m, changeId) => ({ tool: "change_execute", args: { changeId } }),
    () => ({ tool: "ping", args: { target: "172.30.10.11", count: 2 } }),
    (m, changeId) => {
      const ok = resultOf(m, "ping")?.received > 0;
      return { tool: "change_complete", args: { changeId, outcome: ok ? "succeeded" : "failed", notes: ok ? "Host answers ping." : "Host still not answering." } };
    },
    (m) => {
      const incidentId = resultOf(m, "change_get").incidentId;
      return resultOf(m, "change_complete")?.status === "succeeded"
        ? { tool: "incident_update", args: { incidentId, status: "resolved", note: "Woken via Wake-on-LAN under the approved change; ping verified." } }
        : { tool: "incident_comment", args: { incidentId, body: "Sent the Wake-on-LAN packet, but the host did not answer ping. Leaving this open for a human." } };
    },
    (m) =>
      resultOf(m, "incident_update")?.status === "resolved"
        ? { text: "Executed the approved change, verified the host answers ping, and resolved the incident." }
        : { text: "Executed the approved change, but verification failed; the incident stays open for a human." },
  ],
};

function pickScenario(task) {
  if (/has been approved/.test(task)) return "approved";
  if (/powered off|wake/i.test(task)) return "wake";
  return "discovery";
}

function reply(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url.endsWith("/models")) return reply(res, { data: [{ id: "lab-model" }] });
    const { messages } = JSON.parse(raw || "{}");
    const task = messages.find((m) => m.role === "user")?.content ?? "";
    const changeId = /\(id ([0-9a-f-]{36})\)/.exec(task)?.[1];
    const done = messages.filter((m) => m.role === "assistant").length;
    const next = scenarios[pickScenario(task)][done]?.(messages, changeId) ?? { text: "Done." };
    const usage = { prompt_tokens: 1200 + 200 * done, completion_tokens: 60 };
    if (next.tool) {
      return reply(res, {
        model: "lab-model",
        choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: `call_${done}`, type: "function", function: { name: next.tool, arguments: JSON.stringify(next.args) } }] } }],
        usage,
      });
    }
    reply(res, { model: "lab-model", choices: [{ finish_reason: "stop", message: { content: next.text } }], usage });
  });
}).listen(8080, () => console.log("fake LLM listening on 8080"));
