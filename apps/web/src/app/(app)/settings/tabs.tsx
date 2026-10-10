import { SectionTabs } from "@/components/section-tabs";

export const SETTINGS_TABS = [
  { href: "/settings", label: "General" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/secrets", label: "Secrets" },
  { href: "/settings/backups", label: "Backups" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/networks", label: "Networks" },
  { href: "/users", label: "Users" },
] as const;

/** Sub-navigation for Settings (rendered by the layouts of Settings, Networks and Users). */
export const SettingsTabs = () => <SectionTabs label="Settings" tabs={SETTINGS_TABS} />;
