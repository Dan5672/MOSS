import { ChatIntegrationPage } from "../chat/chat-page";

export const metadata = { title: "Slack" };

export default function SlackPage() {
  return <ChatIntegrationPage platform="slack" />;
}
