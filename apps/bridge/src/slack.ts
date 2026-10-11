// A Slack app over Socket Mode: MOSS opens the connection (with the app-level token), so nothing has to reach it from
// the internet, as with Telegram and Discord. Direct messages to the app and its button presses come in on the
// socket and are acknowledged; messages go out with the bot token. Only DMs count: messages in channels are ignored.
import { BotApiError, type Bot, type BotHandlers, type Fetch } from "./types.js";

const API = "https://slack.com/api";

type Envelope = { envelope_id?: string; type?: string; reason?: string; payload?: Record<string, unknown> };

/** Slack treats a leading "/" as a slash command, so people type "link CODE" or "agents": these become MOSS's commands. */
export function slackCommand(text: string): string {
  const t = text.trim();
  return /^(link|agents?|help|start)\b/i.test(t) ? `/${t}` : t;
}

/** MOSS's text (Markdown-ish) as Slack mrkdwn: escaped, **bold** as *bold*, [text](url) as <url|text>. */
export function toMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>");
}

export class SlackBot implements Bot {
  private ws: WebSocket | null = null;
  private stopped = false;

  constructor(
    private readonly botToken: string,
    private readonly appToken: string,
    private readonly handlers: BotHandlers,
    private readonly fetchImpl: Fetch = fetch,
    private readonly openSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}

  private async api<T extends Record<string, unknown>>(method: string, token: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
    if (!res.ok || json.ok !== true) {
      const error = json.error ?? `HTTP ${res.status}`;
      throw new BotApiError(`Slack: ${error}`, /invalid_auth|not_authed|token_revoked|account_inactive/.test(error) ? 401 : res.status);
    }
    return json;
  }

  start() {
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  private async connect() {
    if (this.stopped) return;
    try {
      const { url } = await this.api<{ url: string }>("apps.connections.open", this.appToken);
      const ws = this.openSocket(url);
      this.ws = ws;
      ws.addEventListener("message", (e) => void this.onFrame(String((e as MessageEvent).data)));
      ws.addEventListener("close", () => {
        if (!this.stopped) setTimeout(() => void this.connect(), 5000);
      });
    } catch (err) {
      if (err instanceof BotApiError && err.status === 401) {
        this.handlers.log("slack rejected the app-level token; stopping", {});
        return;
      }
      this.handlers.log("slack connection failed", { error: (err as Error).message });
      setTimeout(() => void this.connect(), 10_000);
    }
  }

  /** One Socket Mode envelope; exported for tests. Acknowledged first, as Slack expects within 3 seconds. */
  async onFrame(raw: string) {
    const env = JSON.parse(raw) as Envelope;
    if (env.envelope_id) this.ws?.send(JSON.stringify({ envelope_id: env.envelope_id }));
    if (env.type === "disconnect") return this.ws?.close(); // Slack asks for a fresh connection now and then
    try {
      if (env.type === "events_api") await this.onEvent((env.payload?.event ?? {}) as Record<string, unknown>);
      if (env.type === "interactive") await this.onInteraction(env.payload ?? {});
    } catch (err) {
      this.handlers.log("slack event failed", { error: (err as Error).message });
    }
  }

  private async onEvent(e: Record<string, unknown>) {
    // Only people's own direct messages: not the bot's, not edits or joins, not channels.
    if (e.type !== "message" || e.channel_type !== "im" || e.bot_id || e.subtype || typeof e.user !== "string" || typeof e.text !== "string") return;
    const chatId = String(e.channel);
    for (const reply of await this.handlers.message({ externalUserId: e.user, chatId, text: slackCommand(e.text) })) await this.send(chatId, reply);
  }

  private async onInteraction(p: Record<string, unknown>) {
    if (p.type !== "block_actions") return;
    const user = p.user as { id?: string } | undefined;
    const action = (p.actions as { value?: string }[] | undefined)?.[0];
    if (!user?.id || !action?.value) return;
    const result = await this.handlers.button({ externalUserId: user.id, data: action.value });
    const before = (p.message as { text?: string } | undefined)?.text ?? "";
    // Update the message: what it said, the result, and no buttons.
    const url = typeof p.response_url === "string" && p.response_url.startsWith("https://hooks.slack.com/") ? p.response_url : null;
    if (url) {
      await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ replace_original: true, text: `${before}\n\n${toMrkdwn(result)}`.slice(0, 3000) }),
        signal: AbortSignal.timeout(20_000),
      });
    }
  }

  async send(chatId: string, text: string, buttons: { label: string; data: string }[] = []) {
    const body = toMrkdwn(text).slice(0, 3000);
    await this.api("chat.postMessage", this.botToken, {
      channel: chatId,
      text: body,
      unfurl_links: false,
      ...(buttons.length
        ? {
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: body } },
              {
                type: "actions",
                elements: buttons.map((b, i) => ({ type: "button", action_id: `moss_${i}`, text: { type: "plain_text", text: b.label }, value: b.data.slice(0, 2000), style: /reject/i.test(b.label) ? "danger" : "primary" })),
              },
            ],
          }
        : {}),
    });
  }
}
