// Performs a custom tool's request, already rendered by the gate. The toolbox re-validates it (it trusts
// nothing it is sent), connects only to the literal target IP, and bounds what comes back.
import { pickJson, type RenderedRequest } from "@moss/tools";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { clean } from "./parsers.js";

const MAX_BODY = 1024 * 1024;
const MAX_TEXT = 8 * 1024;

export interface CustomHttpResult {
  status: number;
  ok: boolean;
  contentType?: string;
  /** Parsed JSON (after pick, if the tool has one). */
  data?: unknown;
  /** The body as text, when it isn't JSON. Cleaned and truncated. */
  text?: string;
  truncated?: boolean;
}

export type RawRequest = (
  r: RenderedRequest,
  maxBytes?: number,
) => Promise<{ status: number; contentType?: string; body: Buffer; truncated: boolean; headers?: Record<string, string | string[] | undefined> }>;

export const sendRequest: RawRequest = (r, maxBytes = MAX_BODY) =>
  new Promise((resolve, reject) => {
    const send = r.scheme === "https" ? httpsRequest : httpRequest;
    const host = r.target.includes(":") ? `[${r.target}]` : r.target;
    const req = send(
      `${r.scheme}://${host}:${r.port}${r.path}`,
      {
        method: r.method,
        headers: { ...r.headers, ...(r.body !== undefined ? { "Content-Length": String(Buffer.byteLength(r.body)) } : {}) },
        timeout: r.timeoutMs,
        ...(r.scheme === "https" ? { rejectUnauthorized: r.verifyTls } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            res.destroy();
            resolve({ status: res.statusCode ?? 0, contentType: res.headers["content-type"], body: Buffer.concat(chunks), truncated, headers: res.headers });
          } else chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, contentType: res.headers["content-type"], body: Buffer.concat(chunks), truncated, headers: res.headers }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`No answer within ${r.timeoutMs} ms`)));
    req.on("error", reject);
    if (r.body !== undefined) req.write(r.body);
    req.end();
  });

export async function customHttp(r: RenderedRequest, send: RawRequest = sendRequest): Promise<CustomHttpResult> {
  const res = await send(r);
  const contentType = clean(res.contentType);
  const out: CustomHttpResult = { status: res.status, ok: res.status >= 200 && res.status < 300, contentType, ...(res.truncated ? { truncated: true } : {}) };
  const text = res.body.toString("utf8");
  let json: unknown;
  let isJson = false;
  if (!res.truncated && (/json/i.test(contentType ?? "") || /^\s*[[{]/.test(text))) {
    try {
      json = JSON.parse(text);
      isJson = true;
    } catch {
      // Not JSON after all; fall through to text.
    }
  }
  if (isJson) {
    out.data = r.pick ? pickJson(json, r.pick, r.maxItems) : json;
  } else {
    // eslint-disable-next-line no-control-regex
    const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
    out.text = cleaned.slice(0, MAX_TEXT);
    if (cleaned.length > MAX_TEXT) out.truncated = true;
  }
  return out;
}
