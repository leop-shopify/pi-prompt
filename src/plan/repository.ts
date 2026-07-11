import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { platform } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { collectPlanElementIds } from "./reconcile.js";
import { validatePlanSession } from "./schema.js";
import type { PlanDocument, PlanSession } from "./types.js";
import type { AppendPlanBranchLocator, LocatorScan, PlanBranchLocator } from "./locator.js";
import { isSafePlanSessionId, validatePlanBranchLocator } from "./locator.js";
import { defaultPlanRoot } from "./session-files.js";

export const PLAN_EVENT_LIMIT = 256;

export type PlanAuditKind = "created" | "updated" | "state-changed" | "revision-committed" | "accepted" | "paused" | "cancelled" | "skill-check-failed" | "recovered";
export type PlanRecoveryWarning = "invalid-locator" | "invalid-state" | "invalid-revision" | "plan-rebuilt" | "metadata-rebuilt" | "events-rebuilt";

export interface CommittedPlanState {
  readonly state: PlanSession;
  readonly locator: PlanBranchLocator;
}
export interface RecoveredPlanState {
  readonly state: PlanSession | null;
  readonly warnings: readonly PlanRecoveryWarning[];
  readonly locator: PlanBranchLocator | null;
  readonly reservedIds: readonly string[];
}
export interface CommitPlanInput {
  readonly session: PlanSession;
  readonly previous: PlanSession | null;
  readonly eventKind: Exclude<PlanAuditKind, "recovered">;
  readonly appendLocator: AppendPlanBranchLocator;
}
export interface CommitAcceptedPlanInput extends CommitPlanInput {
  readonly eventKind: "accepted";
  readonly finalPlan: string;
}
export interface PlanRepositoryOptions {
  readonly rootDir?: string;
  readonly clock?: () => Date | string;
}
export interface PlanRepository {
  readonly rootDir: string;
  commit(input: CommitPlanInput): Promise<CommittedPlanState>;
  commitAccepted(input: CommitAcceptedPlanInput): Promise<CommittedPlanState>;
  recover(input: readonly PlanBranchLocator[] | LocatorScan): Promise<RecoveredPlanState>;
  close(): Promise<void>;
}

export class PlanRepositoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "PlanRepositoryError"; this.code = code; }
}

export function defaultPlanRepositoryRoot(): string {
  return defaultPlanRoot();
}

