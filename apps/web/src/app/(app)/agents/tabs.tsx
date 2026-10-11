import { SectionTabs } from "@/components/section-tabs";

export const AGENTS_TABS = [
  { href: "/agents", label: "Team" },
  { href: "/agents/models", label: "Models" },
  { href: "/agents/recurring", label: "Recurring tasks" },
  { href: "/agents/tools", label: "Tool access" },
  { href: "/agents/custom-tools", label: "Custom tools" },
] as const;

/** Sub-navigation for the Agents section (rendered by its layout). */
export const AgentsTabs = () => <SectionTabs label="Agents" tabs={AGENTS_TABS} />;
