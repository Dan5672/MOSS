import { SectionTabs } from "@/components/section-tabs";

export const MONITORING_TABS = [
  { href: "/monitoring", label: "Monitors" },
  { href: "/monitoring/dashboards", label: "Dashboards" },
  { href: "/monitoring/sources", label: "Webhook sources" },
] as const;

/** Sub-navigation for the Monitoring section (rendered by its layout). */
export const MonitoringTabs = () => <SectionTabs label="Monitoring" tabs={MONITORING_TABS} />;