export function createPlanRepository(options: PlanRepositoryOptions = {}): PlanRepository {
  const rootDir = resolve(options.rootDir ?? defaultPlanRepositoryRoot());
  const clock = options.clock ?? (() => new Date());
  let closed = false;
  const committed = new Map<string, { readonly stateVersion: number; readonly documentRevision: number; readonly stateSha256: string }>();

  const commitInternal = async (input: CommitPlanInput, finalPlan?: string): Promise<CommittedPlanState> => {
    ensureOpen(closed);
    const session = validatedSession(input.session, "invalid-session");
    const previous = input.previous === null ? null : validatedSession(input.previous, "invalid-previous");
    if (finalPlan === undefined && session.status === "accepted") throw repositoryError("accepted-requires-final", "Accepted state and final plan must be committed together.");
    if (finalPlan !== undefined && (session.status !== "accepted" || session.document === null || input.eventKind !== "accepted")) throw repositoryError("not-accepted", "Only an accepted materialized plan can be finalized.");
    if (finalPlan !== undefined && typeof finalPlan !== "string") throw repositoryError("invalid-render", "The rendered final plan must be text.");
    validateTransition(session, previous);
    const knownPrevious = committed.get(session.id);
    if (knownPrevious) {
      const previousSha = previous === null ? null : sha256(canonicalBytes(previous));
      if (previous === null || knownPrevious.stateVersion !== previous.stateVersion || knownPrevious.documentRevision !== previous.documentRevision || knownPrevious.stateSha256 !== previousSha) throw repositoryError("stale-previous", "The previous state is not the latest committed state.");
    }
    const committedAt = canonicalNow(clock);
    const artifactPath = await ensurePrivateArtifactDirectory(rootDir, session.id);
    const stateBytes = canonicalBytes(session); const stateSha256 = sha256(stateBytes);
    const documentBytes = session.document === null ? null : canonicalBytes(session.document); const documentSha256 = documentBytes === null ? null : sha256(documentBytes);
    if (documentBytes !== null && documentSha256 !== null) await writeImmutable(join(artifactPath, "revisions", `${session.documentRevision}-${documentSha256}.plan.json`), documentBytes);
    await writeImmutable(join(artifactPath, "states", `${session.stateVersion}-${stateSha256}.session.json`), stateBytes);
    const metadataBytes = canonicalBytes(await metadataFor(session, committedAt, artifactPath));
    const eventsBytes = await nextEventsBytes(join(artifactPath, "events.jsonl"), auditEvent(input.eventKind, committedAt, session));
    const annotationsBytes = canonicalBytes(session.annotations);
    const projections = finalPlan === undefined ? ["metadata.json", "events.jsonl", "plan.json", "annotations.json"] : ["metadata.json", "events.jsonl", "plan.json", "annotations.json", "final-plan.md"];
    const prior = await snapshotFiles(artifactPath, projections);
    try {
      await atomicPrivateWrite(join(artifactPath, "metadata.json"), metadataBytes);
      await atomicPrivateWrite(join(artifactPath, "events.jsonl"), eventsBytes);
      await atomicPrivateWrite(join(artifactPath, "plan.json"), stateBytes);
      await atomicPrivateWrite(join(artifactPath, "annotations.json"), annotationsBytes);
      if (finalPlan !== undefined) await atomicPrivateWrite(join(artifactPath, "final-plan.md"), Buffer.from(finalPlan, "utf8"));
      const locator: PlanBranchLocator = Object.freeze({ schemaVersion: 1, sessionId: session.id, artifactPath, status: session.status, stateVersion: session.stateVersion, documentRevision: session.documentRevision, stateSha256, committedAt });
      try { input.appendLocator(locator); } catch { await restoreFiles(artifactPath, projections, prior); throw repositoryError("locator-append-failed", "Could not append the plan commit locator."); }
      committed.set(session.id, { stateVersion: session.stateVersion, documentRevision: session.documentRevision, stateSha256 });
      return Object.freeze({ state: session, locator });
    } catch (error) { if (error instanceof PlanRepositoryError) throw error; throw repositoryError("commit-failed", "Could not commit the plan state."); }
  };

  return Object.freeze({
    rootDir,
    commit(input: CommitPlanInput): Promise<CommittedPlanState> { return commitInternal(input); },
    commitAccepted(input: CommitAcceptedPlanInput): Promise<CommittedPlanState> { return commitInternal(input, input.finalPlan); },
    async recover(input: readonly PlanBranchLocator[] | LocatorScan): Promise<RecoveredPlanState> {
      ensureOpen(closed);
      let supplied: readonly PlanBranchLocator[];
      const warnings: PlanRecoveryWarning[] = [];
      if (isLocatorScan(input)) {
        supplied = input.locators;
        if (input.invalidEntries > 0) warnings.push("invalid-locator");
      } else supplied = input;
      for (let candidateIndex = 0; candidateIndex < supplied.length; candidateIndex += 1) {
        const candidate = supplied[candidateIndex];
        const locator = validatePlanBranchLocator(candidate, rootDir);
        if (!locator) { warnings.push("invalid-locator"); continue; }
        const recovered = await loadLocatedState(rootDir, locator);
        if (!recovered.ok) { warnings.push(recovered.warning); continue; }
        const state = recovered.state;
        const reservedIds = await recoverReservedIds(rootDir, supplied.slice(candidateIndex), locator, state, warnings);
        const at = locator.committedAt;
        const metadataBytes = canonicalBytes(await metadataFor(state, at, locator.artifactPath));
        const stateBytes = canonicalBytes(state);
        if (!await fileEquals(join(locator.artifactPath, "metadata.json"), metadataBytes)) {
          await atomicPrivateWrite(join(locator.artifactPath, "metadata.json"), metadataBytes); warnings.push("metadata-rebuilt");
        } else await chmod(join(locator.artifactPath, "metadata.json"), 0o600);
        if (!await fileEquals(join(locator.artifactPath, "plan.json"), stateBytes)) {
          await atomicPrivateWrite(join(locator.artifactPath, "plan.json"), stateBytes); warnings.push("plan-rebuilt");
        } else await chmod(join(locator.artifactPath, "plan.json"), 0o600);
        const annotationsBytes = canonicalBytes(state.annotations);
        if (!await fileEquals(join(locator.artifactPath, "annotations.json"), annotationsBytes)) {
          await atomicPrivateWrite(join(locator.artifactPath, "annotations.json"), annotationsBytes);
        } else await chmod(join(locator.artifactPath, "annotations.json"), 0o600);
        const eventsPath = join(locator.artifactPath, "events.jsonl");
        if (!await validProjectedEvents(eventsPath, state)) {
          await atomicPrivateWrite(eventsPath, eventLines([auditEvent("recovered", canonicalNow(clock), state)])); warnings.push("events-rebuilt");
        } else await chmod(eventsPath, 0o600);
        committed.set(state.id, { stateVersion: state.stateVersion, documentRevision: state.documentRevision, stateSha256: locator.stateSha256 });
        return Object.freeze({ state, warnings: Object.freeze([...warnings]), locator, reservedIds });
      }
      return Object.freeze({ state: null, warnings: Object.freeze([...warnings]), locator: null, reservedIds: Object.freeze([]) });
    },
    async close(): Promise<void> { closed = true; },
  });
}

