import type { IncomingMessage } from "node:http";
import { TextDecoder } from "node:util";
import { MUTATION_BODY_MAX_BYTES } from "./protocol.js";
import { parseStrictJsonObject } from "./raw-json.js";

export const HTTP_LIMITS = Object.freeze({ urlBytes: 2_048, headerBytes: 16_384, headers: 64, bodyBytes: MUTATION_BODY_MAX_BYTES });
export type RequestFailure = { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };
export type RequestSuccess<T> = { readonly ok: true; readonly value: T };
export type RequestResult<T> = RequestFailure | RequestSuccess<T>;

export interface RequestSecurityContext { readonly host: string; readonly origin: string; readonly capability: string }
export interface ParsedUrl { readonly pathname: string; readonly searchParams: URLSearchParams }

export function validateRequestHead(request: IncomingMessage, security: RequestSecurityContext, mutation: boolean): RequestResult<ParsedUrl> {
  const rawUrl = request.url ?? "";
  if (Buffer.byteLength(rawUrl, "utf8") > HTTP_LIMITS.urlBytes || !rawUrl.startsWith("/") || rawUrl.startsWith("//") || /[\0\r\n]/.test(rawUrl)) return fail(400, "invalid-url", "The request URL is invalid.");
  if (request.rawHeaders.length / 2 > HTTP_LIMITS.headers || Buffer.byteLength(request.rawHeaders.join("\n"), "utf8") > HTTP_LIMITS.headerBytes) return fail(431, "headers-too-large", "Request headers are too large.");
  const duplicate = duplicateHeader(request.rawHeaders);
  if (duplicate) return fail(400, "duplicate-header", "Duplicate request headers are not allowed.");
  if (request.headers.host !== security.host) return fail(400, "invalid-host", "The request host is invalid.");
  let url: URL;
  try { url = new URL(rawUrl, security.origin); } catch { return fail(400, "invalid-url", "The request URL is invalid."); }
  if (url.origin !== security.origin || url.username || url.password || url.hash) return fail(400, "invalid-url", "The request URL is invalid.");
  if (url.pathname.startsWith("/api/")) {
    if (request.headers.authorization !== `Bearer ${security.capability}`) return fail(401, "unauthorized", "Authentication is required.");
    if (request.headers["x-pi-prompt-origin"] !== security.origin) return fail(403, "invalid-origin", "The request origin is invalid.");
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== security.origin) return fail(403, "invalid-origin", "The request origin is invalid.");
    if (mutation && origin !== security.origin) return fail(403, "origin-required", "Mutation requests require the same origin.");
  }
  return { ok: true, value: { pathname: url.pathname, searchParams: url.searchParams } };
}

export async function readStrictJsonBody(request: IncomingMessage): Promise<RequestResult<Readonly<Record<string, unknown>>>> {
  if (request.headers["content-encoding"] !== undefined || request.headers["transfer-encoding"] !== undefined) return fail(415, "encoding-not-supported", "Encoded request bodies are not supported.");
  const contentType = request.headers["content-type"];
  if (contentType !== "application/json") return fail(415, "unsupported-media-type", "Content-Type must be application/json.");
  const lengthHeader = request.headers["content-length"];
  if (typeof lengthHeader !== "string" || !/^(0|[1-9]\d*)$/.test(lengthHeader)) return fail(411, "length-required", "A valid Content-Length is required.");
  const declared = Number(lengthHeader);
  if (!Number.isSafeInteger(declared) || declared > HTTP_LIMITS.bodyBytes) return fail(413, "body-too-large", "The request body is too large.");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.length;
      if (total > HTTP_LIMITS.bodyBytes || total > declared) { request.resume(); return fail(413, "body-too-large", "The request body is too large."); }
      chunks.push(chunk);
    }
  } catch { return fail(400, "body-read-failed", "The request body could not be read."); }
  if (total !== declared) return fail(400, "length-mismatch", "The request body length is invalid.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return fail(400, "invalid-utf8", "The request body must be valid UTF-8."); }
  const parsed = parseStrictJsonObject(text, { maxBytes: HTTP_LIMITS.bodyBytes, maxDepth: 16 });
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    return fail(issue?.code === "json-too-large" ? 413 : 400, issue?.code ?? "invalid-json", issue?.message ?? "The request body is invalid.");
  }
  return { ok: true, value: parsed.value };
}

export function rejectUnexpectedBody(request: IncomingMessage): RequestFailure | null {
  if (request.headers["transfer-encoding"] !== undefined || request.headers["content-encoding"] !== undefined) return fail(400, "unexpected-body", "This request must not contain a body.");
  const length = request.headers["content-length"];
  if (length !== undefined && length !== "0") return fail(400, "unexpected-body", "This request must not contain a body.");
  return null;
}

const UNIQUE_HEADERS = new Set(["host", "authorization", "origin", "x-pi-prompt-origin", "if-match", "content-type", "content-length", "content-encoding", "transfer-encoding"]);
function duplicateHeader(rawHeaders: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    if (!name || !UNIQUE_HEADERS.has(name)) continue;
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return undefined;
}
function fail(status: number, code: string, message: string): RequestFailure { return { ok: false, status, code, message }; }
