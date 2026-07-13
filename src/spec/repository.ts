import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateSpecBranchLocator, type SpecLocatorScan } from "./locator.js";
import { validateSpecSession } from "./schema.js";
import type { AcceptedSpecPayload, AppendSpecBranchLocator, SpecBranchLocator, SpecSession } from "./types.js";

export type SpecAuditKind = "created" | "rebased" | "state-changed" | "revision-committed" | "accepted" | "paused" | "cancelled";
export interface CommitSpecInput { readonly session: SpecSession; readonly previous: SpecSession | null; readonly eventKind: SpecAuditKind; readonly appendLocator: AppendSpecBranchLocator }
export interface CommitAcceptedSpecInput extends CommitSpecInput { readonly eventKind: "accepted"; readonly finalMarkdown: string }
export interface RecoveredSpecState { readonly state: SpecSession | null; readonly locator: SpecBranchLocator | null; readonly warnings: readonly string[] }
export interface SpecRepository { readonly rootDir: string; commit(input: CommitSpecInput): Promise<{ readonly state: SpecSession; readonly locator: SpecBranchLocator }>; commitAccepted(input: CommitAcceptedSpecInput): Promise<{ readonly state: SpecSession; readonly locator: SpecBranchLocator }>; recover(input: readonly SpecBranchLocator[] | SpecLocatorScan): Promise<RecoveredSpecState>; close(): Promise<void> }
export class SpecRepositoryError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "SpecRepositoryError"; } }

