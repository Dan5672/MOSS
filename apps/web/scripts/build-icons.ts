// Builds the app icons from the mascot sprite. Run manually after changing the sprite, and commit
// the output:  npx tsx apps/web/scripts/build-icons.ts
//
//   src/app/icon.svg        monitor sprite on a rounded #1a2420 tile, sprite at 75% of the tile
//   src/app/apple-icon.png  180×180, same composition
//   src/app/favicon.ico     16 and 32 px, nearest-neighbour
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { MASCOTS } from "../src/components/mascots";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/app");
const TILE = "#1a2420";
const GLOW = "#4dff9a";
const RADIUS = 0.22; // of the tile size
const SPRITE_SCALE = 0.75; // of the tile size

const sprite = MASCOTS.monitor;
const pal = sprite.pal as Record<string, string>;
const colorAt = (x: number, y: number): string | null => {
  const ch = sprite.map[y]![x]!;
  if (ch === ".") return null;
  return pal[ch] === "GLOW" ? GLOW : pal[ch]!;
};

// --- SVG ----------------------------------------------------------------------------------------
// A 64-unit tile: sprite pixels are 3 units, so the sprite is 48 units (75%) offset by 8.
function svg(): string {
  const unit = 3;
  const offset = (64 - 16 * unit) / 2;
  const rects: string[] = [];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const c = colorAt(x, y);
      if (c) rects.push(`<rect x="${offset + x * unit}" y="${offset + y * unit}" width="${unit}" height="${unit}" fill="${c}"/>`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" shape-rendering="crispEdges">` +
    `<rect width="64" height="64" rx="${64 * RADIUS}" fill="${TILE}"/>${rects.join("")}</svg>\n`
  );
}

// --- Raster -------------------------------------------------------------------------------------
type RGBA = [number, number, number, number];
const hex = (c: string): RGBA => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 255];

/** Samples the composition at each pixel centre (nearest neighbour), so sprite pixels stay hard-edged. */
function raster(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const r = size * RADIUS;
  const spriteSize = size * SPRITE_SCALE;
  const offset = (size - spriteSize) / 2;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = px + 0.5;
      const v = py + 0.5;
      // Outside the rounded tile: transparent.
      const cx = Math.min(Math.max(u, r), size - r);
      const cy = Math.min(Math.max(v, r), size - r);
      if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) continue;
      let color = hex(TILE);
      const sx = Math.floor(((u - offset) / spriteSize) * 16);
      const sy = Math.floor(((v - offset) / spriteSize) * 16);
      if (sx >= 0 && sx < 16 && sy >= 0 && sy < 16) {
        const c = colorAt(sx, sy);
        if (c) color = hex(c);
      }
      out.set(color, (py * size + px) * 4);
    }
  }
  return out;
}

function png(size: number): Buffer {
  const pixels = raster(size);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(rows, y * (size * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An .ico holding PNG images (supported by every current browser). */
function ico(sizes: number[]): Buffer {
  const images = sizes.map(png);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((size, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size % 256, 0);
    e.writeUInt8(size % 256, 1);
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(images[i]!.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i]!.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

writeFileSync(join(APP_DIR, "icon.svg"), svg());
writeFileSync(join(APP_DIR, "apple-icon.png"), png(180));
writeFileSync(join(APP_DIR, "favicon.ico"), ico([16, 32]));
console.log("Wrote icon.svg, apple-icon.png (180×180) and favicon.ico (16, 32) to src/app.");
