import { ChatIntegrationPage } from "../chat/chat-page";

export const metadata = { title: "Discord" };

export default function DiscordPage() {
  return <ChatIntegrationPage platform="discord" />;
}
