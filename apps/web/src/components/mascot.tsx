import { BlinkingMascot } from "./mascot-blink";
import type { MascotVariant } from "./mascots";
import { MascotSvg } from "./mascot-svg";

export type { MascotVariant };

export interface MascotProps {
  /** "monitor" is the brand mascot; the others are for per-agent avatars. */
  variant?: MascotVariant;
  /** px, default 48. */
  size?: number;
  /** Colour of the sprite's glow pixels, default var(--glow) (phosphor). */
  glow?: string;
  blink?: boolean;
  className?: string;
  /** Accessible name; without it the mascot is aria-hidden. */
  title?: string;
}

/** The MOSS mascot: a 16×16 pixel sprite. Server-rendered; blinking adds a small client wrapper. */
export function Mascot({ blink = false, ...props }: MascotProps) {
  return blink ? <BlinkingMascot {...props} /> : <MascotSvg {...props} />;
}
