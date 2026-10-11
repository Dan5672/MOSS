"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createChatCodeAction } from "./integrations/chat/actions";

/** "Connect Telegram": a one-time code to send the bot, shown until it's used or runs out. */
export function ConnectChat({ platform, name }: { platform: "telegram" | "discord" | "slack"; name: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-2">
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await createChatCodeAction(platform);
            setError(r.error ?? "");
            setCode(r.code ?? null);
          })
        }
      >
        Connect {name}
      </Button>
      {code && (
        <p className="border-2 border-phosphor p-3 text-sm" role="status">
          {platform === "slack" ? "Send the MOSS app a direct message in Slack" : `Send your MOSS bot in ${name}`}:{" "}
          <code className="font-mono text-base font-semibold">
            {platform === "slack" ? "" : "/"}link {code}
          </code>
          <br />
          <span className="text-muted-foreground">The code works once, for 10 minutes.</span>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