function validatedSession(input: PlanSession, code: string): PlanSession {
  const result = validatePlanSession(input);
  if (!result.ok) throw repositoryError(code, "Plan session validation failed.");
  return result.value;
}
function validateTransition(session: PlanSession, previous: PlanSession | null): void {
  if (previous === null) {
    if (session.stateVersion !== 1) throw repositoryError("invalid-state-version", "An initial commit must use state version 1.");
    return;
  }
  if (session.id !== previous.id) throw repositoryError("session-mismatch", "A commit cannot change the session ID.");
  if (session.stateVersion !== previous.stateVersion + 1) throw repositoryError("invalid-state-version", "State versions must advance exactly once.");
  if (session.documentRevision < previous.documentRevision || session.documentRevision > previous.documentRevision + 1) {
    throw repositoryError("invalid-document-revision", "Document revisions cannot regress or skip.");
  }
  const sameDocument = documentBytes(session.document).equals(documentBytes(previous.document));
  if (sameDocument && session.documentRevision !== previous.documentRevision) throw repositoryError("unnecessary-document-revision", "An unchanged document must keep its revision.");
  if (!sameDocument && session.documentRevision !== previous.documentRevision + 1) throw repositoryError("missing-document-revision", "A changed document must advance its revision exactly once.");
}
function documentBytes(document: PlanDocument | null): Buffer { return document === null ? Buffer.from("null\n") : canonicalBytes(document); }
function canonicalBytes(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalNow(clock: () => Date | string): string {
  const raw = clock(); const value = raw instanceof Date ? raw.toISOString() : raw;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw repositoryError("invalid-clock", "Repository clock returned a non-canonical timestamp.");
  }
  return value;
}

interface Metadata {
  readonly schemaVersion: 1; readonly id: string; readonly status: PlanSession["status"];
  readonly stateVersion: number; readonly documentRevision: number; readonly generationMode: PlanSession["generation"]["mode"];
  readonly execution: PlanSession["execution"]; readonly createdAt: string; readonly committedAt: string;
  readonly prompt: { readonly bytes: number; readonly codePoints: number }; readonly skillCount: number;
}
async function metadataFor(session: PlanSession, committedAt: string, artifactPath: string): Promise<Metadata> {
  let createdAt = committedAt;
  try {
    const parsed: unknown = JSON.parse((await readRegularFile(join(artifactPath, "metadata.json"))).toString("utf8"));
    if (isRecord(parsed) && typeof parsed.createdAt === "string" && isCanonicalTimestamp(parsed.createdAt)) createdAt = parsed.createdAt;
  } catch { /* first commit or corrupt projection */ }
  const promptBytes = Buffer.from(session.source.prompt, "utf8");
  return {
    schemaVersion: 1, id: session.id, status: session.status, stateVersion: session.stateVersion,
    documentRevision: session.documentRevision, generationMode: session.generation.mode, execution: { kind: session.execution.kind },
    createdAt, committedAt, prompt: { bytes: promptBytes.byteLength, codePoints: [...session.source.prompt].length },
    skillCount: session.source.skills.length,
  };
}
interface AuditEvent { readonly kind: PlanAuditKind; readonly at: string; readonly id: string; readonly status: PlanSession["status"]; readonly stateVersion: number; readonly documentRevision: number; readonly errorCode?: string }
function auditEvent(kind: PlanAuditKind, at: string, session: PlanSession): AuditEvent {
  return { kind, at, id: session.id, status: session.status, stateVersion: session.stateVersion, documentRevision: session.documentRevision,
    ...(session.lastError ? { errorCode: session.lastError.code } : {}) };
}
function eventLines(events: readonly AuditEvent[]): Buffer { return Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8"); }
async function nextEventsBytes(path: string, event: AuditEvent): Promise<Buffer> {
  const events: AuditEvent[] = [];
  try {
    const text = (await readRegularFile(path)).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const parsed: unknown = JSON.parse(line); if (isAuditEvent(parsed)) events.push(parsed); } catch { /* projection is safely replaced */ }
    }
  } catch { /* first event */ }
  return eventLines([...events, event].slice(-PLAN_EVENT_LIMIT));
}
async function validProjectedEvents(path: string, state: PlanSession): Promise<boolean> {
  try {
    const bytes = await readRegularFile(path); const text = bytes.toString("utf8");
    if (!text.endsWith("\n")) return false;
    const lines = text.split("\n").filter(Boolean); if (lines.length < 1 || lines.length > PLAN_EVENT_LIMIT) return false;
    const events: AuditEvent[] = [];
    for (const line of lines) { const parsed: unknown = JSON.parse(line); if (!isAuditEvent(parsed)) return false; events.push(parsed); }
    const last = events.at(-1);
    return last?.id === state.id && last.stateVersion === state.stateVersion && last.documentRevision === state.documentRevision && last.status === state.status;
  } catch { return false; }
}
function isAuditEvent(value: unknown): value is AuditEvent {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value); const allowed = new Set(["kind", "at", "id", "status", "stateVersion", "documentRevision", "errorCode"]);
  return keys.every((key) => allowed.has(key)) && (keys.length === 6 || keys.length === 7)
    && ["created", "updated", "state-changed", "revision-committed", "accepted", "paused", "cancelled", "skill-check-failed", "recovered"].includes(String(value.kind))
    && typeof value.at === "string" && isCanonicalTimestamp(value.at) && typeof value.id === "string" && typeof value.status === "string"
    && Number.isSafeInteger(value.stateVersion) && Number.isSafeInteger(value.documentRevision)
    && (value.errorCode === undefined || (typeof value.errorCode === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(value.errorCode)));
}

