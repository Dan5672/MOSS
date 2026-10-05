import { spritePixels, type MascotVariant } from "./mascot-sprites";

export interface MascotSvgProps {
  variant?: MascotVariant;
  /** Rendered size in px (the sprite is 16×16). */
  size?: number;
  /** Colour for the sprite's "G" pixels: a CSS colour or var(). */
  glow?: string;
  blinking?: boolean;
  className?: string;
  /** Accessible name. Without it the sprite is decorative. */
  title?: string;
}

/** The mascot as one inline SVG, one <rect> per pixel. Renders on the server or the client. */
export function MascotSvg({ variant = "monitor", size = 48, glow = "var(--glow)", blinking = false, className, title }: MascotSvgProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className}
      {...(title ? { role: "img" } : { "aria-hidden": true })}
    >
      {title && <title>{title}</title>}
      {spritePixels(variant, glow, blinking).map((p) => (
        // style rather than the fill attribute, so var() colours work.
        <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width={1} height={1} style={{ fill: p.color }} />
      ))}
    </svg>
  );
}
