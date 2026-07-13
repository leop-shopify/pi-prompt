import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { PlanController, PlanControllerResult } from "./controller.js";
import { renderPlanMarkdown } from "./classification.js";
import { PLAN_LIMITS } from "./schema.js";
import { MAX_GRILL_RESULT_BYTES, MAX_WRITER_RESULT_BYTES } from "./session-files.js";
import type { WriterSubmissionKind } from "./generator.js";
import { EventLedger } from "./event-ledger.js";
import { readStrictJsonBody, rejectUnexpectedBody, validateRequestHead, type RequestFailure } from "./http-request.js";
import { PLAN_REVIEW_HTML } from "./html.js";
import {
  MAX_LONG_POLL_MS, mutationFingerprint, parseMutation, parseStateIfMatch, stateEtag, toPublicSnapshot,
  type MutationRequest, type PublicActivity, type PublicSnapshot, type RequestKind,
} from "./protocol.js";
import { ReplayLedger } from "./replay-ledger.js";
import type { SpecController } from "../spec/controller.js";
import { SPEC_LIMITS } from "../spec/schema.js";
import { parseSpecIfMatch, parseSpecMutation, specMutationFingerprint, specStateEtag, toPublicSpecSnapshot, type SpecMutation, type SpecRequestKind } from "../spec/protocol.js";

export const PLAN_SERVER_IDLE_MS = 30 * 60 * 1_000;
export const PLAN_SERVER_HOST = "127.0.0.1";
export const WRITER_SUBMISSION_PATH = "/api/v1/writer-results";
export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
});

interface ResponseRecord { readonly status: number; readonly body?: unknown; readonly headers?: Readonly<Record<string, string>>; readonly closeAfter?: "terminal" | "reopen" }
export interface PlanHttpHostOptions {
  readonly controller: PlanController;
  readonly reopenInPi: () => void | Promise<void>;
  readonly idleMs?: number;
  readonly longPollMs?: number;
  readonly maximumConnections?: number;
  readonly maximumRequestsPerMinute?: number;
  readonly capabilityFactory?: () => string;
  readonly activity?: () => PublicActivity | undefined;
  readonly planRoot?: string;
  /** Optional independent sidecar. No Spec result is ever routed through the Plan controller. */
  readonly specController?: SpecController;
  /** Lazily creates the sidecar after the current Plan has a Grill artifact. */
  readonly createSpecController?: () => Promise<SpecController | null>;
}
export interface PlanHttpHost {
  readonly port: number; readonly origin: string; readonly launchUrl: string;
  readonly closed: boolean;
  close(): Promise<void>;
}

const ASSETS = Object.freeze({
  "/browser/app.js": ["browser/app.js", "text/javascript; charset=utf-8"],
  "/browser/api.js": ["browser/api.js", "text/javascript; charset=utf-8"],
  "/browser/store.js": ["browser/store.js", "text/javascript; charset=utf-8"],
  "/browser/dom.js": ["browser/dom.js", "text/javascript; charset=utf-8"],
  "/browser/components.js": ["browser/components.js", "text/javascript; charset=utf-8"],
  "/browser/range.js": ["browser/range.js", "text/javascript; charset=utf-8"],
  "/browser/styles.css": ["browser/styles.css", "text/css; charset=utf-8"],
} as const);