/** rootDir is the Plan repository root; every sidecar lives at <root>/<plan-session>/spec. */
export function createSpecRepository(options: { readonly rootDir: string; readonly clock?: () => Date | string }): SpecRepository {
  const rootDir = resolve(options.rootDir); const clock = options.clock ?? (() => new Date()); let closed = false;
  const known = new Map<string, { readonly stateVersion: number; readonly hash: string }>();
  const commitInternal = async (input: CommitSpecInput, finalMarkdown?: string) => {
    if (closed) throw error("repository-closed", "Spec repository is closed.");
    const session = validated(input.session); const previous = input.previous === null ? null : validated(input.previous); transition(session, previous, input.eventKind);
    if (session.source.planArtifactPath !== resolve(rootDir, session.planSessionId)) throw error("source-path-mismatch", "Spec source does not match its Plan session path.");
    if ((session.status === "accepted") !== (finalMarkdown !== undefined)) throw error("accepted-final-mismatch", "Accepted Spec and final Markdown must commit atomically.");
    if (finalMarkdown !== undefined && finalMarkdown !== session.markdown) throw error("final-spec-mismatch", "Final Spec bytes must equal the accepted Markdown exactly.");
    const latest = known.get(session.planSessionId); if (latest && (!previous || latest.stateVersion !== previous.stateVersion || latest.hash !== sha(canonical(previous)))) throw error("stale-previous", "The previous Spec state is stale.");
    const artifactPath = await privateDirectory(rootDir, session.planSessionId); const stateBytes = canonical(session); const stateSha256 = sha(stateBytes); const at = now(clock);
    await immutable(join(artifactPath, "states", `${session.stateVersion}-${stateSha256}.spec.json`), stateBytes);
    if (session.markdown !== null) { const bytes = Buffer.from(session.markdown, "utf8"); await immutable(join(artifactPath, "revisions", `${session.specRevision}-${sha(bytes)}.spec.md`), bytes); }
    const names = ["spec.json", "comments.json", "spec.md", ...(finalMarkdown === undefined ? [] : ["final-spec.md"])]; const prior = await snapshots(artifactPath, names);
    try {
      await atomic(join(artifactPath, "spec.json"), stateBytes); await atomic(join(artifactPath, "comments.json"), canonical(session.comments));
      if (session.markdown !== null) await atomic(join(artifactPath, "spec.md"), Buffer.from(session.markdown, "utf8"));
      else await absent(join(artifactPath, "spec.md"));
      if (finalMarkdown !== undefined) await atomic(join(artifactPath, "final-spec.md"), Buffer.from(finalMarkdown, "utf8"));
      const locator: SpecBranchLocator = Object.freeze({ schemaVersion: 1, planSessionId: session.planSessionId, artifactPath, status: session.status, stateVersion: session.stateVersion, specRevision: session.specRevision, stateSha256, committedAt: at });
      try { input.appendLocator(locator); } catch { await restore(artifactPath, prior); throw error("locator-append-failed", "Could not append the Spec locator."); }
      known.set(session.planSessionId, { stateVersion: session.stateVersion, hash: stateSha256 }); return Object.freeze({ state: session, locator });
    } catch (cause) { if (cause instanceof SpecRepositoryError) throw cause; await restore(artifactPath, prior); throw error("commit-failed", "Could not commit Spec state."); }
  };
  return Object.freeze({ rootDir,
    commit: (input: CommitSpecInput) => commitInternal(input),
    commitAccepted: (input: CommitAcceptedSpecInput) => commitInternal(input, input.finalMarkdown),
    async recover(input: readonly SpecBranchLocator[] | SpecLocatorScan) {
      if (closed) throw error("repository-closed", "Spec repository is closed."); const scan = Array.isArray(input) ? null : input as SpecLocatorScan; const supplied: readonly SpecBranchLocator[] = scan ? scan.locators : input as readonly SpecBranchLocator[]; const warnings: string[] = !scan || scan.invalidEntries === 0 ? [] : ["invalid-locator"];
      for (const raw of supplied) { const locator = validateSpecBranchLocator(raw, rootDir); if (!locator) { warnings.push("invalid-locator"); continue; } try {
        await validateRecoveryArtifact(rootDir, locator);
        const path = join(locator.artifactPath, "states", `${locator.stateVersion}-${locator.stateSha256}.spec.json`); const bytes = await regular(path); if (sha(bytes) !== locator.stateSha256) throw new Error(); const parsed: unknown = JSON.parse(bytes.toString("utf8")); const result = validateSpecSession(parsed); if (!result.ok || !bytes.equals(canonical(result.value))) throw new Error(); const state = result.value;
        if (state.planSessionId !== locator.planSessionId || state.source.planArtifactPath !== resolve(rootDir, state.planSessionId) || state.stateVersion !== locator.stateVersion || state.specRevision !== locator.specRevision || state.status !== locator.status) throw new Error();
        if (state.markdown !== null) { const revision = Buffer.from(state.markdown, "utf8"); if (!(await regular(join(locator.artifactPath, "revisions", `${state.specRevision}-${sha(revision)}.spec.md`))).equals(revision)) throw new Error(); await atomic(join(locator.artifactPath, "spec.md"), revision); if (state.status === "accepted") await atomic(join(locator.artifactPath, "final-spec.md"), revision); else await absent(join(locator.artifactPath, "final-spec.md")); }
        else { await absent(join(locator.artifactPath, "spec.md")); await absent(join(locator.artifactPath, "final-spec.md")); }
        await atomic(join(locator.artifactPath, "spec.json"), canonical(state)); await atomic(join(locator.artifactPath, "comments.json"), canonical(state.comments)); known.set(state.planSessionId, { stateVersion: state.stateVersion, hash: locator.stateSha256 }); return { state, locator, warnings: Object.freeze(warnings) };
      } catch { warnings.push("invalid-state"); } }
      return { state: null, locator: null, warnings: Object.freeze(warnings) };
    },
    async close() { closed = true; },
  });
}
export function acceptedSpecPayload(session: SpecSession): AcceptedSpecPayload {
  if (session.status !== "accepted" || session.markdown === null) throw error("not-accepted", "Spec is not accepted."); const source = session.source;
  return Object.freeze({ kind: "spec", plan: { sessionId: source.planSessionId, artifactPath: source.planArtifactPath, planMarkdownPath: source.planMarkdownPath, annotationsPath: source.annotationsPath, documentRevision: source.planDocumentRevision, stateVersion: source.planStateVersion }, grill: { path: source.grillPath, pointer: source.grillPointer, basedOnDocumentRevision: source.grillBasedOnDocumentRevision, stateVersion: source.grillStateVersion }, markdown: session.markdown });
}
function validated(session: SpecSession): SpecSession { const result = validateSpecSession(session); if (!result.ok) throw error("invalid-session", "Spec session validation failed."); return result.value; }
function transition(next: SpecSession, previous: SpecSession | null, eventKind: SpecAuditKind): void {
  if (!previous) { if (eventKind !== "created" || next.stateVersion !== 1 || next.specRevision !== 0) throw error("invalid-initial-state", "Initial Spec versions are invalid."); return; }
  if (next.planSessionId !== previous.planSessionId || next.stateVersion !== previous.stateVersion + 1) throw error("invalid-transition", "Spec state versions must advance exactly.");
  if (eventKind === "rebased") {
    const job = next.generationJob;
    if (["accepted", "cancelled"].includes(previous.status) || sameSource(next, previous) || next.specRevision !== 0 || next.markdown !== null || next.comments.length !== 0 || next.status !== "generating" || next.lastError !== undefined || job?.operation !== "initial" || job.baseSpecRevision !== 0) throw error("invalid-rebase", "A Spec rebase must start a fresh generation from changed source.");
    return;
  }
  if (next.specRevision < previous.specRevision || next.specRevision > previous.specRevision + 1) throw error("invalid-transition", "Spec revisions must advance monotonically.");
  const same = next.markdown === previous.markdown; if (same !== (next.specRevision === previous.specRevision)) throw error("invalid-revision", "Spec Markdown and revision disagree.");
}
function sameSource(next: SpecSession, previous: SpecSession): boolean { return JSON.stringify(next.source) === JSON.stringify(previous.source); }
async function privateDirectory(root: string, id: string): Promise<string> { if (!isAbsolute(root)) throw error("unsafe-root", "Spec root must be absolute."); const plan = resolve(root, id); const artifact = resolve(plan, "spec"); if (!contained(root, plan) || !contained(root, artifact)) throw error("unsafe-path", "Spec path escapes its root."); await directory(root); await directory(plan); await directory(artifact); await directory(join(artifact, "states")); await directory(join(artifact, "revisions")); const realRoot = await realpath(root); const realArtifact = await realpath(artifact); if (!contained(realRoot, realArtifact)) throw error("unsafe-path", "Spec path escapes through a link."); return artifact; }
async function validateRecoveryArtifact(root: string, locator: SpecBranchLocator): Promise<void> { const plan = resolve(root, locator.planSessionId); const artifact = resolve(plan, "spec"); if (locator.artifactPath !== artifact || !contained(root, plan) || !contained(root, artifact)) throw error("unsafe-path", "Spec recovery path escapes its root."); for (const path of [root, plan, artifact, join(artifact, "states"), join(artifact, "revisions")]) { const stat = await lstat(path); if (stat.isSymbolicLink() || !stat.isDirectory()) throw error("unsafe-directory", "Spec recovery path is unsafe."); } const realRoot = await realpath(root); const realPlan = await realpath(plan); const realArtifact = await realpath(artifact); if (realPlan !== resolve(realRoot, locator.planSessionId) || realArtifact !== resolve(realPlan, "spec") || !contained(realRoot, realPlan) || !contained(realPlan, realArtifact)) throw error("unsafe-path", "Spec recovery path escapes through a link."); }
async function directory(path: string): Promise<void> { try { const stat = await lstat(path); if (stat.isSymbolicLink() || !stat.isDirectory()) throw error("unsafe-directory", "Spec path is unsafe."); } catch (cause) { if (!hasCode(cause, "ENOENT")) throw cause; await mkdir(path, { recursive: false, mode: 0o700 }); } await chmod(path, 0o700); }
async function immutable(path: string, bytes: Buffer): Promise<void> { let handle; try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.writeFile(bytes); await handle.sync(); } catch (cause) { if (!hasCode(cause, "EEXIST")) throw cause; if (!(await regular(path)).equals(bytes)) throw error("immutable-mismatch", "Content-addressed Spec artifact was changed."); } finally { await handle?.close(); } }
async function atomic(path: string, bytes: Buffer): Promise<void> { const temp = join(resolve(path, ".."), `.tmp-${randomBytes(16).toString("hex")}`); let handle; try { handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined; await rename(temp, path); await chmod(path, 0o600); } catch (cause) { try { await unlink(temp); } catch {} throw cause; } finally { await handle?.close(); } }
async function regular(path: string): Promise<Buffer> { const stat = await lstat(path); if (stat.isSymbolicLink() || !stat.isFile()) throw error("unsafe-file", "Spec artifact is unsafe."); return readFile(path); }
async function absent(path: string): Promise<void> { try { await unlink(path); } catch (cause) { if (!hasCode(cause, "ENOENT")) throw cause; } }
async function snapshots(dir: string, names: readonly string[]): Promise<Map<string, Buffer | null>> { const result = new Map<string, Buffer | null>(); for (const name of names) { try { result.set(name, await regular(join(dir, name))); } catch { result.set(name, null); } } return result; }
async function restore(dir: string, prior: ReadonlyMap<string, Buffer | null>): Promise<void> { for (const [name, bytes] of prior) try { if (bytes === null) await unlink(join(dir, name)); else await atomic(join(dir, name), bytes); } catch {} }
function canonical(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function now(clock: () => Date | string): string { const raw = clock(); const value = raw instanceof Date ? raw.toISOString() : raw; if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || new Date(value).toISOString() !== value) throw error("invalid-clock", "Spec clock is invalid."); return value; }
function contained(root: string, target: string): boolean { const path = relative(root, target); return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
function hasCode(value: unknown, code: string): boolean { return typeof value === "object" && value !== null && "code" in value && value.code === code; }
function error(code: string, message: string): SpecRepositoryError { return new SpecRepositoryError(code, message); }
