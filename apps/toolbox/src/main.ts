import { readFileSync } from "node:fs";
import { buildToolboxServer } from "./server.js";

const token = process.env.TOOLBOX_TOKEN_FILE ? readFileSync(process.env.TOOLBOX_TOKEN_FILE, "utf8").trim() : process.env.TOOLBOX_TOKEN;
if (!token) throw new Error("Set TOOLBOX_TOKEN or TOOLBOX_TOKEN_FILE");

const app = buildToolboxServer({ token, logger: true });
await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 7070) });