export async function startPlanHttpHost(options: PlanHttpHostOptions): Promise<PlanHttpHost> {
  const idleMs = bounded(options.idleMs ?? PLAN_SERVER_IDLE_MS, 100, PLAN_SERVER_IDLE_MS);
  const longPollMs = bounded(options.longPollMs ?? MAX_LONG_POLL_MS, 1, MAX_LONG_POLL_MS);
  const maximumConnections = bounded(options.maximumConnections ?? 16, 1, 128);
  const maximumRequestsPerMinute = bounded(options.maximumRequestsPerMinute ?? 240, 1, 10_000);
  const capability = options.capabilityFactory?.() ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error("invalid-capability");
  const assetEntries = await Promise.all(Object.entries(ASSETS).map(async ([route, [relative, contentType]]) => {
    const content = await readFile(fileURLToPath(new URL(relative, import.meta.url)));
    return [route, { content, contentType }] as const;
  }));
  const assets = new Map(assetEntries);
  const events = new EventLedger(256, longPollMs);
  const specEvents = new EventLedger(256, longPollMs);
  const replay = new ReplayLedger<ResponseRecord>({
    capacity: 512,
    maximumInFlight: 64,
    maximumSettledWeight: 16 * 1024 * 1024,
    weight: responseRecordBytes,
  });
  const sockets = new Set<Socket>();
  const requestTimes: number[] = [];
  let activeRequests = 0;
  let closing = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let closeActionScheduled = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let mutationTail: Promise<void> = Promise.resolve();
  let host = "";
  let origin = "";
  let writerEndpoint = "";
  let activeSpecController = options.specController ?? null;
  let ownsSpecController = false;
  let specCreation: Promise<SpecController | null> | null = null;
  let unsubscribeSpec: () => void = () => undefined;

  const subscribeSpec = (controller: SpecController): void => {
    unsubscribeSpec();
    unsubscribeSpec = controller.subscribe((event) => {
      if (closing) return;
      specEvents.publish({ kind: event.kind, status: event.status, stateVersion: event.stateVersion, documentRevision: event.specRevision, ...(event.errorCode ? { errorCode: event.errorCode } : {}) });
    });
  };
  if (activeSpecController) subscribeSpec(activeSpecController);
  const ensureSpecController = async (): Promise<SpecController | null> => {
    if (closing) return null;
    if (activeSpecController) return activeSpecController;
    if (!options.createSpecController) return null;
    if (!specCreation) specCreation = options.createSpecController().then(async (controller) => {
      if (!controller) return null;
      if (closing) { await controller.close().catch(() => undefined); return null; }
      const configured = controller.configureWriterEndpoint(writerEndpoint);
      if (!configured.ok) { await controller.close().catch(() => undefined); return null; }
      activeSpecController = controller; ownsSpecController = true; subscribeSpec(controller); return controller;
    }).finally(() => { specCreation = null; });
    return specCreation;
  };

  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { void close(); }, idleMs);
    idleTimer.unref();
  };
  const unsubscribe = options.controller.subscribe((event) => {
    if (closing) return;
    events.publish({ kind: event.kind, status: event.status, stateVersion: event.stateVersion, documentRevision: event.documentRevision, ...(event.errorCode ? { errorCode: event.errorCode } : {}) });
  });
  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    unsubscribe(); unsubscribeSpec();
    events.close(); specEvents.close();
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const serverClose = new Promise<void>((resolve) => {
      let fallback: NodeJS.Timeout | null = null;
      server.close(() => { if (fallback) clearTimeout(fallback); resolve(); });
      server.closeIdleConnections?.();
      // Let already-dispatched replay-shared and queued-closing responses flush before the bounded fallback.
      fallback = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 250);
      fallback.unref();
    });
    const activeSpecClose = ownsSpecController && activeSpecController ? activeSpecController.close().catch(() => undefined) : Promise.resolve();
    const pendingSpecClose = specCreation?.catch(() => undefined) ?? Promise.resolve();
    closePromise = Promise.all([serverClose, activeSpecClose, pendingSpecClose]).then(() => { closed = true; replay.clear(); });
    return closePromise;
  };
  const scheduleClose = (disposition: NonNullable<ResponseRecord["closeAfter"]>): void => {
    if (closeActionScheduled) return;
    closeActionScheduled = true;
    const queued = mutationTail;
    void queued.then(() => new Promise<void>((resolve) => setImmediate(resolve))).then(async () => {
      if (disposition === "reopen") await close().then(options.reopenInPi, () => undefined);
      else await close();
    });
  };

  const server = createServer(async (request, response) => {
    activeRequests += 1;
    response.once("finish", () => { activeRequests -= 1; });
    response.once("close", () => { if (!response.writableFinished) activeRequests -= 1; });
    const method = request.method ?? "";
    const mutation = method === "POST" || method === "PATCH";
    if ((request.url ?? "").split("?", 1)[0] === WRITER_SUBMISSION_PATH) {
      try { await handleWriterSubmission(request, response); }
      catch { send(response, { status: 500, body: errorBody("internal-error", "The request could not be completed.") }); }
      return;
    }
    // Plan mutation duplicates already accepted by the HTTP stack retain their replay-shared
    // terminal response; Spec mutations enforce their stricter shutdown fence in routeSpec.
    if (closing && !mutation) { send(response, closingRecord()); return; }
    if (activeRequests > maximumConnections * 2) { send(response, { status: 429, body: errorBody("too-many-requests", "Too many requests are active.") }); return; }
    const head = validateRequestHead(request, { host, origin, capability }, mutation);
    if (!head.ok) { sendFailure(response, head); return; }
    if (head.value.pathname.startsWith("/api/")) {
      const now = Date.now();
      while (requestTimes[0] !== undefined && requestTimes[0] <= now - 60_000) requestTimes.shift();
      if (requestTimes.length >= maximumRequestsPerMinute) { send(response, { status: 429, body: errorBody("rate-limited", "Too many authenticated API requests were received.") }); return; }
      requestTimes.push(now);
      resetIdle();
    }
    try {
      await route(request, response, head.value.pathname, head.value.searchParams);
    } catch {
      send(response, { status: 500, body: errorBody("internal-error", "The request could not be completed.") });
    }
  });
  server.maxConnections = maximumConnections;
  server.requestTimeout = 25_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => { sockets.add(socket); socket.setTimeout(25_000, () => socket.destroy()); socket.once("close", () => sockets.delete(socket)); });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end(rawClientErrorResponse());
    else socket.destroy();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, PLAN_SERVER_HOST, () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== PLAN_SERVER_HOST) { await close(); throw new Error("loopback-bind-failed"); }
  host = `${PLAN_SERVER_HOST}:${address.port}`;
  origin = `http://${host}`;
  writerEndpoint = `${origin}${WRITER_SUBMISSION_PATH}`;
  let configured: PlanControllerResult;
  try { configured = options.controller.configureWriterEndpoint(writerEndpoint); }
  catch { await close(); throw new Error("writer-endpoint-configuration-failed"); }
  if (!configured.ok) { await close(); throw new Error(configured.error.code); }
  if (activeSpecController) {
    const specConfigured = activeSpecController.configureWriterEndpoint(writerEndpoint);
    if (!specConfigured.ok) { await close(); throw new Error(specConfigured.error.code); }
  }
  resetIdle();

  async function handleWriterSubmission(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const head = validateWriterHead(request, host, origin, capability);
    if (!head.ok) { sendFailure(response, head); return; }
    if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return; }
    if (head.value.searchParams.size !== 0) { send(response, { status: 400, body: errorBody("invalid-request", "The writer submission URL is invalid.") }); return; }
    const resultHeader = request.headers["x-pi-prompt-result"];
    const kind: WriterSubmissionKind | "spec" | null = resultHeader === "plan" || resultHeader === "clarification" || resultHeader === "grill" || resultHeader === "spec" ? resultHeader : null;
    if (!kind) { send(response, { status: 422, body: errorBody("unsupported-result", "The writer result type is unsupported.") }); return; }
    const expectedType = kind === "plan" || kind === "spec" ? "text/markdown" : "application/json";
    if (request.headers["content-type"] !== expectedType) { send(response, { status: 415, body: errorBody("unsupported-media-type", "The writer result Content-Type is unsupported.") }); return; }
    const maximum = kind === "plan" ? PLAN_LIMITS.committedMarkdownBytes : kind === "spec" ? SPEC_LIMITS.markdownBytes : kind === "grill" ? MAX_GRILL_RESULT_BYTES : MAX_WRITER_RESULT_BYTES;
    const body = await readWriterBody(request, maximum);
    if (!body.ok) { sendFailure(response, body); return; }
    if (closing) { send(response, closingRecord()); return; }
    if (kind === "spec" && !activeSpecController) {
      send(response, { status: 401, body: errorBody("writer-submission-stale", "No active Spec writer accepts this result.") });
      return;
    }
    const specController = activeSpecController;
    if (closing) { send(response, closingRecord()); return; }
    const specState = specController?.snapshot();
    const submitted = kind === "spec" && specController && specState?.generationJob
      ? await specController.submitWriterResult({ planSessionId: specState.planSessionId, jobId: specState.generationJob.jobId, operation: specState.generationJob.operation, baseSpecRevision: specState.generationJob.baseSpecRevision, attemptId: head.value.attemptId, kind: "spec", body: body.value })
      : kind === "spec" ? { ok: false as const, error: { code: "writer-submission-stale", message: "No active Spec writer accepts this result." } }
      : await options.controller.submitWriterResult({ attemptId: head.value.attemptId, kind, body: body.value });
    if (!submitted.ok) {
      const unauthorized = submitted.error.code === "writer-submission-stale" || submitted.error.code === "writer-attempt-rejected";
      send(response, { status: unauthorized ? 401 : 422, body: errorBody(submitted.error.code, submitted.error.message) });
      return;
    }
    resetIdle();
    send(response, { status: 202, body: { accepted: true } });
  }

  async function route(request: IncomingMessage, response: ServerResponse, pathname: string, searchParams: URLSearchParams): Promise<void> {
    const method = request.method ?? "";
    if (pathname === "/") {
      if (method !== "GET") { methodNotAllowed(response, ["GET"]); return; }
      if ([...searchParams].length || rejectUnexpectedBody(request)) { send(response, { status: 400, body: errorBody("invalid-request", "The request is invalid.") }); return; }
      send(response, { status: 200, body: PLAN_REVIEW_HTML, headers: { "Content-Type": "text/html; charset=utf-8" } }); return;
    }
    const asset = assets.get(pathname);
    if (asset) {
      if (method !== "GET") { methodNotAllowed(response, ["GET"]); return; }
      if ([...searchParams].length || rejectUnexpectedBody(request)) { send(response, { status: 400, body: errorBody("invalid-request", "The request is invalid.") }); return; }
      send(response, { status: 200, body: asset.content, headers: { "Content-Type": asset.contentType } }); return;
    }
    if (pathname === "/api/v1/plan") {
      if (method !== "GET") { methodNotAllowed(response, ["GET"]); return; }
      if ([...searchParams].length || rejectUnexpectedBody(request)) { send(response, { status: 400, body: errorBody("invalid-request", "The request is invalid.") }); return; }
      const state = options.controller.snapshot();
      if (!state) { send(response, { status: 404, body: errorBody("plan-unavailable", "The plan file is not available yet.") }); return; }
      if (!state.document) { send(response, { status: 404, body: errorBody("plan-unavailable", "No committed plan is available yet.") }); return; }
      const markdown = state.committedMarkdown ?? renderPlanMarkdown(state.document);
      send(response, { status: 200, body: markdown, headers: { "Content-Type": "text/markdown; charset=utf-8" } });
      return;
    }
    if (pathname === "/api/v1/snapshot") {
      if (method !== "GET") { methodNotAllowed(response, ["GET"]); return; }
      if ([...searchParams].length || rejectUnexpectedBody(request)) { send(response, { status: 400, body: errorBody("invalid-request", "The request is invalid.") }); return; }
      const snapshot = currentSnapshot(); if (!snapshot) { send(response, { status: 503, body: errorBody("state-unavailable", "Plan state is unavailable.") }); return; }
      send(response, snapshotResponse(snapshot)); return;
    }
    if (pathname === "/api/v1/events") {
      if (method !== "GET") { methodNotAllowed(response, ["GET"]); return; }
      if (rejectUnexpectedBody(request)) { send(response, { status: 400, body: errorBody("invalid-request", "The request is invalid.") }); return; }
      const values = searchParams.getAll("after");
      if (values.length !== 1 || [...searchParams.keys()].some((key) => key !== "after") || !/^(0|[1-9]\d*)$/.test(values[0] ?? "")) { send(response, { status: 400, body: errorBody("invalid-sequence", "The event sequence is invalid.") }); return; }
      const after = Number(values[0]);
      if (!Number.isSafeInteger(after)) { send(response, { status: 400, body: errorBody("invalid-sequence", "The event sequence is invalid.") }); return; }
      const abort = new AbortController(); response.once("close", () => { if (!response.writableFinished) abort.abort(); });
      const result = await events.wait(after, longPollMs, abort.signal);
      if (result.kind === "future") { send(response, { status: 400, body: { error: { code: "future-sequence", message: "The event sequence is ahead of the server." }, currentSequence: result.currentSequence } }); return; }
      send(response, { status: 200, body: result }); return;
    }
    if (pathname.startsWith("/api/v1/spec")) { await routeSpec(request, response, pathname, searchParams); return; }
    const annotationMatch = /^\/api\/v1\/annotations\/([^/]+)$/.exec(pathname);
    const definition = mutationDefinition(pathname, annotationMatch);
    if (!definition) { send(response, { status: 404, body: errorBody("not-found", "The requested resource was not found.") }); return; }
    if (method !== definition.method) { methodNotAllowed(response, [definition.method]); return; }
    if ([...searchParams].length) { send(response, { status: 400, body: errorBody("invalid-request", "Mutation URLs do not accept query parameters.") }); return; }
    const ifMatch = request.headers["if-match"];
    if (ifMatch === undefined) { send(response, { status: 428, body: errorBody("precondition-required", "If-Match is required.") }); return; }
    const expected = parseStateIfMatch(typeof ifMatch === "string" ? ifMatch : undefined);
    if (expected === null) { send(response, { status: 400, body: errorBody("invalid-precondition", "If-Match must be one exact strong plan-state ETag.") }); return; }
    const bodyResult = await readStrictJsonBody(request);
    if (!bodyResult.ok) { sendFailure(response, bodyResult); return; }
    const parsed = parseMutation(definition.kind as never, bodyResult.value) as ReturnType<typeof parseMutation>;
    if (!parsed.ok) { send(response, { status: 422, body: errorBody(parsed.code, parsed.message) }); return; }
    if (definition.kind === "accept" && "stateVersion" in parsed.value && parsed.value.stateVersion !== expected) { sendConflict(response); return; }
    let annotationId: string | undefined;
    if (annotationMatch) {
      try { annotationId = decodeURIComponent(annotationMatch[1]!); } catch { send(response, { status: 400, body: errorBody("invalid-annotation-id", "The annotation ID is invalid.") }); return; }
      if (!/^[!-~]{1,64}$/.test(annotationId)) { send(response, { status: 400, body: errorBody("invalid-annotation-id", "The annotation ID is invalid.") }); return; }
    }
    const fingerprint = mutationFingerprint(definition.kind, expected, parsed.value);
    const decision = replay.run(parsed.value.requestId, fingerprint, () => serialize(async () => {
      const result = await dispatch(definition.kind, expected, parsed.value, annotationId);
      // Publish close intent while still holding the mutation turn so queued work cannot slip through.
      if (result.closeAfter) closing = true;
      return result;
    }));
    if (decision.kind === "conflict") { send(response, { status: 409, body: errorBody("request-id-conflict", "The request ID was already used for different input.") }); return; }
    if (decision.kind === "overloaded") { send(response, { status: 503, body: errorBody("replay-overloaded", "Too many mutations are awaiting replay-safe completion.") }); return; }
    const result = await decision.result;
    send(response, result);
    // Host teardown is driven by the serialized result, not by a client-dependent flush callback.
    if (result.closeAfter) scheduleClose(result.closeAfter);
  }

  async function routeSpec(request: IncomingMessage, response: ServerResponse, pathname: string, searchParams: URLSearchParams): Promise<void> {
    if (closing) { send(response, closingRecord()); return; }
    const controller = await ensureSpecController();
    if (closing) { send(response, closingRecord()); return; }
    if (!controller) { send(response, { status: 404, body: errorBody("spec-unavailable", "The Spec sidecar is unavailable until the current Plan has completed Grill.") }); return; }
    const method = request.method ?? "";
    if (pathname === "/api/v1/spec/snapshot") {
      if (method !== "GET") { methodNotAllowed(response, ["GET"]); return; }
      if ([...searchParams].length || rejectUnexpectedBody(request)) { send(response, { status: 400, body: errorBody("invalid-request", "The Spec snapshot request is invalid.") }); return; }
      const snapshot = toPublicSpecSnapshot(controller.snapshot(), controller.acceptedStagingPending()); send(response, { status: 200, body: { snapshot }, headers: { ETag: specStateEtag(snapshot.stateVersion) } }); return;
    }
    if (pathname === "/api/v1/spec/markdown") {
      if (method !== "GET") { methodNotAllowed(response, ["GET"]); return; }
      if ([...searchParams].length || rejectUnexpectedBody(request)) { send(response, { status: 400, body: errorBody("invalid-request", "The Spec Markdown request is invalid.") }); return; }
      const markdown = controller.snapshot().markdown; if (markdown === null) { send(response, { status: 404, body: errorBody("spec-unavailable", "No committed Spec is available.") }); return; }
      send(response, { status: 200, body: markdown, headers: { "Content-Type": "text/markdown; charset=utf-8", ETag: specStateEtag(controller.snapshot().stateVersion) } }); return;
    }
    if (pathname === "/api/v1/spec/events") {
      if (method !== "GET") { methodNotAllowed(response, ["GET"]); return; }
      if (rejectUnexpectedBody(request)) { send(response, { status: 400, body: errorBody("invalid-request", "The Spec event request is invalid.") }); return; }
      const values = searchParams.getAll("after"); if (values.length !== 1 || [...searchParams.keys()].some((key) => key !== "after") || !/^(0|[1-9]\d*)$/u.test(values[0] ?? "")) { send(response, { status: 400, body: errorBody("invalid-sequence", "The Spec event sequence is invalid.") }); return; }
      const after = Number(values[0]); if (!Number.isSafeInteger(after)) { send(response, { status: 400, body: errorBody("invalid-sequence", "The Spec event sequence is invalid.") }); return; }
      const abort = new AbortController(); response.once("close", () => { if (!response.writableFinished) abort.abort(); }); const result = await specEvents.wait(after, longPollMs, abort.signal); send(response, result.kind === "future" ? { status: 400, body: { error: { code: "future-sequence", message: "The Spec event sequence is ahead of the server." }, currentSequence: result.currentSequence } } : { status: 200, body: result }); return;
    }
    const commentMatch = /^\/api\/v1\/spec\/comments\/([^/]+)$/u.exec(pathname);
    const statusMatch = /^\/api\/v1\/spec\/comments\/([^/]+)\/status$/u.exec(pathname);
    const definition: { readonly method: "POST" | "PATCH"; readonly kind: SpecRequestKind } | null = pathname === "/api/v1/spec/generations" ? { method: "POST", kind: "generate" }
      : pathname === "/api/v1/spec/fresh-generations" ? { method: "POST", kind: "fresh-generation" }
      : pathname === "/api/v1/spec/comments" ? { method: "POST", kind: "comment-create" }
      : commentMatch ? { method: "PATCH", kind: "comment-edit" }
      : statusMatch ? { method: "PATCH", kind: "comment-status" }
      : pathname === "/api/v1/spec/revisions" ? { method: "POST", kind: "revision" }
      : pathname === "/api/v1/spec/accept" ? { method: "POST", kind: "accept" }
      : pathname === "/api/v1/spec/cancel" ? { method: "POST", kind: "cancel" } : null;
    if (!definition) { send(response, { status: 404, body: errorBody("not-found", "The Spec resource was not found.") }); return; }
    if (method !== definition.method) { methodNotAllowed(response, [definition.method]); return; }
    if ([...searchParams].length) { send(response, { status: 400, body: errorBody("invalid-request", "Spec mutation URLs do not accept query parameters.") }); return; }
    const expected = parseSpecIfMatch(typeof request.headers["if-match"] === "string" ? request.headers["if-match"] : undefined); if (request.headers["if-match"] === undefined) { send(response, { status: 428, body: errorBody("precondition-required", "If-Match is required.") }); return; } if (expected === null) { send(response, { status: 400, body: errorBody("invalid-precondition", "If-Match must be one exact strong Spec ETag.") }); return; }
    const parsedBody = await readStrictJsonBody(request); if (!parsedBody.ok) { sendFailure(response, parsedBody); return; } const parsed = parseSpecMutation(definition.kind, parsedBody.value); if (!parsed.ok) { send(response, { status: 422, body: errorBody(parsed.code, parsed.message) }); return; }
    if (definition.kind === "accept" && "stateVersion" in parsed.value && parsed.value.stateVersion !== expected) { send(response, specConflict()); return; }
    let commentId: string | undefined; const idMatch = commentMatch ?? statusMatch; if (idMatch) { try { commentId = decodeURIComponent(idMatch[1]!); } catch { send(response, { status: 400, body: errorBody("invalid-comment-id", "Spec comment ID is invalid.") }); return; } if (!/^[!-~]{1,64}$/u.test(commentId)) { send(response, { status: 400, body: errorBody("invalid-comment-id", "Spec comment ID is invalid.") }); return; } }
    if (closing) { send(response, closingRecord()); return; }
    const fingerprint = specMutationFingerprint(definition.kind, expected, parsed.value); const decision = replay.run(parsed.value.requestId, fingerprint, () => serialize(() => dispatchSpec(definition.kind, expected, parsed.value, commentId)));
    if (decision.kind === "conflict") { send(response, { status: 409, body: errorBody("request-id-conflict", "The request ID was already used for different input.") }); return; } if (decision.kind === "overloaded") { send(response, { status: 503, body: errorBody("replay-overloaded", "Too many Spec mutations are awaiting completion.") }); return; } const result = await decision.result; send(response, closing ? closingRecord() : result);
  }

  async function dispatchSpec(kind: SpecRequestKind, expected: number, body: SpecMutation, commentId?: string): Promise<ResponseRecord> {
    if (closing) return closingRecord();
    const controller = activeSpecController!; const state = controller.snapshot(); if (state.stateVersion !== expected) return specConflict(); let result: PlanControllerResult<unknown>;
    if (kind === "generate" || kind === "fresh-generation") { const started = kind === "fresh-generation" ? await controller.generateFresh({ expectedStateVersion: expected }) : await controller.generate({ expectedStateVersion: expected }); if (closing) return closingRecord(); if (!started.ok) return specFailure(started); const dispatched = controller.dispatchGeneration(started.value.jobId); if (!dispatched.ok) return specFailure(dispatched); return specSnapshot(202, { job: { id: started.value.jobId, status: "generating" } }); }
    if (kind === "comment-create" && "start" in body && "end" in body && "body" in body) result = await controller.addComment({ expectedStateVersion: expected, start: body.start, end: body.end, body: body.body });
    else if (kind === "comment-edit" && commentId && "body" in body) result = await controller.editComment({ expectedStateVersion: expected, commentId, body: body.body });
    else if (kind === "comment-status" && commentId && "status" in body) result = await controller.transitionComment({ expectedStateVersion: expected, commentId, status: body.status });
    else if (kind === "revision" && "selectedCommentIds" in body) { const started = await controller.revise({ expectedStateVersion: expected, selectedCommentIds: body.selectedCommentIds, ...(body.instruction ? { instruction: body.instruction } : {}) }); if (closing) return closingRecord(); if (!started.ok) return specFailure(started); const dispatched = controller.dispatchGeneration(started.value.jobId); if (!dispatched.ok) return specFailure(dispatched); return specSnapshot(202, { job: { id: started.value.jobId, status: "revising" } }); }
    else if (kind === "accept" && "specRevision" in body && "confirmed" in body) result = await controller.accept({ expectedStateVersion: expected, specRevision: body.specRevision, confirmed: body.confirmed });
    else if (kind === "cancel" && "disposition" in body) result = body.disposition === "pause" ? await controller.pause({ expectedStateVersion: expected }) : await controller.cancel({ expectedStateVersion: expected });
    else return { status: 422, body: errorBody("invalid-request", "Spec mutation is invalid.") };
    if (closing) return closingRecord();
    return result.ok ? specSnapshot(200, { ok: true }) : specFailure(result);
  }
  function specSnapshot(status: number, body: Record<string, unknown>): ResponseRecord { const controller = activeSpecController!; const snapshot = toPublicSpecSnapshot(controller.snapshot(), controller.acceptedStagingPending()); return { status, body: { ...body, snapshot }, headers: { ETag: specStateEtag(snapshot.stateVersion) } }; }
  function specConflict(): ResponseRecord { const controller = activeSpecController!; const snapshot = toPublicSpecSnapshot(controller.snapshot(), controller.acceptedStagingPending()); return { status: 409, body: { error: { code: "state-conflict", message: "The Spec changed. Refresh and retry." }, current: { stateVersion: snapshot.stateVersion, specRevision: snapshot.specRevision }, snapshot }, headers: { ETag: specStateEtag(snapshot.stateVersion) } }; }
  function specFailure(result: { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }): ResponseRecord { if (result.error.code === "state-conflict") return specConflict(); return { status: result.error.code === "persistence-failed" || result.error.code === "controller-closed" ? 503 : ["job-active", "terminal-state"].includes(result.error.code) ? 409 : 422, body: errorBody(result.error.code, result.error.message) }; }

  async function dispatch(kind: RequestKind, expected: number, body: MutationRequest, annotationId?: string): Promise<ResponseRecord> {
    if (closing) return { status: 503, body: errorBody("closing", "The review listener is closing.") };
    const state = options.controller.snapshot();
    if (!state || state.stateVersion !== expected) return conflictRecord();
    let result: PlanControllerResult<unknown>;
    if (kind === "annotation-create" && "target" in body && "body" in body) result = await options.controller.addAnnotation({ expectedStateVersion: expected, target: body.target, body: body.body });
    else if (kind === "annotation-patch" && "update" in body && annotationId) result = "body" in body.update
      ? await options.controller.updateAnnotationBody({ expectedStateVersion: expected, annotationId, body: body.update.body })
      : await options.controller.transitionAnnotation({ expectedStateVersion: expected, annotationId, status: body.update.status });
    else if (kind === "revision" && "selectedAnnotationIds" in body) {
      if (body.selectedAnnotationIds.some((id) => !state.annotations.some((annotation) => annotation.id === id && annotation.status === "open"))) return { status: 422, body: errorBody("invalid-annotations", "Revision requests may select only current open annotations.") };
      const started = await options.controller.revise({ expectedStateVersion: expected, selectedAnnotationIds: body.selectedAnnotationIds, ...(body.instruction === undefined ? {} : { instruction: body.instruction }) });
      if (!started.ok) return controllerFailure(started);
      const dispatched = options.controller.dispatchGeneration(started.value.jobId);
      if (!dispatched.ok) return controllerFailure(dispatched);
      return withSnapshot(202, { job: { id: started.value.jobId, status: "revising" } });
    } else if (kind === "grill") {
      if (!["ready", "error"].includes(state.status) || state.document === null || state.generationJob) return { status: 409, body: errorBody("grill-unavailable", "Grill cannot start from the current state.") };
      const started = await options.controller.grill({ expectedStateVersion: expected });
      if (!started.ok) return controllerFailure(started);
      const dispatched = options.controller.dispatchGeneration(started.value.jobId); if (!dispatched.ok) return controllerFailure(dispatched);
      return withSnapshot(202, { job: { id: started.value.jobId, status: "grilling" } });
    } else if (kind === "generation-retry") {
      if (state.status !== "error" || state.document !== null || state.generationJob) return { status: 409, body: errorBody("retry-unavailable", "Initial plan generation cannot be retried from the current state.") };
      const started = await options.controller.generate({ expectedStateVersion: expected });
      if (!started.ok) return controllerFailure(started);
      const dispatched = options.controller.dispatchGeneration(started.value.jobId);
      if (!dispatched.ok) return controllerFailure(dispatched);
      return withSnapshot(202, { job: { id: started.value.jobId, status: "generating" } });
    } else if (kind === "clarification-answers" && "clarificationId" in body && "answers" in body) {
      if (state.status !== "awaiting-clarification" || state.clarifications?.pending?.id !== body.clarificationId) return conflictRecord();
      const started = await options.controller.answerClarification({ expectedStateVersion: expected, clarificationId: body.clarificationId, answers: body.answers });
      if (!started.ok) return controllerFailure(started);
      const dispatched = options.controller.dispatchGeneration(started.value.jobId); if (!dispatched.ok) return controllerFailure(dispatched);
      return withSnapshot(202, { accepted: true, job: { operation: state.clarifications.pending.operation, status: state.clarifications.pending.operation === "initial" ? "generating" : "revising" } });
    } else if (kind === "accept" && "documentRevision" in body && "confirmed" in body) {
      result = await options.controller.accept({ expectedStateVersion: expected, documentRevision: body.documentRevision, confirmed: body.confirmed });
      if (!result.ok) return result.error.code === "stage-failed"
        ? withSnapshot(503, { error: { code: result.error.code, message: result.error.message }, accepted: true })
        : controllerFailure(result);
      return { ...withSnapshot(200, { accepted: true }), closeAfter: "terminal" };
    } else if (kind === "cancel" && "disposition" in body) {
      result = body.disposition === "pause" ? await options.controller.pause({ expectedStateVersion: expected }) : await options.controller.cancel({ expectedStateVersion: expected });
      if (!result.ok) return controllerFailure(result);
      return { ...withSnapshot(200, { disposition: body.disposition }), closeAfter: "terminal" };
    } else if (kind === "reopen") {
      return { ...withSnapshot(200, { reopening: true }), closeAfter: "reopen" };
    } else return { status: 422, body: errorBody("invalid-request", "The mutation request is invalid.") };
    if (!result.ok) return controllerFailure(result);
    return withSnapshot(200, { ok: true });
  }

  function currentSnapshot(): PublicSnapshot | null {
    const state = options.controller.snapshot();
    return state ? toPublicSnapshot(state, {
      canRetryGeneration: state.status === "error" && state.document === null && state.generationJob === undefined,
      canRetryStaging: options.controller.acceptedStagingPending(),
    }, options.activity?.()) : null;
  }
  function withSnapshot(status: number, body: Record<string, unknown>): ResponseRecord { const snapshot = currentSnapshot(); return snapshot ? { status, body: { ...body, snapshot }, headers: { ETag: stateEtag(snapshot.stateVersion) } } : { status: 503, body: errorBody("state-unavailable", "Plan state is unavailable.") }; }
  function snapshotResponse(snapshot: PublicSnapshot): ResponseRecord { return { status: 200, body: { snapshot }, headers: { ETag: stateEtag(snapshot.stateVersion) } }; }
  function conflictRecord(): ResponseRecord { const snapshot = currentSnapshot(); return { status: 409, body: { error: { code: "state-conflict", message: "The plan changed. Refresh and retry." }, ...(snapshot ? { current: { stateVersion: snapshot.stateVersion, documentRevision: snapshot.documentRevision }, snapshot } : {}) }, ...(snapshot ? { headers: { ETag: stateEtag(snapshot.stateVersion) } } : {}) }; }
  function sendConflict(response: ServerResponse): void { send(response, conflictRecord()); }
  function controllerFailure(result: { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }): ResponseRecord {
    if (result.error.code === "state-conflict") return conflictRecord();
    const status = result.error.code === "persistence-failed" || result.error.code === "controller-closed" ? 503 : ["job-active", "terminal-state", "clarification-conflict", "clarification-read-only"].includes(result.error.code) ? 409 : 422;
    return { status, body: errorBody(result.error.code, result.error.message) };
  }

  return Object.freeze({
    port: address.port, origin, launchUrl: `${origin}/#capability=${capability}`,
    get closed() { return closed; },
    close,
  });
}