async function ensurePrivateArtifactDirectory(rootDir: string, sessionId: string): Promise<string> {
  if (!isSafePlanSessionId(sessionId)) throw repositoryError("unsafe-session-id", "Session ID is unsafe for persistence.");
  if (!isAbsolute(rootDir)) throw repositoryError("unsafe-root", "Repository root must be absolute.");
  await ensureDirectory(rootDir);
  const rootReal = await realpath(rootDir);
  const artifactPath = resolve(rootDir, sessionId);
  if (!contained(rootDir, artifactPath)) throw repositoryError("unsafe-artifact-path", "Artifact path escapes the repository root.");
  await ensureDirectory(artifactPath); await ensureDirectory(join(artifactPath, "states")); await ensureDirectory(join(artifactPath, "revisions"));
  const artifactReal = await realpath(artifactPath);
  if (!contained(rootReal, artifactReal)) throw repositoryError("unsafe-artifact-path", "Artifact directory escapes the repository root.");
  return artifactPath;
}
async function ensureDirectory(path: string): Promise<void> {
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isDirectory()) throw repositoryError("unsafe-directory", "Persistence path is not a private directory.");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const after = await lstat(path);
    if (after.isSymbolicLink() || !after.isDirectory()) throw repositoryError("unsafe-directory", "Persistence directory creation was unsafe.");
  }
  await chmod(path, 0o700);
}
async function writeImmutable(path: string, bytes: Buffer): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(bytes); await handle.sync();
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const existing = await readRegularFile(path);
    if (!existing.equals(bytes) || sha256(existing) !== sha256(bytes)) throw repositoryError("immutable-mismatch", "Immutable artifact content does not match its address.");
    await chmod(path, 0o600); return;
  } finally { await handle?.close(); }
  await syncDirectory(resolve(path, ".."));
}
async function atomicPrivateWrite(path: string, bytes: Buffer): Promise<void> {
  const directory = resolve(path, "..");
  const temporary = join(directory, `.tmp-${randomBytes(16).toString("hex")}`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, path); await chmod(path, 0o600); await syncDirectory(directory);
  } catch (error) {
    try { await unlink(temporary); } catch { /* best-effort cleanup of our own temp */ }
    throw error;
  } finally { await handle?.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY); await handle.sync(); }
  catch (error) {
    const unsupported = platform() === "win32" && (hasCode(error, "EINVAL") || hasCode(error, "EPERM") || hasCode(error, "EISDIR") || hasCode(error, "ENOTSUP"));
    if (!unsupported) throw error;
  } finally { await handle?.close(); }
}

