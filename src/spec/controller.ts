import type { DispatchableSpecGenerator, SpecGeneratorResult, SpecWriterSubmission } from "./generator.js";
import { SPEC_LIMITS, validateSpecMarkdown, validateSpecSession } from "./schema.js";
import { createSpecRangeTarget, reconcileSpecRevision } from "./reconciliation.js";
import { sameSpecSource } from "./source.js";
import type { CapturedSpecSource, SpecComment, SpecCommentStatus, SpecOperation, SpecResult, SpecSession } from "./types.js";
import type { CommitAcceptedSpecInput, CommitSpecInput, SpecAuditKind } from "./repository.js";

export interface SpecControllerRepository { commit(input: CommitSpecInput): Promise<{ readonly state: SpecSession }>; commitAccepted(input: CommitAcceptedSpecInput): Promise<{ readonly state: SpecSession }>; close(): Promise<void> }
export interface SpecSourcePort { fresh(): Promise<{ readonly ok: true; readonly value: CapturedSpecSource } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }> }
export interface SpecStager { stage(payload: string): void | Promise<void> }
export interface SpecControllerOptions { readonly repository: SpecControllerRepository; readonly generator: DispatchableSpecGenerator; readonly appendLocator: CommitSpecInput["appendLocator"]; readonly source: SpecSourcePort; readonly idFactory: () => string; readonly clock: () => Date | string; readonly stager: SpecStager }
export interface SpecControllerEvent { readonly kind: SpecAuditKind; readonly planSessionId: string; readonly status: SpecSession["status"]; readonly stateVersion: number; readonly specRevision: number; readonly errorCode?: string }
export interface SpecJobHandle { readonly jobId: string; readonly completion: Promise<SpecResult> }
interface RuntimeJob { readonly id: string; readonly abort: AbortController; readonly source: CapturedSpecSource }