function validateWriterHead(
  request: IncomingMessage, host: string, origin: string, browserCapability: string,
): RequestFailure | { readonly ok: true; readonly value: { readonly searchParams: URLSearchParams; readonly attemptId: string } } {
  const rawUrl = request.url ?? "";
  if (Buffer.byteLength(rawUrl, "utf8") > 2_048 || !rawUrl.startsWith("/") || rawUrl.startsWith("//") || /[\0\r\n]/u.test(rawUrl)) return requestFailure(400, "invalid-url", "The request URL is invalid.");
  if (request.rawHeaders.length / 2 > 64 || Buffer.byteLength(request.rawHeaders.join("\n"), "utf8") > 16_384) return requestFailure(431, "headers-too-large", "Request headers are too large.");
  const unique = new Set(["host", "authorization", "content-type", "content-length", "content-encoding", "transfer-encoding", "x-pi-prompt-result"]);
  const seen = new Set<string>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (!name || !unique.has(name)) continue;
    if (seen.has(name)) return requestFailure(400, "duplicate-header", "Duplicate request headers are not allowed.");
    seen.add(name);
  }
  if (request.headers.host !== host) return requestFailure(400, "invalid-host", "The request host is invalid.");
  let url: URL;
  try { url = new URL(rawUrl, origin); } catch { return requestFailure(400, "invalid-url", "The request URL is invalid."); }
  if (url.origin !== origin || url.pathname !== WRITER_SUBMISSION_PATH || url.username || url.password || url.hash) return requestFailure(400, "invalid-url", "The request URL is invalid.");
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return requestFailure(401, "unauthorized", "Authentication is required.");
  const attemptId = authorization.slice("Bearer ".length);
  if (attemptId === browserCapability || !/^[A-Za-z0-9_-]{16,64}$/u.test(attemptId)) return requestFailure(401, "unauthorized", "Authentication is required.");
  return { ok: true, value: { searchParams: url.searchParams, attemptId } };
}
async function readWriterBody(request: IncomingMessage, maximum: number): Promise<RequestFailure | { readonly ok: true; readonly value: Buffer }> {
  if (request.headers["content-encoding"] !== undefined || request.headers["transfer-encoding"] !== undefined) return requestFailure(415, "encoding-not-supported", "Encoded request bodies are not supported.");
  const lengthHeader = request.headers["content-length"];
  if (typeof lengthHeader !== "string" || !/^(0|[1-9]\d*)$/u.test(lengthHeader)) return requestFailure(411, "length-required", "A valid Content-Length is required.");
  const declared = Number(lengthHeader);
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > maximum) return requestFailure(declared > maximum ? 413 : 400, declared > maximum ? "body-too-large" : "empty-body", declared > maximum ? "The request body is too large." : "The request body is empty.");
  const chunks: Buffer[] = []; let total = 0;
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); total += chunk.length;
      if (total > maximum || total > declared) { request.resume(); return requestFailure(413, "body-too-large", "The request body is too large."); }
      chunks.push(chunk);
    }
  } catch { return requestFailure(400, "body-read-failed", "The request body could not be read."); }
  if (total !== declared) return requestFailure(400, "length-mismatch", "The request body length is invalid.");
  return { ok: true, value: Buffer.concat(chunks, total) };
}
function requestFailure(status: number, code: string, message: string): RequestFailure { return { ok: false, status, code, message }; }

