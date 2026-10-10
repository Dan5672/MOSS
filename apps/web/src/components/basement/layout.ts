// The Basement scene's slots and sprites. Desks and spots are slots, not people: agents are matched to
// them at render time. Coordinates are on a fixed 1280×720 stage. Add entries to DESKS or SPOTS to make
// room for more agents; nothing else needs to change.

export interface Desk {
  x: number;
  top: number;
  /** Stacking order of the desk, and of the agent sitting at it. */
  z: number;
  cz: number;
  mess?: boolean;
  pizza?: boolean;
  mug?: boolean;
  mugColor?: string;
}

export interface Spot {
  x: number;
  y: number;
  z: number;
  bubble: string;
  /** What the agent is doing there, for the list under the scene. */
  text: string;
  mug?: boolean;
  pad?: boolean;
  book?: boolean;
  cable?: boolean;
  crt?: boolean;
}

/** Six desks in two staggered rows. */
export const DESKS: readonly Desk[] = [
  { x: 360, top: 540, z: 4, cz: 3, mess: true, mug: true, mugColor: "#e0483e" },
  { x: 560, top: 540, z: 4, cz: 3, pizza: true },
  { x: 760, top: 540, z: 4, cz: 3, mess: true },
  { x: 440, top: 625, z: 6, cz: 5, mug: true, mugColor: "#3a5bd9" },
  { x: 640, top: 625, z: 6, cz: 5, mess: true, mug: true, mugColor: "#f5f1e6" },
  { x: 840, top: 625, z: 6, cz: 5, pizza: true },
];

/** Six places to take a break. */
export const SPOTS: readonly Spot[] = [
  { x: 168, y: 610, z: 7, bubble: "pot #4…", text: "Brewing pot #4", mug: true },
  { x: 1094, y: 620, z: 7, bubble: "zZz", text: "Napping on the beanbag" },
  { x: 1182, y: 520, z: 3, bubble: "HI-SCORE 99,120", text: "Chasing a high score", pad: true },
  { x: 1064, y: 512, z: 3, bubble: "RFC 1149…", text: "Reading RFC 1149", book: true },
  { x: 236, y: 446, z: 3, bubble: "which one is prod?", text: "Untangling cables", cable: true },
  { x: 262, y: 628, z: 7, bubble: "it still works!", text: "Reviving an old CRT", crt: true },
];

/** FNV-1a over the id, offset by a per-visit seed so seats can change between visits. */
export function hash(str: string, seed = 0): number {
  let h = 2166136261 + seed * 7919;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Stable "random" seats: each id starts at its hashed slot and takes the next free one. Ids are seated in
 * order, so put whoever must get a slot (the alarm responder) first. Ids left over get no slot.
 */
export function assign(ids: string[], n: number, seed = 0): Record<string, number> {
  const taken: Record<number, string> = {};
  const out: Record<string, number> = {};
  ids.forEach((id) => {
    let i = hash(id, seed) % n;
    let tries = 0;
    while (taken[i] && tries < n) {
      i = (i + 1) % n;
      tries++;
    }
    if (!taken[i]) {
      taken[i] = id;
      out[id] = i;
    }
  });
  return out;
}

/** The desk fire: two 6×8 frames, alternated every 180 ms. */
export const FIRE_MAPS = [
  ["...R..", "..RR..", ".RYR.R", ".RYYRR", "RYWYYR", "RYWWYR", "RYYWYR", ".RRRR."],
  ["..R...", "..RR.R", "R.RYR.", "RRYYR.", "RYYWYR", "RYWWYR", "RYWYYR", ".RRRR."],
] as const;
export const FIRE_PALETTE: Record<string, string> = { R: "#ff5a2a", Y: "#ffb547", W: "#fff3b0", ".": "transparent" };

/** Widths (%) of the code lines scrolling on an occupied monitor; repeated twice for a seamless loop. */
const WIDTHS = [70, 45, 85, 30, 60, 90, 40, 75, 55, 35, 80, 50, 65, 25, 88, 42];
export const CODE_LINES = [...WIDTHS, ...WIDTHS];

/**
 * Rack and switch LED colours from a fixed pseudo-random sequence, so they don't jump on every refresh.
 * During an alarm about 12% of them are red.
 */
export function ledColours(alarm: boolean) {
  let r = 7;
  const rnd = () => {
    r = (r * 9301 + 49297) % 233280;
    return r / 233280;
  };
  const colour = () => {
    const v = rnd();
    if (alarm && v < 0.12) return "#ff3b2a";
    return v < 0.7 ? "#4dff9a" : v < 0.9 ? "#ffb547" : "#5ad8ff";
  };
  const racks = [30, 130, 230].map((x) => ({
    x,
    units: Array.from({ length: 12 }, () => Array.from({ length: 4 }, () => ({ c: colour(), d: Number((rnd() * 1.6).toFixed(2)) }))),
  }));
  const ports = Array.from({ length: 10 }, () => ({ c: colour(), d: Number((rnd() * 1.6).toFixed(2)) }));
  return { racks, ports };
}

/** A nameplate-sized version of an agent's name. */
export function shortName(name: string): string {
  return name.trim().split(/\s+/)[0]!.slice(0, 8).toUpperCase() || "AGENT";
}
