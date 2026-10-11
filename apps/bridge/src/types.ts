// What each chat app's bot hands the bridge, and what the bridge asks it to send.
export interface ChatMessage {
  externalUserId: string;
  chatId: string;
  username?: string;
  text: string;
}

export interface ChatButtonPress {
  externalUserId: string;
  data: string;
}

export interface BotHandlers {
  /** A message from a person; returns what to say back. */
  message(m: ChatMessage): Promise<string[]>;
  /** A button press; returns the result to show on the message. */
  button(b: ChatButtonPress): Promise<string>;
  log(msg: string, extra?: Record<string, unknown>): void;
}

export interface Bot {
  start(): void;
  stop(): void;
  send(chatId: string, text: string, buttons?: { label: string; data: string }[]): Promise<void>;
}

export type Fetch = typeof fetch;

export class BotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
