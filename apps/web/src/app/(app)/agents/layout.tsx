import type { ReactNode } from "react";
import { AgentsTabs } from "./tabs";

/** The section's tabs sit above every page in it, so they never move. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <AgentsTabs />
      {children}
    </>
  );
}