async function recoverReservedIds(
  rootDir: string,
  supplied: readonly PlanBranchLocator[],
  chosenLocator: PlanBranchLocator,
  chosenState: PlanSession,
  warnings: PlanRecoveryWarning[],
): Promise<readonly string[]> {
  const ids = new Set<string>();
  collectSessionIds(chosenState, ids);
  let newer = chosenState;
  let expectedVersion = chosenLocator.stateVersion - 1;
  for (let index = 1; index < supplied.length && expectedVersion >= 1; index += 1) {
    const locator = validatePlanBranchLocator(supplied[index], rootDir);
    if (!locator) { warnings.push("invalid-locator"); continue; }
    if (locator.sessionId !== chosenLocator.sessionId || locator.stateVersion !== expectedVersion) continue;
    const loaded = await loadLocatedState(rootDir, locator);
    if (!loaded.ok) { warnings.push(loaded.warning); continue; }
    try { validateTransition(newer, loaded.state); }
    catch { warnings.push("invalid-state"); continue; }
    collectSessionIds(loaded.state, ids);
    newer = loaded.state;
    expectedVersion -= 1;
  }
  return Object.freeze([...ids].sort());
}
function collectSessionIds(state: PlanSession, ids: Set<string>): void {
  ids.add(state.id);
  if (state.generationJob) ids.add(state.generationJob.jobId);
  for (const annotation of state.annotations) ids.add(annotation.id);
  if (state.document) for (const id of collectPlanElementIds(state.document)) ids.add(id);
}

async function loadLocatedState(rootDir: string, locator: PlanBranchLocator): Promise<{ readonly ok: true; readonly state: PlanSession } | { readonly ok: false; readonly warning: "invalid-state" | "invalid-revision" }> {
  if (locator.artifactPath !== resolve(rootDir, locator.sessionId) || !contained(rootDir, locator.artifactPath)) return { ok: false, warning: "invalid-state" };
  try {
    const rootReal = await realpath(rootDir); const artifactReal = await realpath(locator.artifactPath);
    if (!contained(rootReal, artifactReal)) return { ok: false, warning: "invalid-state" };
    const statePath = join(locator.artifactPath, "states", `${locator.stateVersion}-${locator.stateSha256}.session.json`);
    const raw = await readRegularFile(statePath);
    if (sha256(raw) !== locator.stateSha256) return { ok: false, warning: "invalid-state" };
    const parsed: unknown = JSON.parse(raw.toString("utf8")); const result = validatePlanSession(parsed);
    if (!result.ok || !raw.equals(canonicalBytes(result.value))) return { ok: false, warning: "invalid-state" };
    const state = result.value;
    if (state.id !== locator.sessionId || state.status !== locator.status || state.stateVersion !== locator.stateVersion || state.documentRevision !== locator.documentRevision) return { ok: false, warning: "invalid-state" };
    if (state.document !== null) {
      const revisionBytes = canonicalBytes(state.document); const revisionSha = sha256(revisionBytes);
      const revisionPath = join(locator.artifactPath, "revisions", `${state.documentRevision}-${revisionSha}.plan.json`);
      const revisionRaw = await readRegularFile(revisionPath);
      if (!revisionRaw.equals(revisionBytes) || sha256(revisionRaw) !== revisionSha) return { ok: false, warning: "invalid-revision" };
    }
    return { ok: true, state };
  } catch { return { ok: false, warning: "invalid-state" }; }
}
async function snapshotFiles(directory: string, names: readonly string[]): Promise<ReadonlyMap<string, Buffer | null>> {
  const values = new Map<string, Buffer | null>();
  for (const name of names) { try { values.set(name, await readRegularFile(join(directory, name))); } catch { values.set(name, null); } }
  return values;
}
async function restoreFiles(directory: string, names: readonly string[], prior: ReadonlyMap<string, Buffer | null>): Promise<void> {
  for (const name of names) {
    const value = prior.get(name); const path = join(directory, name);
    try { if (value === null || value === undefined) await unlink(path); else await atomicPrivateWrite(path, value); } catch { /* rollback is best effort */ }
  }
}
async function fileEquals(path: string, expected: Buffer): Promise<boolean> { try { return (await readRegularFile(path)).equals(expected); } catch { return false; } }
async function readRegularFile(path: string): Promise<Buffer> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile()) throw repositoryError("unsafe-file", "Persistence path is not a regular file.");
  return readFile(path);
}
function contained(root: string, target: string): boolean { const path = relative(root, target); return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isLocatorScan(value: readonly PlanBranchLocator[] | LocatorScan): value is LocatorScan { return !Array.isArray(value); }
function isCanonicalTimestamp(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function hasCode(error: unknown, code: string): boolean { return isRecord(error) && error.code === code; }
function ensureOpen(closed: boolean): void { if (closed) throw repositoryError("repository-closed", "Plan repository is closed."); }
function repositoryError(code: string, message: string): PlanRepositoryError { return new PlanRepositoryError(code, message); }
