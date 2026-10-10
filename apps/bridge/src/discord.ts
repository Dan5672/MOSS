// A Discord bot: the gateway over WebSocket (Node's own client) for direct messages and button presses, and the
// REST API to send. Only DMs count; messages in servers the bot is in are ignored.
import { BotApiError, type Bot, type BotHandlers, type Fetch } from "./types.js";

const API = "https://discord.com/api/v10";
/** DIRECT_MESSAGES. DMs carry their text without the privileged message content intent. */
const INTENTS = 1 << 12;

type Dispatch = { op: number; t?: string | null; s?: number | null; d?: Record<string, unknown> | null };
type User = { id: string; username?: string; bot?: boolean };

export class DiscordBot implements Bot {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private seq: number | null = null;
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly handlers: BotHandlers,
    private readonly fetchImpl: Fetch = fetch,
    private readonly openSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new BotApiError(`Discord: ${text.slice(0, 200) || `HTTP ${res.status}`}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  start() {
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }

  private async connect() {
    if (this.stopped) return;
    try {
      const { url } = await this.api<{ url: string }>("GET", "/gateway/bot");
      const ws = this.openSocket(`${url}?v=10&encoding=json`);
      this.ws = ws;
      ws.addEventListener("message", (e) => void this.onFrame(String((e as MessageEvent).data)));
      ws.addEventListener("close", () => {
        if (this.heartbeat) clearInterval(this.heartbeat);
        if (!this.stopped) setTimeout(() => void this.connect(), 5000);
      });
    } catch (err) {
      if (err instanceof BotApiError && err.status === 401) {
        this.handlers.log("discord rejected the bot token; stopping", {});
        return;
      }
      this.handlers.log("discord connection failed", { error: (err as Error).message });
      setTimeout(() => void this.connect(), 10_000);
    }
  }

  private sendFrame(frame: unknown) {
    this.ws?.send(JSON.stringify(frame));
  }

  /** One gateway frame; exported for tests. */
  async onFrame(raw: string) {
    const f = JSON.parse(raw) as Dispatch;
    if (typeof f.s === "number") this.seq = f.s;
    if (f.op === 10) {
      const every = Number((f.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41_250);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.sendFrame({ op: 1, d: this.seq }), every);
      this.sendFrame({ op: 2, d: { token: this.token, intents: INTENTS, properties: { os: "linux", browser: "moss", device: "moss" } } });
      return;
    }
    if (f.op === 1) return this.sendFrame({ op: 1, d: this.seq });
    if (f.op === 7 || f.op === 9) return this.ws?.close(); // reconnect
    if (f.op !== 0 || !f.d) return;
    try {
      if (f.t === "MESSAGE_CREATE") await this.onMessage(f.d);
      if (f.t === "INTERACTION_CREATE") await this.onInteraction(f.d);
    } catch (err) {
      this.handlers.log("discord event failed", { error: (err as Error).message });
    }
  }

  private async onMessage(d: Record<string, unknown>) {
    const author = d.author as User | undefined;
    if (d.guild_id || !author || author.bot || typeof d.content !== "string") return;
    const chatId = String(d.channel_id);
    for (const reply of await this.handlers.message({ externalUserId: author.id, chatId, username: author.username, text: d.content })) await this.send(chatId, reply);
  }

  private async onInteraction(d: Record<string, unknown>) {
    if (d.type !== 3) return; // only button presses
    const user = (d.user ?? (d.member as { user?: User } | undefined)?.user) as User | undefined;
    const data = (d.data as { custom_id?: string } | undefined)?.custom_id;
    if (!user || !data) return;
    const result = await this.handlers.button({ externalUserId: user.id, data });
    const before = (d.message as { content?: string } | undefined)?.content ?? "";
    // Update the message: what it said, the result, and no buttons.
    await this.api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 7, data: { content: `${before}\n\n${result}`.slice(0, 2000), components: [] } });
  }

  async send(chatId: string, text: string, buttons: { label: string; data: string }[] = []) {
    await this.api("POST", `/channels/${chatId}/messages`, {
      content: text.slice(0, 2000),
      allowed_mentions: { parse: [] },
      ...(buttons.length
        ? { components: [{ type: 1, components: buttons.map((b) => ({ type: 2, style: /reject/i.test(b.label) ? 4 : 3, label: b.label, custom_id: b.data.slice(0, 100) })) }] }
        : {}),
    });
  }
}
