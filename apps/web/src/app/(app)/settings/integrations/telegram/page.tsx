import { ChatIntegrationPage } from "../chat/chat-page";

export const metadata = { title: "Telegram" };

export default function TelegramPage() {
  return <ChatIntegrationPage platform="telegram" />;
}