function mutationDefinition(pathname: string, annotationMatch: RegExpExecArray | null): { readonly method: "POST" | "PATCH"; readonly kind: RequestKind } | null {
  if (pathname === "/api/v1/annotations") return { method: "POST", kind: "annotation-create" };
  if (annotationMatch) return { method: "PATCH", kind: "annotation-patch" };
  if (pathname === "/api/v1/generation-retries") return { method: "POST", kind: "generation-retry" };
  if (pathname === "/api/v1/grill-runs") return { method: "POST", kind: "grill" };
  if (pathname === "/api/v1/revision-requests") return { method: "POST", kind: "revision" };
  if (pathname === "/api/v1/clarification-answers") return { method: "POST", kind: "clarification-answers" };
  if (pathname === "/api/v1/accept") return { method: "POST", kind: "accept" };
  if (pathname === "/api/v1/cancel") return { method: "POST", kind: "cancel" };
  if (pathname === "/api/v1/reopen-in-pi") return { method: "POST", kind: "reopen" };
  return null;
}
function methodNotAllowed(response: ServerResponse, allow: readonly string[]): void { send(response, { status: 405, body: errorBody("method-not-allowed", "The request method is not allowed."), headers: { Allow: allow.join(", ") } }); }
function sendFailure(response: ServerResponse, failure: RequestFailure): void { send(response, { status: failure.status, body: errorBody(failure.code, failure.message) }); }
function send(response: ServerResponse, record: ResponseRecord, finished?: () => void): void {
  if (response.headersSent || response.destroyed) return;
  const isBytes = Buffer.isBuffer(record.body);
  const isText = typeof record.body === "string";
  const payload = record.body === undefined ? Buffer.alloc(0) : isBytes ? record.body as Buffer : Buffer.from(isText ? record.body as string : JSON.stringify(record.body), "utf8");
  response.writeHead(record.status, { ...SECURITY_HEADERS, "Content-Type": isBytes ? "application/octet-stream" : isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "Content-Length": String(payload.length), ...record.headers });
  response.end(payload, finished);
}
function errorBody(code: string, message: string): object { return { error: { code, message } }; }
function closingRecord(): ResponseRecord { return { status: 503, body: errorBody("closing", "The review listener is closing.") }; }
function responseRecordBytes(record: ResponseRecord): number {
  const body = record.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(record.body)
    ? record.body : Buffer.from(typeof record.body === "string" ? record.body : JSON.stringify(record.body), "utf8");
  return body.length + Buffer.byteLength(JSON.stringify(record.headers ?? {}), "utf8") + 64;
}
function rawClientErrorResponse(): string {
  const headers = Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}`);
  return ["HTTP/1.1 400 Bad Request", ...headers, "Content-Type: application/json; charset=utf-8", "Content-Length: 0", "Connection: close", "", ""].join("\r\n");
}
function bounded(value: number, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("invalid-server-option"); return value; }
