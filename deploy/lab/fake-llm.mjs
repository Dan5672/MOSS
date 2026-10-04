// Scripted OpenAI-compatible model for lab runs: plays a Network Admin that lists networks,
// scans the allowed subnet, tries the off-limits one, classifies the web server, and reports.
// It decides each step from the transcript, like a (very predictable) real model.
import { createServer } from "node:http";

const steps = [
  () => ({ tool: "networks_list", args: {} }),
  () => ({ tool: "nmap_scan", args: { targets: ["172.30.10.0/24"], profile: "top100" } }),
  () => ({ tool: "nmap_scan", args: { targets: ["172.30.66.0/24"], profile: "ping" } }),
  () => ({ tool: "inventory_search", args: { ip: "172.30.10.10" } }),
  (messages) => {
    const search = [...messages].reverse().find((m) => m.role === "tool");
    const [asset] = JSON.parse(search?.content ?? "[]");
    return asset
      ? { tool: "inventory_update", args: { assetId: asset.id, kind: "server", notes: "nginx web server (80/tcp open)", confidence: 85 } }
      : null;
  },
];

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
    const done = messages.filter((m) => m.role === "assistant").length;
    const tools = messages.filter((m) => m.role === "tool");
    const next = steps[done]?.(messages);
    const usage = { prompt_tokens: 1200 + 200 * done, completion_tokens: 60 };
    if (next) {
      return reply(res, {
        model: "lab-model",
        choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: `call_${done}`, type: "function", function: { name: next.tool, arguments: JSON.stringify(next.args) } }] } }],
        usage,
      });
    }
    const denied = tools.some((t) => t.content.includes("DENIED"));
    reply(res, {
      model: "lab-model",
      choices: [{ finish_reason: "stop", message: { content: `Scanned 172.30.10.0/24 and classified the nginx host as a server.${denied ? " 172.30.66.0/24 is off-limits, so I did not scan it." : ""}` } }],
      usage,
    });
  });
}).listen(8080, () => console.log("fake LLM listening on 8080"));
