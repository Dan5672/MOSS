// A Telegram bot over the Bot API: long polling (getUpdates), so nothing has to reach MOSS from the internet.
// Only private chats count; groups the bot is added to are ignored.
import { BotApiError, type Bot, type BotHandlers, type ChatButtonPress, type ChatMessage, type Fetch } from "./types.js";

const API = "https://api.telegram.org";

type Update = {
  update_id: number;
  message?: { chat: { id: number; type: string }; from?: { id: number; username?: string; is_bot?: boolean }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number }; message_id: number; text?: string } };
};

/** What an update is to MOSS: a person's message, a button press, or nothing. */
export function parseTelegramUpdate(u: Update): { message: ChatMessage } | { button: ChatButtonPress & { callbackId: string; chatId?: number; messageId?: number; text?: string } } | null {
  const m = u.message;
  if (m && m.chat.type === "private" && m.from && !m.from.is_bot && typeof m.text === "string") {
    return { message: { externalUserId: String(m.from.id), chatId: String(m.chat.id), username: m.from.username, text: m.text } };
  }
  const cb = u.callback_query;
  if (cb?.data) {
    return { button: { externalUserId: String(cb.from.id), data: cb.data, callbackId: cb.id, chatId: cb.message?.chat.id, messageId: cb.message?.message_id, text: cb.message?.text } };
  }
  return null;
}

export class TelegramBot implements Bot {
  private stopped = false;
  private offset = 0;
  private abort: AbortController | null = null;

  constructor(
    private readonly token: string,
    private readonly handlers: BotHandlers,
    private readonly fetchImpl: Fetch = fetch,
    private readonly pause = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async api<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !json.ok) throw new BotApiError(`Telegram: ${json.description ?? `HTTP ${res.status}`}`, res.status);
    return json.result as T;
  }

  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
  }

  /** One round of getUpdates and handling what came; exported for tests. */
  async poll() {
    this.abort = new AbortController();
    const timer = setTimeout(() => this.abort?.abort(), 35_000);
    try {
      const updates = await this.api<Update[]>("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, this.abort.signal);
      for (const u of updates) {
        this.offset = u.update_id + 1;
        await this.handle(u).catch((err) => this.handlers.log("telegram update failed", { error: (err as Error).message }));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async loop() {
    while (!this.stopped) {
      try {
        await this.poll();
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof BotApiError && err.status === 401) {
          this.handlers.log("telegram rejected the bot token; stopping", {});
          return;
        }
        this.handlers.log("telegram polling failed", { error: (err as Error).message });
        await this.pause(5000);
      }
    }
  }

  private async handle(u: Update) {
    const p = parseTelegramUpdate(u);
    if (!p) return;
    if ("message" in p) {
      for (const reply of await this.handlers.message(p.message)) await this.send(p.message.chatId, reply);
      return;
    }
    const result = await this.handlers.button(p.button);
    await this.api("answerCallbackQuery", { callback_query_id: p.button.callbackId, text: result.slice(0, 200) });
    // The message keeps what it said, with the result added and the buttons gone.
    if (p.button.chatId !== undefined && p.button.messageId !== undefined) {
      await this.api("editMessageText", { chat_id: p.button.chatId, message_id: p.button.messageId, text: `${p.button.text ?? ""}\n\n${result}`.slice(0, 4096) }).catch(() => {});
    }
  }

  async send(chatId: string, text: string, buttons: { label: string; data: string }[] = []) {
    await this.api("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 4096),
      disable_web_page_preview: true,
      ...(buttons.length ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: b.data.slice(0, 64) }))] } } : {}),
    });
  }
}
