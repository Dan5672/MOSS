// The MOSS integration for Home Assistant as a zip, for installs without HACS: unzip it into Home
// Assistant's config/custom_components folder. Built on the fly from the files in the image.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { crc32 } from "node:zlib";
import { requireUser } from "@/server/auth";
import { config } from "@/server/config";

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "__pycache__") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else out.push(p);
  }
  return out;
}

/** A plain zip (stored, not compressed): small files, and no dependency for it. */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    parts.push(local, fileName, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(fileName.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

export async function GET() {
  await requireUser();
  const root = join(dirname(config.libraryDir()), "custom_components");
  const paths = await files(join(root, "moss")).catch(() => []);
  if (!paths.length) return new Response("The Home Assistant integration isn't included in this install.", { status: 404 });
  const entries = await Promise.all(paths.sort().map(async (p) => ({ name: relative(root, p).split("\\").join("/"), data: await readFile(p) })));
  return new Response(new Uint8Array(zip(entries)), {
    headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="moss-home-assistant.zip"', "cache-control": "no-store" },
  });
}
