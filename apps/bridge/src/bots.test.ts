// The Telegram and Discord bots against stand-in APIs, and the bridge starting and stopping them.
import { describe, expect, it } from "vitest";
import { createBridge } from "./bridge.js";
import { DiscordBot } from "./discord.js";
import { SlackBot, slackCommand, toMrkdwn } from "./slack.js";
import { parseTelegramUpdate, TelegramBot } from "./telegram.js";
import type { Bot, BotHandlers } from "./types.js";

/** A stand-in for an HTTP API: answers by URL suffix and records every call. */
function api(routes: Record<string, unknown>) {
  const calls: { url: string; body: Record<string, unknown> | undefined }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => String(url).endsWith(k));
    const body = key ? routes[key] : { ok: false, description: "not found" };
    return new Response(JSON.stringify(body), { status: key ? 200 : 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const handlers = (over: Partial<BotHandlers> = {}): BotHandlers & { seen: unknown[] } => {
  const seen: unknown[] = [];
  return {
    seen,
    message: async (m) => (seen.push(m), [`echo: ${m.text}`]),
    button: async (b) => (seen.push(b), "Approved by Dana."),
    log: () => {},
    ...over,
  };
};

describe("Telegram", () => {
  it("only takes people's text in private chats, and button presses", () => {
    expect(parseTelegramUpdate({ update_id: 1, message: { chat: { id: 5, type: "private" }, from: { id: 42, username: "dana" }, text: "hi" } })).toEqual({
      message: { externalUserId: "42", chatId: "5", username: "dana", text: "hi" },
    });
    expect(parseTelegramUpdate({ update_id: 2, message: { chat: { id: -9, type: "group" }, from: { id: 42 }, text: "hi" } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 3, message: { chat: { id: 5, type: "private" }, from: { id: 7, is_bot: true }, text: "x" } })).toBeNull();
  });

  it("answers messages, and turns a button press into the result on the message", async () => {
    const { fetchImpl, calls } = api({
      "/getUpdates": {
        ok: true,
        result: [
          { update_id: 10, message: { chat: { id: 5, type: "private" }, from: { id: 42 }, text: "status?" } },
          { update_id: 11, callback_query: { id: "cb1", from: { id: 42 }, data: "approve:abc", message: { chat: { id: 5 }, message_id: 99, text: "CR-3 needs approval" } } },
        ],
      },
      "/sendMessage": { ok: true, result: {} },
      "/answerCallbackQuery": { ok: true, result: true },
      "/editMessageText": { ok: true, result: {} },
    });
    const h = handlers();
    const bot = new TelegramBot("123:secret", h, fetchImpl);
    await bot.poll();
    expect(calls.map((c) => c.url.replace("https://api.telegram.org/bot123:secret", ""))).toEqual(["/getUpdates", "/sendMessage", "/answerCallbackQuery", "/editMessageText"]);
    expect(calls[1]!.body).toMatchObject({ chat_id: "5", text: "echo: status?" });
    expect(calls[3]!.body).toEqual({ chat_id: 5, message_id: 99, text: "CR-3 needs approval\n\nApproved by Dana." });
    await bot.send("5", "CR-4 needs approval", [{ label: "Approve", data: "approve:x" }, { label: "Reject", data: "reject:x" }]);
    expect(calls.at(-1)!.body!.reply_markup).toEqual({ inline_keyboard: [[{ text: "Approve", callback_data: "approve:x" }, { text: "Reject", callback_data: "reject:x" }]] });
    // The next poll asks for what comes after.
    await bot.poll();
    expect(calls.at(-4)!.body).toMatchObject({ offset: 12 });
  });
});

describe("Discord", () => {
  it("identifies on hello, answers DMs only, and updates the message on a button press", async () => {
    const { fetchImpl, calls } = api({ "/channels/dm1/messages": { id: "m" }, "/callback": {} });
    const sent: unknown[] = [];
    const bot = new DiscordBot("bot-token", handlers(), fetchImpl);
    (bot as unknown as { ws: { send(x: string): void; close(): void } }).ws = { send: (x: string) => sent.push(JSON.parse(x)), close: () => {} };
    await bot.onFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
    expect(sent[0]).toMatchObject({ op: 2, d: { token: "bot-token", intents: 4096 } });
    bot.stop();

    await bot.onFrame(JSON.stringify({ op: 0, s: 3, t: "MESSAGE_CREATE", d: { channel_id: "dm1", content: "hi", author: { id: "77", username: "dana" } } }));
    await bot.onFrame(JSON.stringify({ op: 0, s: 4, t: "MESSAGE_CREATE", d: { guild_id: "g", channel_id: "c", content: "hi", author: { id: "77" } } }));
    await bot.onFrame(JSON.stringify({ op: 0, s: 5, t: "MESSAGE_CREATE", d: { channel_id: "dm1", content: "x", author: { id: "1", bot: true } } }));
    expect(calls.map((c) => c.url)).toEqual(["https://discord.com/api/v10/channels/dm1/messages"]);
    expect(calls[0]!.body).toMatchObject({ content: "echo: hi" });

    await bot.onFrame(JSON.stringify({ op: 0, t: "INTERACTION_CREATE", d: { id: "i1", token: "tok", type: 3, user: { id: "77" }, data: { custom_id: "approve:abc" }, message: { content: "CR-3 needs approval" } } }));
    expect(calls.at(-1)).toEqual({ url: "https://discord.com/api/v10/interactions/i1/tok/callback", body: { type: 7, data: { content: "CR-3 needs approval\n\nApproved by Dana.", components: [] } } });

    await bot.send("dm1", "CR-4 needs approval", [{ label: "Approve", data: "approve:x" }, { label: "Reject", data: "reject:x" }]);
    expect(calls.at(-1)!.body!.components).toEqual([{ type: 1, components: [{ type: 2, style: 3, label: "Approve", custom_id: "approve:x" }, { type: 2, style: 4, label: "Reject", custom_id: "reject:x" }] }]);
  });
});

describe("Slack", () => {
  it("turns typed commands into MOSS's, and MOSS's text into Slack's", async () => {
    expect([slackCommand("link AB12CD34"), slackCommand("agents"), slackCommand("agent Nina"), slackCommand("linked in?")]).toEqual(["/link AB12CD34", "/agents", "/agent Nina", "linked in?"]);
    expect(toMrkdwn("**CR-3** needs approval: [open it](https://moss.lan/changes/1) <now> & then")).toBe("*CR-3* needs approval: open it (<https://moss.lan/changes/1>) &lt;now&gt; &amp; then");
    expect(await new SlackBot("x", "y", handlers()).onFrame("not json")).toBeUndefined();
  });

  it("acknowledges every envelope, answers DMs only, and updates the message on a button press", async () => {
    const { fetchImpl, calls } = api({ "/chat.postMessage": { ok: true }, "/hooks.slack.com/actions/T1/1/abc": {} });
    const sent: unknown[] = [];
    const h = handlers();
    const bot = new SlackBot("xoxb-bot", "xapp-app", h, fetchImpl);
    Object.assign(bot as unknown as object, { teamId: "T1", ws: { send: (x: string) => sent.push(JSON.parse(x)), close: () => {} } });

    const event = (id: string, e: Record<string, unknown>, team = "T1") =>
      bot.onFrame(JSON.stringify({ envelope_id: id, type: "events_api", payload: { team_id: team, event: { type: "message", ...e } } }));
    await event("e1", { channel: "D1", channel_type: "im", user: "U7", text: "link AB12CD34" });
    await event("e2", { channel: "C1", channel_type: "channel", user: "U7", text: "hi" });
    await event("e3", { channel: "D1", channel_type: "im", bot_id: "B1", text: "echo" });
    await event("e4", { channel: "D1", channel_type: "im", user: "U7", subtype: "message_changed", text: "x" });
    // Another workspace the app is installed in: acknowledged, never acted on.
    await event("e5", { channel: "D9", channel_type: "im", user: "U9", text: "link AB12CD34" }, "T2");
    expect(sent).toEqual([{ envelope_id: "e1" }, { envelope_id: "e2" }, { envelope_id: "e3" }, { envelope_id: "e4" }, { envelope_id: "e5" }]);
    expect(h.seen).toEqual([{ externalUserId: "U7", chatId: "D1", text: "/link AB12CD34" }]);
    expect(calls).toEqual([{ url: "https://slack.com/api/chat.postMessage", body: { channel: "D1", text: "echo: /link AB12CD34", unfurl_links: false } }]);

    await bot.onFrame(
      JSON.stringify({
        envelope_id: "i1",
        type: "interactive",
        payload: { type: "block_actions", team: { id: "T1" }, user: { id: "U7" }, actions: [{ value: "approve:abc" }], response_url: "https://hooks.slack.com/actions/T1/1/abc", message: { text: "CR-3 needs approval" } },
      }),
    );
    expect(calls.at(-1)).toEqual({ url: "https://hooks.slack.com/actions/T1/1/abc", body: { replace_original: true, text: "CR-3 needs approval\n\nApproved by Dana." } });

    await bot.send("D1", "CR-4 needs approval", [{ label: "Approve", data: "approve:x" }, { label: "Reject", data: "reject:x" }]);
    expect(calls.at(-1)!.body!.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "CR-4 needs approval" } },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "moss_0", text: { type: "plain_text", text: "Approve" }, value: "approve:x", style: "primary" },
          { type: "button", action_id: "moss_1", text: { type: "plain_text", text: "Reject" }, value: "reject:x", style: "danger" },
        ],
      },
    ]);
  });

  it("says plainly when Slack refuses a message", async () => {
    const { fetchImpl } = api({ "/chat.postMessage": { ok: false, error: "channel_not_found" } });
    await expect(new SlackBot("xoxb", "xapp", handlers(), fetchImpl).send("D9", "hi")).rejects.toThrow("Slack: channel_not_found");
  });
});

describe("the bridge", () => {
  it("starts a bot per switched-on app, and restarts or stops them as tokens change", async () => {
    let creds = [{ orgId: "o1", platform: "telegram" as const, token: "t1" }];
    const events: string[] = [];
    const fake = (c: { platform: string; token: string }): Bot => ({ start: () => events.push(`start ${c.platform} ${c.token}`), stop: () => events.push(`stop ${c.platform} ${c.token}`), send: async () => {} });
    const bridge = createBridge({ db: {} as never, boss: { send: async () => null } as never, credentials: async () => creds, makeBot: fake, log: () => {} });
    await bridge.sync();
    await bridge.sync();
    creds = [{ orgId: "o1", platform: "telegram", token: "t2" }, { orgId: "o1", platform: "discord" as never, token: "d1" }];
    await bridge.sync();
    creds = [];
    await bridge.sync();
    expect(events).toEqual(["start telegram t1", "stop telegram t1", "start telegram t2", "start discord d1", "stop telegram t2", "stop discord d1"]);
  });
});
