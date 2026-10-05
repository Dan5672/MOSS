// Pixel data for the MOSS mascot: 16×16 sprites, one character per pixel, "." transparent.
// "G" in every palette is the glow colour, supplied at render time. Shared by the Mascot
// component and scripts/build-icons.ts, so keep this file free of React and DOM code.

export const GLOW = "GLOW";

export const SPRITES = {
  monitor: {
    pal: { K: "#14110f", B: "#e6dcc0", D: "#b3a88a", S: "#0e2a20", G: "GLOW", H: "#2b2b2b", C: "#3a5bd9", W: "#f5f1e6", R: "#e0483e" },
    blink: { row: 4, from: "G", to: "S" },
    map: [
      "..KKKKKKKKKKKK..", ".KBBBBBBBBBBBBK.", ".KBKKKKKKKKKKDK.", ".KBKSSSSSSSSKDK.",
      "HKBKSGGSSGGSKDKH", "HKBKSGGSSGGSKDKH", "HKBKSSSSSSSSKDKH", ".KBKSSGSSGSSKDK.",
      ".KBKSSSGGSSSKDK.", ".KBKKKKKKKKKKDK.", ".KBBBBBBBBBBGDK.", "..KKKKKKKKKKKK..",
      "......KDDK......", "..KCCCWRRWCCCK..", ".KCCCCCRRCCCCCK.", ".KCCCCCRRCCCCCK.",
    ],
  },
  beanie: {
    pal: { K: "#14110f", O: "#ff8a3d", P: "#c4561f", S: "#e0a77a", B: "#5a3a22", H: "#2b2b2b", T: "#3b4450", G: "GLOW" },
    blink: { row: 5, from: "K", to: "S", cols: [4, 11] },
    map: [
      "...KKKKKKKKKK...", "..KOOOOOOOOOOK..", ".KOOOOOOOOOOOOK.", ".KPPPPPPPPPPPPK.",
      ".KSSSSSSSSSSSSK.", "HKSSKSSSSSSKSSKH", "HKSSSSSSSSSSSSKH", "HKBSSSSSSSSSSBKH",
      ".KBBSSSSSSSSBBK.", ".KBBBBBKKBBBBBK.", "..KBBBBBBBBBBK..", "...KBBBBBBBBK...",
      "....KKKKKKKK....", "..KTTTTSSTTTTK..", ".KTTTTTTTTTTTTK.", ".KTTTTGTTTTTTTK.",
    ],
  },
  headset: {
    pal: { K: "#14110f", H: "#2a1d2e", S: "#8d5a3b", P: "#c2410c", M: "#5d6b66", J: "#1f7a6d", Y: "#ffd23f", W: "#f5f1e6", G: "GLOW" },
    blink: { row: 6, from: "K", to: "S", cols: [4, 5, 10, 11] },
    map: [
      "....KKKKKKKK....", "...KHHHHHHHHK...", "..KHHHHHHHHHHK..", ".KHHHHHHHHHHHHK.",
      ".KHHSSSSSSSSHHK.", ".KHSSSSSSSSSSHK.", "MKHSKKSSSSKKSHK.", "MKHSSSSSSSSSSHK.",
      "MKHSSSSSSSSSSHK.", ".MHHSSSPPSSSHHK.", "..MGHSSSSSSHHK..", "..KKHKSSSSKHKK..",
      "......KSSK......", "..KJJJJYYJJJJK..", ".KJJJJJYYJJJJJK.", ".KJJJJJWWJJJJJK.",
    ],
  },
  nightshift: {
    pal: { K: "#14110f", Q: "#34405a", S: "#f1c9a5", G: "GLOW", V: "#eafff3", W: "#e6dcc0" },
    blink: { row: 7, from: "V", to: "G" },
    map: [
      "....KKKKKKKK....", "...KQQQQQQQQK...", "..KQQQQQQQQQQK..", ".KQQQKKKKKKQQQK.",
      ".KQQKSSSSSSKQQK.", ".KQKSSSSSSSSKQK.", ".KQKGGGGGGGGKQK.", ".KQKGVGGGGVGKQK.",
      ".KQKSSSSSSSSKQK.", ".KQKSSSKKSSSKQK.", ".KQQKSSSSSSKQQK.", "..KQQKKKKKKQQK..",
      "..KQQQQQQQQQQK..", ".KQQQWQQQQWQQQK.", ".KQQQWQQQQWQQQK.", ".KQQQQQQQQQQQQK.",
    ],
  },
} as const;

export type MascotVariant = keyof typeof SPRITES;

// Typecheck-time sprite validation: every map has 16 rows of exactly 16 characters, and every
// character is "." or a key of that sprite's palette. A bad sprite fails `tsc`.
type Chars<S extends string> = S extends `${infer C}${infer R}` ? C | Chars<R> : never;
type Length<S extends string, Acc extends unknown[] = []> = S extends `${string}${infer R}` ? Length<R, [...Acc, 0]> : Acc["length"];
type ValidSprite<T extends { pal: object; map: readonly string[] }> = T["map"]["length"] extends 16
  ? [Length<T["map"][number]>] extends [16]
    ? [Chars<T["map"][number]>] extends [keyof T["pal"] | "."]
      ? true
      : "a character is missing from the palette"
    : "a row is not 16 characters"
  : "the map is not 16 rows";
const spritesAreValid: { [K in MascotVariant]: ValidSprite<(typeof SPRITES)[K]> } = { monitor: true, beanie: true, headset: true, nightshift: true };
void spritesAreValid;

export interface Pixel {
  x: number;
  y: number;
  color: string;
}

/** The sprite's opaque pixels, with "G" resolved to `glow` and the blink rule applied if `blinking`. */
export function spritePixels(variant: MascotVariant, glow: string, blinking = false): Pixel[] {
  const sprite = SPRITES[variant];
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
