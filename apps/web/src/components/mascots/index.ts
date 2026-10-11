// The mascot registry. To add a mascot: add a file next to this one exporting { id, label, pal, map, blink },
// and add it to MASCOTS below. Everything else (the picker, validation, the sprite checks) picks it up.
// Shared by the Mascot component and scripts/build-icons.ts, so keep it free of React and DOM code.
import { beanie } from "./beanie";
import { cyborg } from "./cyborg";
import { goth } from "./goth";
import { headset } from "./headset";
import { monitor } from "./monitor";
import { nightshift } from "./nightshift";
import { oracle } from "./oracle";
import { ponytail } from "./ponytail";
import { specs } from "./specs";
import { suit } from "./suit";

export const MASCOTS = { monitor, beanie, headset, nightshift, ponytail, suit, goth, oracle, cyborg, specs } as const;

export type MascotVariant = keyof typeof MASCOTS;

/** The palette value meaning "the glow colour", filled in at render time. */
export const GLOW = "GLOW";

/** The brand mascot. */
export const DEFAULT_MASCOT: MascotVariant = "monitor";

export const MASCOT_IDS = Object.keys(MASCOTS) as MascotVariant[];

/** Whether a stored value names a mascot that still exists. */
export function isMascot(value: unknown): value is MascotVariant {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MASCOTS, value);
}

// --- Typecheck-time sprite validation, over every registry entry --------------------------------
// Each map must have 16 rows of exactly 16 characters, every character "." or a palette key, and the id
// must match its registry key. A bad sprite fails `tsc` with the mascot's name and the problem.
type Chars<S extends string> = S extends `${infer C}${infer R}` ? C | Chars<R> : never;
type Length<S extends string, Acc extends unknown[] = []> = S extends `${string}${infer R}` ? Length<R, [...Acc, 0]> : Acc["length"];
type Problem<K extends string, T extends { id: string; pal: object; map: readonly string[] }> = T["id"] extends K
  ? T["map"]["length"] extends 16
    ? [Length<T["map"][number]>] extends [16]
      ? [Chars<T["map"][number]>] extends [keyof T["pal"] | "."]
        ? never
        : [K, "a character is missing from the palette"]
      : [K, "a row is not 16 characters"]
    : [K, "the map is not 16 rows"]
  : [K, "the id doesn't match its registry key"];
type SpriteProblems = { [K in MascotVariant]: Problem<K, (typeof MASCOTS)[K]> }[MascotVariant];
const spritesAreValid: [SpriteProblems] extends [never] ? true : SpriteProblems = true;
void spritesAreValid;

export interface Pixel {
  x: number;
  y: number;
  color: string;
}

/** The sprite's opaque pixels, with "G" resolved to `glow` and the blink rule applied if `blinking`. */
export function spritePixels(variant: MascotVariant, glow: string, blinking = false): Pixel[] {
  const sprite = MASCOTS[variant];
  const pal = sprite.pal as Record<string, string>;
  const blink = sprite.blink as { row: number; from: string; to: string; cols?: readonly number[] };
  const pixels: Pixel[] = [];
  sprite.map.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      let key = ch;
      if (blinking && y === blink.row && ch === blink.from && (!blink.cols || blink.cols.includes(x))) key = blink.to;
      if (key === ".") return;
      const color = pal[key]!;
      pixels.push({ x, y, color: color === GLOW ? glow : color });
    });
  });
  return pixels;
}
