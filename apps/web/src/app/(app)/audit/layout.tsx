import type { ReactNode } from "react";
import { ActivityTabs } from "../runs/tabs";

/** The section's tabs sit above every page in it, so they never move. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <ActivityTabs />
      {children}
    </>
  );
}
