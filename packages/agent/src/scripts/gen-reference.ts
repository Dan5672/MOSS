// Writes library/docs/reference.md from the code. Run: corepack pnpm gen:reference
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadLibrary } from "../library.js";
import { buildReference } from "../reference.js";

const libraryDir = fileURLToPath(new URL("../../../../library", import.meta.url));
const lib = await loadLibrary(libraryDir);
await writeFile(`${libraryDir}/docs/reference.md`, buildReference(lib));
console.log("Wrote library/docs/reference.md");