export class SpecController {
  readonly #options: SpecControllerOptions; readonly #listeners = new Set<(event: SpecControllerEvent) => void>(); readonly #ids = new Set<string>();
  #state: SpecSession; #active: RuntimeJob | null = null; #tail: Promise<void> = Promise.resolve(); #closing = false; #closed = false; #closePromise: Promise<void> | null = null; #staged = false;
  private constructor(options: SpecControllerOptions, state: SpecSession, ids: Iterable<string>) { this.#options = options; this.#state = state; for (const id of ids) this.#ids.add(id); for (const comment of state.comments) this.#ids.add(comment.id); if (state.generationJob) this.#ids.add(state.generationJob.jobId); }
  static async create(options: SpecControllerOptions, captured: CapturedSpecSource): Promise<SpecResult<SpecController>> {
    const state: SpecSession = { schemaVersion: 1, planSessionId: captured.reference.planSessionId, stateVersion: 1, specRevision: 0, status: "paused", source: captured.reference, markdown: null, comments: [] };
    const valid = validateSpecSession(state); if (!valid.ok) return failure("invalid-source", "The captured Spec source is invalid.");
    try { const committed = await options.repository.commit({ session: valid.value, previous: null, eventKind: "created", appendLocator: options.appendLocator }); return success(new SpecController(options, committed.state, [])); } catch { return failure("persistence-failed", "The Spec sidecar could not be created."); }
  }
  static async fromRecovered(options: SpecControllerOptions, state: SpecSession, ids: Iterable<string>): Promise<SpecResult<SpecController>> {
    const valid = validateSpecSession(state); if (!valid.ok) return failure("invalid-recovered-state", "Recovered Spec state is invalid.");
    const controller = new SpecController(options, valid.value, ids); const job = valid.value.generationJob;
    if (!job) return success(controller);
    const recovered: SpecSession = { ...valid.value, stateVersion: valid.value.stateVersion + 1, status: job.operation === "initial" ? "paused" : "error", generationJob: undefined, lastError: { code: "generation-interrupted", message: "Spec generation was interrupted during recovery. Retry to continue." } };
    const committed = await controller.#commit(recovered, valid.value, "state-changed"); return committed.ok ? success(controller) : committed;
  }
  snapshot(): SpecSession { return this.#state; }
  acceptedStagingPending(): boolean { return this.#state.status === "accepted" && !this.#staged; }
  subscribe(listener: (event: SpecControllerEvent) => void): () => void { if (this.#unavailable()) return () => undefined; this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  configureWriterEndpoint(url: string): SpecResult { return this.#unavailable() ? failure("controller-closed", "Spec controller is closed.") : this.#options.generator.configureWriterEndpoint(url); }
  dispatchGeneration(jobId: string): SpecResult { if (this.#unavailable()) return failure("controller-closed", "Spec controller is closed."); return !this.#active || this.#active.id !== jobId ? failure("job-stale", "Spec generation job is stale.") : this.#options.generator.dispatch(jobId); }
  submitWriterResult(input: SpecWriterSubmission): Promise<SpecResult> { if (this.#unavailable()) return Promise.resolve(failure("controller-closed", "Spec controller is closed.")); const job = this.#state.generationJob; return !job || !this.#active || this.#active.id !== job.jobId || input.planSessionId !== this.#state.planSessionId || input.jobId !== job.jobId || input.operation !== job.operation || input.baseSpecRevision !== job.baseSpecRevision ? Promise.resolve(failure("writer-submission-stale", "Spec writer submission is not active.")) : this.#options.generator.submitWriterResult(input); }
  generate(input: { readonly expectedStateVersion: number; readonly instruction?: string }): Promise<SpecResult<SpecJobHandle>> { return this.#start("initial", input.expectedStateVersion, [], input.instruction, false); }
  generateFresh(input: { readonly expectedStateVersion: number }): Promise<SpecResult<SpecJobHandle>> { return this.#start("initial", input.expectedStateVersion, [], undefined, true); }
  revise(input: { readonly expectedStateVersion: number; readonly selectedCommentIds: readonly string[]; readonly instruction?: string }): Promise<SpecResult<SpecJobHandle>> { return this.#start("revision", input.expectedStateVersion, input.selectedCommentIds, input.instruction, false); }
  async addComment(input: { readonly expectedStateVersion: number; readonly start: number; readonly end: number; readonly body: string }): Promise<SpecResult> { return this.#enqueue(async () => { const current = this.#mutable(input.expectedStateVersion); if (!current.ok) return current; if (!current.value.markdown || current.value.status !== "ready") return failure("spec-not-ready", "Comments require a ready Spec."); const body = input.body.trim(); if (!body || [...body].length > SPEC_LIMITS.commentBodyCodePoints) return failure("invalid-comment", "Spec comment body is invalid."); const target = createSpecRangeTarget(current.value.markdown, current.value.specRevision, input.start, input.end); if (!target.ok) return target; const id = this.#allocate(); if (!id.ok) return id; const at = this.#now(); const comment: SpecComment = { id: id.value, target: target.value, originalTarget: target.value, body, status: "open", history: [], createdAt: at, updatedAt: at }; const result = await this.#commit({ ...current.value, stateVersion: current.value.stateVersion + 1, comments: [...current.value.comments, comment] }, current.value, "state-changed"); if (result.ok) this.#ids.add(id.value); return result; }); }
  async editComment(input: { readonly expectedStateVersion: number; readonly commentId: string; readonly body: string }): Promise<SpecResult> { return this.#changeComment(input, (comment) => { const body = input.body.trim(); return !body || [...body].length > SPEC_LIMITS.commentBodyCodePoints ? failure("invalid-comment", "Spec comment body is invalid.") : success({ ...comment, body, updatedAt: this.#now() }); }); }
  async transitionComment(input: { readonly expectedStateVersion: number; readonly commentId: string; readonly status: "open" | "dismissed" }): Promise<SpecResult> { return this.#changeComment(input, (comment) => { if (comment.status === "addressed" || comment.status === "orphaned") return failure("invalid-status", "Addressed or orphaned comments cannot be changed manually."); return success(this.#transition(comment, input.status)); }); }
  pause(input: { readonly expectedStateVersion: number }): Promise<SpecResult> { return this.#stop(input.expectedStateVersion, "paused", "paused"); }
  cancel(input: { readonly expectedStateVersion: number }): Promise<SpecResult> { return this.#stop(input.expectedStateVersion, "cancelled", "cancelled"); }
  async accept(input: { readonly expectedStateVersion: number; readonly specRevision: number; readonly confirmed: boolean }): Promise<SpecResult> {
    if (this.#unavailable()) return failure("controller-closed", "Spec controller is closed.");
    if (!input.confirmed) return failure("confirmation-required", "Spec acceptance requires confirmation.");
    const captured = this.#state;
    const retry = captured.status === "accepted" && !this.#staged;
    if ((!retry && captured.status !== "ready") || !captured.markdown || captured.stateVersion !== input.expectedStateVersion || captured.specRevision !== input.specRevision) return failure("state-conflict", "Spec is not ready at the expected version.");
    // A staging retry uses the immutable accepted artifact. It must not consult mutable Plan source after acceptance committed.
    if (retry) return this.#enqueue(async () => {
      const accepted = this.#state;
      if (this.#unavailable()) return failure("controller-closed", "Spec controller is closed.");
      if (this.#staged || accepted !== captured || accepted.status !== "accepted" || !accepted.markdown || accepted.stateVersion !== input.expectedStateVersion || accepted.specRevision !== input.specRevision) return failure("state-conflict", "Accepted Spec staging is not pending at the expected version.");
      return this.#stageAccepted(accepted);
    });
    let fresh; try { fresh = await this.#options.source.fresh(); } catch { return failure("source-unavailable", "Fresh Plan and Adversarial Review source could not be verified."); }
    return this.#enqueue(async () => {
      if (this.#unavailable()) return failure("controller-closed", "Spec controller is closed.");
      const current = this.#state;
      if (current !== captured || current.status !== "ready" || !current.markdown || current.stateVersion !== input.expectedStateVersion || current.specRevision !== input.specRevision) return failure("state-conflict", "Spec is not ready at the expected version.");
      if (!fresh.ok) return fresh;
      if (!sameSpecSource(captured.source, fresh.value.reference)) return failure("stale-spec-source", "Plan or Adversarial Review source changed before Spec acceptance.");
      const next = { ...current, stateVersion: current.stateVersion + 1, status: "accepted" as const };
      const committed = await this.#commitAccepted(next, current); if (!committed.ok) return committed;
      return this.#stageAccepted(this.#state);
    });
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    const active = this.#active;
    this.#closePromise = (async () => {
      if (active) {
        await this.#enqueue(async () => {
          const current = this.#state;
          if (this.#active?.id !== active.id || current.generationJob?.jobId !== active.id) return;
          const result = await this.#commit({ ...current, stateVersion: current.stateVersion + 1, status: "paused", generationJob: undefined }, current, "paused");
          if (result.ok) this.#active = null;
        });
        active.abort.abort();
      }
      await this.#tail;
      await this.#options.generator.close();
      await this.#options.repository.close();
    })().finally(() => { this.#listeners.clear(); this.#closed = true; });
    return this.#closePromise;
  }
  async #start(operation: SpecOperation, expected: number, selected: readonly string[], instruction: string | undefined, rebase: boolean): Promise<SpecResult<SpecJobHandle>> {
    if (this.#unavailable()) return failure("controller-closed", "Spec controller is closed.");
    if (instruction !== undefined && Buffer.byteLength(instruction.trim(), "utf8") > SPEC_LIMITS.instructionBytes) return failure("invalid-instruction", "Spec instruction is too long.");
    let fresh; try { fresh = await this.#options.source.fresh(); } catch { return failure("source-unavailable", "Fresh Plan and Adversarial Review source could not be verified."); } if (!fresh.ok) return fresh;
    const started = await this.#enqueue(async (): Promise<SpecResult<{ readonly state: SpecSession; readonly runtime: RuntimeJob }>> => {
      const current = this.#mutable(expected); if (!current.ok) return current;
      if (this.#active || current.value.generationJob) return failure("job-active", "A Spec generation job is active.");
      const sourceChanged = !sameSpecSource(current.value.source, fresh.value.reference);
      if (rebase && !sourceChanged) return failure("spec-source-current", "The Spec already uses the current Plan and Adversarial Review source.");
      if (!rebase && sourceChanged) return failure("stale-spec-source", "Plan or Adversarial Review source changed; generate a fresh Spec.");
      if (rebase && !["paused", "ready", "error"].includes(current.value.status)) return failure("invalid-status", "Fresh Spec generation is unavailable.");
      if (!rebase && operation === "initial" && (current.value.markdown !== null || !["paused", "error"].includes(current.value.status))) return failure("invalid-status", "Initial Spec generation is unavailable.");
      if (operation === "revision" && (current.value.markdown === null || !["ready", "error"].includes(current.value.status))) return failure("invalid-status", "Spec revision is unavailable.");
      if (new Set(selected).size !== selected.length || selected.some((id) => !current.value.comments.some((comment) => comment.id === id && comment.status === "open"))) return failure("invalid-comments", "Selected Spec comments must be unique and open.");
      const id = this.#allocate(); if (!id.ok) return id;
      const runtime = { id: id.value, abort: new AbortController(), source: fresh.value };
      const base: SpecSession = rebase ? { ...current.value, specRevision: 0, source: fresh.value.reference, markdown: null, comments: [] } : current.value;
      const next: SpecSession = { ...base, stateVersion: current.value.stateVersion + 1, status: operation === "initial" ? "generating" : "revising", generationJob: { jobId: id.value, operation, baseSpecRevision: base.specRevision, selectedCommentIds: [...selected], source: base.source, ...(instruction?.trim() ? { instruction: instruction.trim() } : {}), startedAt: this.#now() }, lastError: undefined };
      const committed = await this.#commit(next, current.value, rebase ? "rebased" : "state-changed"); if (!committed.ok) return committed;
      this.#active = runtime; this.#ids.add(id.value); return success({ state: next, runtime });
    });
    if (!started.ok) return started; return success({ jobId: started.value.runtime.id, completion: this.#run(started.value.state, started.value.runtime) });
  }
  async #run(started: SpecSession, runtime: RuntimeJob): Promise<SpecResult> { const job = started.generationJob!; let result: SpecGeneratorResult; try { result = await this.#options.generator.generate({ session: started, source: runtime.source, jobId: job.jobId, operation: job.operation, selectedCommentIds: job.selectedCommentIds, ...(job.instruction ? { instruction: job.instruction } : {}), signal: runtime.abort.signal }); } catch { result = { ok: false, error: { code: "generation-failed", message: "Spec generation failed." } }; } return this.#enqueue(async () => { if (this.#unavailable()) return failure("controller-closed", "Spec controller is closed."); const current = this.#state; if (!current.generationJob || current.generationJob.jobId !== job.jobId || this.#active?.id !== job.jobId) return failure("job-stale", "Late Spec result was ignored."); this.#active = null; if (!result.ok) return this.#commit({ ...current, stateVersion: current.stateVersion + 1, status: "error", generationJob: undefined, lastError: result.error }, current, "state-changed");
      const markdown = validateSpecMarkdown(result.markdown); if (!markdown.ok) return this.#commit({ ...current, stateVersion: current.stateVersion + 1, status: "error", generationJob: undefined, lastError: { code: markdown.issues[0]?.code ?? "invalid-spec", message: markdown.issues[0]?.message ?? "Spec Markdown is invalid." } }, current, "state-changed");
      let fresh; try { fresh = await this.#options.source.fresh(); } catch { fresh = { ok: false as const, error: { code: "source-unavailable", message: "Fresh Plan and Adversarial Review source could not be verified." } }; } if (!fresh.ok || !sameSpecSource(current.source, fresh.value.reference)) { const error = fresh.ok ? { code: "stale-spec-source", message: "Plan or Adversarial Review changed while Spec generation was active." } : fresh.error; return this.#commit({ ...current, stateVersion: current.stateVersion + 1, status: "error", generationJob: undefined, lastError: error }, current, "state-changed"); }
      if (job.operation === "initial") return this.#commit({ ...current, stateVersion: current.stateVersion + 1, specRevision: 1, status: "ready", markdown: markdown.value, comments: [], generationJob: undefined, lastError: undefined }, current, "revision-committed"); const addressed = job.selectedCommentIds; const comments = reconcileSpecRevision({ previousMarkdown: current.markdown!, nextMarkdown: markdown.value, previousRevision: current.specRevision, comments: current.comments, selectedCommentIds: job.selectedCommentIds, addressedCommentIds: addressed, now: this.#now() }); if (!comments.ok) return this.#commit({ ...current, stateVersion: current.stateVersion + 1, status: "error", generationJob: undefined, lastError: comments.error }, current, "state-changed"); return this.#commit({ ...current, stateVersion: current.stateVersion + 1, specRevision: current.specRevision + 1, status: "ready", markdown: markdown.value, comments: comments.value, generationJob: undefined, lastError: undefined }, current, "revision-committed"); }); }
  async #changeComment(input: { readonly expectedStateVersion: number; readonly commentId: string }, change: (comment: SpecComment) => SpecResult<SpecComment>): Promise<SpecResult> { return this.#enqueue(async () => { const current = this.#mutable(input.expectedStateVersion); if (!current.ok) return current; if (current.value.generationJob?.selectedCommentIds.includes(input.commentId)) return failure("comment-locked", "Selected comment is locked during revision."); const index = current.value.comments.findIndex((comment) => comment.id === input.commentId); const comment = current.value.comments[index]; if (!comment) return failure("comment-not-found", "Spec comment does not exist."); const changed = change(comment); if (!changed.ok) return changed; const comments = [...current.value.comments]; comments[index] = changed.value; return this.#commit({ ...current.value, stateVersion: current.value.stateVersion + 1, comments }, current.value, "state-changed"); }); }
  #transition(comment: SpecComment, status: SpecCommentStatus): SpecComment { if (comment.status === status) return comment; const at = this.#now(); return { ...comment, status, history: [...comment.history, { from: comment.status, to: status, at }], updatedAt: at }; }
  async #stop(expected: number, status: "paused" | "cancelled", kind: "paused" | "cancelled"): Promise<SpecResult> { return this.#enqueue(async () => { const current = this.#mutable(expected); if (!current.ok) return current; const runtime = this.#active; const result = await this.#commit({ ...current.value, stateVersion: current.value.stateVersion + 1, status, generationJob: undefined }, current.value, kind); if (result.ok) { runtime?.abort.abort(); this.#active = null; } return result; }); }
  #mutable(expected: number): SpecResult<SpecSession> { if (this.#unavailable()) return failure("controller-closed", "Spec controller is closed."); if (["accepted", "cancelled"].includes(this.#state.status)) return failure("terminal-state", "Spec is terminal."); return this.#state.stateVersion === expected ? success(this.#state) : failure("state-conflict", "Expected Spec state is stale."); }
  #unavailable(): boolean { return this.#closing || this.#closed; }
  async #commit(next: SpecSession, previous: SpecSession, eventKind: SpecAuditKind): Promise<SpecResult> { const valid = validateSpecSession(next); if (!valid.ok) return failure("invalid-state", valid.issues[0]?.message ?? "Spec state is invalid."); try { const committed = await this.#options.repository.commit({ session: valid.value, previous, eventKind, appendLocator: this.#options.appendLocator }); this.#state = committed.state; this.#publish(eventKind); return success(undefined); } catch { return failure("persistence-failed", "Spec state could not be saved."); } }
  async #commitAccepted(next: SpecSession, previous: SpecSession): Promise<SpecResult> { const valid = validateSpecSession(next); if (!valid.ok || !next.markdown) return failure("invalid-state", "Accepted Spec state is invalid."); try { const committed = await this.#options.repository.commitAccepted({ session: valid.value, previous, eventKind: "accepted", finalMarkdown: next.markdown, appendLocator: this.#options.appendLocator }); this.#state = committed.state; this.#publish("accepted"); return success(undefined); } catch { return failure("persistence-failed", "Accepted Spec could not be saved."); } }
  async #stageAccepted(accepted: SpecSession): Promise<SpecResult> { try { await this.#options.stager.stage(formatAcceptedSpec(accepted)); this.#staged = true; return success(undefined); } catch { return failure("stage-failed", "Accepted Spec was saved but could not be sent to the agent."); } }
  #publish(kind: SpecAuditKind): void { const event = Object.freeze({ kind, planSessionId: this.#state.planSessionId, status: this.#state.status, stateVersion: this.#state.stateVersion, specRevision: this.#state.specRevision, ...(this.#state.lastError ? { errorCode: this.#state.lastError.code } : {}) }); for (const listener of this.#listeners) try { listener(event); } catch {} }
  #enqueue<T>(work: () => Promise<T>): Promise<T> { const run = this.#tail.then(work, work); this.#tail = run.then(() => undefined, () => undefined); return run; }
  #allocate(): SpecResult<string> { for (let attempt = 0; attempt < 8; attempt += 1) { let id: string; try { id = this.#options.idFactory(); } catch { break; } if (/^[!-~]{1,64}$/u.test(id) && !this.#ids.has(id)) return success(id); } return failure("id-allocation-failed", "A unique Spec ID could not be allocated."); }
  #now(): string { const raw = this.#options.clock(); return raw instanceof Date ? raw.toISOString() : raw; }
}

export function formatAcceptedSpec(session: SpecSession): string {
  if (!session.markdown) throw new Error("spec-not-materialized");
  const source = session.source;
  const dispatch = [
    "Authenticated Spec implementation dispatch",
    "You are the current main Pi agent. IMPLEMENT the authenticated specification now in the current repository.",
    "Continue through implementation and verification. Do not merely acknowledge receipt, report readiness, or stop after producing another plan.",
    "The exact accepted Spec Markdown at the end of this message is authoritative. Do not rewrite it before implementation.",
    "Use the Plan and Adversarial Review references below as source context. Follow the current session's normal permissions and instructions.",
    "Do not create /create-goal or issue-tracker items. Do not commit, push, deploy, install dependencies, or start services unless the user has explicitly authorized that action.",
    "",
    "Authenticated Spec source",
    `Plan session: ${source.planSessionId}`,
    `Plan artifact: ${source.planArtifactPath}`,
    `Plan Markdown: ${source.planMarkdownPath}`,
    `Plan annotations: ${source.annotationsPath}`,
    `Plan revision: ${source.planDocumentRevision}`,
    `Plan state revision: ${source.planStateVersion}`,
    `Adversarial Review: ${source.grillPath}${source.grillPointer}`,
    `Adversarial Review based-on revision: ${source.grillBasedOnDocumentRevision}`,
    `Adversarial Review state revision: ${source.grillStateVersion}`,
  ].join("\n");
  return `${dispatch}\n\n${session.markdown}`;
}
function success<T>(value: T): SpecResult<T> { return { ok: true, value }; }
function failure<T = never>(code: string, message: string): SpecResult<T> { return { ok: false, error: { code, message } }; }
