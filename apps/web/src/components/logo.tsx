import { cn } from "@/lib/utils";
import { Mascot } from "./mascot";

/** The MOSS wordmark with the mascot: "horizontal" for the sidebar, "stacked" for sign-in and setup. */
export function Logo({ variant = "horizontal", className }: { variant?: "horizontal" | "stacked"; className?: string }) {
  if (variant === "stacked") {
    return (
      <div className={cn("flex flex-col items-center gap-4 text-center", className)}>
        <Mascot size={128} blink title="MOSS" />
        <div className="font-pixel text-[40px] leading-none text-ink dark:text-phosphor dark:[text-shadow:0_0_20px_rgb(77_255_154/0.3)]">MOSS</div>
        <div className="font-mono text-xs tracking-[2px] text-dim">YOUR AI IT DEPARTMENT · FLOOR B1</div>
      </div>
    );
  }
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Mascot size={48} title="MOSS" />
      <div className="flex flex-col gap-1.5">
        <span className="font-pixel text-xl leading-none tracking-[2px] text-ink dark:text-phosphor">MOSS</span>
        <span className="font-mono text-[11px] tracking-[1.5px] text-dim">B1 · IT DEPT</span>
      </div>
    </div>
  );
}
