import { SectionTabs } from "@/components/section-tabs";

export const MONITORING_TABS = [
  { href: "/monitoring", label: "Monitors" },
  { href: "/monitoring/dashboards", label: "Dashboards" },
  { href: "/monitoring/logs", label: "Logs" },
  { href: "/monitoring/sources", label: "Webhook sources" },
] as const;

/** Sub-navigation for the Monitoring section (rendered by its layout). The map is there while dependencies are on. */
export const MonitoringTabs = ({ map = false }: { map?: boolean }) => (
  <SectionTabs label="Monitoring" tabs={map ? [...MONITORING_TABS.slice(0, 1), { href: "/monitoring/map", label: "Map" }, ...MONITORING_TABS.slice(1)] : MONITORING_TABS} />
);
