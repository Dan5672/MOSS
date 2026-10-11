import { SectionTabs } from "@/components/section-tabs";

export const ACTIVITY_TABS = [
  { href: "/runs", label: "Agent activity" },
  { href: "/audit", label: "Audit log" },
] as const;

/** Sub-navigation for Activity: what agents did, and the audit log (rendered by the layouts). */
export const ActivityTabs = () => <SectionTabs label="Activity" tabs={ACTIVITY_TABS} />;
