import { EXECUTION_LEADERSHIP_BOOTSTRAP, formatStagedPlan, renderPlanMarkdown } from "./classification.js";
import type {
  DispatchablePlanGenerator, PlanGeneratorInput, PlanGeneratorResult, PrivateSkillContent,
  WriterSubmissionInput, WriterSubmissionKind,
} from "./generator.js";
import type { AppendPlanBranchLocator } from "./locator.js";
import {
  allocateInitialPlanDocument, collectPlanElementIds, createAnnotation, transitionAnnotationStatus,
  type PlanIdFactory,
} from "./reconcile.js";
import { projectMarkdownPlan } from "./markdown-projection.js";
import type { CommitAcceptedPlanInput, CommitPlanInput, CommittedPlanState, PlanAuditKind } from "./repository.js";
import {
  PLAN_LIMITS, isMarkdownPlanProjection, normalizePlanText, validateClarificationAnswers, validatePlanAnnotations,
  validatePlanSession,
} from "./schema.js";
import type {
  Annotation, AnnotationStatus, AnnotationTarget, ClarificationAnswerEntry, ClarificationOrigin, ExecutionKind, GenerationMode,
  GrillAnnotationTargetDraft,
  PendingClarification, PlanDocument, PlanElement, PlanSession, SafeError, SkillReference, ValidationIssue, ValidationResult,
} from "./types.js";

export interface PlanControllerRepository {
  commit(input: CommitPlanInput): Promise<CommittedPlanState>;
  commitAccepted(input: CommitAcceptedPlanInput): Promise<CommittedPlanState>;
  close(): Promise<void>;
}
export interface PlanControllerGenerator extends DispatchablePlanGenerator {}
export interface LoadedPrivateSkills {
  readonly references: readonly SkillReference[];
  readonly contexts: readonly PrivateSkillContent[];
}
export interface PlanControllerSkillPort {
  reload(references: readonly SkillReference[]): Promise<ValidationResult<LoadedPrivateSkills>>;
  refresh(selectedNames: readonly string[], discovered: readonly unknown[]): Promise<ValidationResult<LoadedPrivateSkills>>;
}
export interface PlanControllerStager { stage(value: string): void | Promise<void> }
export interface PlanControllerEvent {
  readonly kind: Exclude<PlanAuditKind, "recovered">;
  readonly sessionId: string;
  readonly status: PlanSession["status"];
  readonly stateVersion: number;
  readonly documentRevision: number;
  readonly errorCode?: string;
}
export interface PlanControllerOptions {
  readonly repository: PlanControllerRepository;
  readonly generator: PlanControllerGenerator;
  readonly appendLocator: AppendPlanBranchLocator;
  readonly skills: PlanControllerSkillPort;
  readonly idFactory: PlanIdFactory;
  readonly clock: () => Date | string;
  readonly stager: PlanControllerStager;
}
export interface CreatePlanInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly skills: readonly SkillReference[];
  readonly execution: ExecutionKind;
  readonly mode: GenerationMode;
}
export interface RevisionInput { readonly expectedStateVersion: number; readonly selectedAnnotationIds: readonly string[]; readonly instruction?: string }
export interface GrillInput { readonly expectedStateVersion: number }
export interface ClarificationAnswerInput { readonly expectedStateVersion: number; readonly clarificationId: string; readonly answers: readonly ClarificationAnswerEntry[] }
export interface VersionedInput { readonly expectedStateVersion: number }
export interface WriterHttpSubmission { readonly attemptId: string; readonly kind: WriterSubmissionKind; readonly body: Buffer }
export interface PlanJobHandle { readonly jobId: string; readonly completion: Promise<PlanControllerResult> }
export type PlanControllerResult<T = void> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SafeError };

type EventKind = Exclude<PlanAuditKind, "recovered">;
interface JobRuntime { readonly id: string; readonly abort: AbortController }

/** Canonical snapshots contain private prompt and skill paths. HTTP/browser adapters must sanitize them. */
export class PlanController {
  readonly #options: PlanControllerOptions;
  readonly #reserved: Set<string>;
  readonly #listeners = new Set<(event: PlanControllerEvent) => void>();
  #state: PlanSession | null;
  #tail: Promise<void> = Promise.resolve();
  #active: JobRuntime | null = null;
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #acceptInFlight: Promise<PlanControllerResult> | null = null;
  #acceptedStaged = false;

  private constructor(options: PlanControllerOptions, state: PlanSession | null, reservedIds: Iterable<string>) {
    this.#options = options; this.#state = state; this.#reserved = new Set(reservedIds);
    if (state) this.#reserved.add(state.id);
    if (state?.generationJob) this.#reserved.add(state.generationJob.jobId);
    if (state?.document) for (const id of collectPlanElementIds(state.document)) this.#reserved.add(id);
    for (const annotation of state?.annotations ?? []) this.#reserved.add(annotation.id);
    for (const round of state?.clarifications?.history ?? []) this.#reserved.add(round.id);
    const pending = state?.clarifications?.pending; if (pending) this.#reserved.add(pending.id);
  }

  static async create(options: PlanControllerOptions, input: CreatePlanInput): Promise<PlanControllerResult<PlanController>> {
    const controller = new PlanController(options, null, []);
    const id = controller.#allocateId();
    if (!id.ok) return id;
    const candidate: PlanSession = {
      schemaVersion: 1, id: id.value, stateVersion: 1, documentRevision: 0, status: "paused",
      source: { prompt: input.prompt, cwd: input.cwd, skills: [...input.skills] }, execution: { kind: input.execution.kind },
      generation: { mode: input.mode }, document: null, annotations: [], clarifications: { history: [] },
    };
    const committed = await controller.#commit(candidate, null, "created");
    if (committed.ok) controller.#reserved.add(id.value);
    return committed.ok ? success(controller) : committed;
  }

  static fromRecovered(options: PlanControllerOptions, state: PlanSession, reservedIds: Iterable<string>): PlanControllerResult<PlanController> {
    if (reservedIds === undefined || reservedIds === null) return failure("reserved-ids-required", "Recovered sessions require committed historical IDs.");
    const validated = validatePlanSession(state);
    return validated.ok ? success(new PlanController(options, validated.value, reservedIds)) : failure("invalid-recovered-state", "The recovered plan state is invalid.");
  }

  snapshot(): PlanSession | null { return this.#state; }
  /** Privacy-safe host signal: accepted content still needs an explicit idempotent send attempt. */
  acceptedStagingPending(): boolean { return this.#state?.status === "accepted" && !this.#acceptedStaged; }
  subscribe(listener: (event: PlanControllerEvent) => void): () => void {
    if (this.#closed || this.#closing) return () => undefined;
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }

  async generate(input: { readonly expectedStateVersion: number; readonly instruction?: string }): Promise<PlanControllerResult<PlanJobHandle>> {
    return this.#startJob("initial", input.expectedStateVersion, [], input.instruction);
  }
  async revise(input: RevisionInput): Promise<PlanControllerResult<PlanJobHandle>> {
    return this.#startJob("revision", input.expectedStateVersion, input.selectedAnnotationIds, input.instruction);
  }
  async grill(input: GrillInput): Promise<PlanControllerResult<PlanJobHandle>> {
    return this.#startJob("grill", input.expectedStateVersion, []);
  }
  async resumeClarification(input: VersionedInput): Promise<PlanControllerResult<PlanJobHandle>> {
    const origin = this.#state?.clarifications?.origin;
    if (!origin || this.#state?.clarifications?.pending) return failure("clarification-conflict", "No interrupted clarification continuation is resumable.");
    return this.#startJob(origin.operation, input.expectedStateVersion, origin.selectedAnnotationIds, origin.instruction);
  }
  async answerClarification(input: ClarificationAnswerInput): Promise<PlanControllerResult<PlanJobHandle>> {
    const started = await this.#enqueue(async (): Promise<PlanControllerResult<{ readonly state: PlanSession; readonly runtime: JobRuntime }>> => {
      const current = this.#mutableState(input.expectedStateVersion); if (!current.ok) return current;
      const pending = current.value.clarifications?.pending;
      if (current.value.status !== "awaiting-clarification" || !pending || pending.id !== input.clarificationId) return failure("clarification-conflict", "The clarification batch is stale or already consumed.");
      if (this.#active || current.value.generationJob) return failure("job-active", "A generation job is already active.");
      const validatedAnswers = validateClarificationAnswers(input.answers, pending.questions); if (!validatedAnswers.ok) return validationFailure(validatedAnswers.issues);
      const allocated = this.#allocateId(); if (!allocated.ok) return allocated;
      const runtime = { id: allocated.value, abort: new AbortController() };
      const origin = originOf(pending); const status = origin.operation === "initial" ? "generating" : "revising";
      const answered = { id: pending.id, questions: pending.questions, answers: validatedAnswers.value, answeredAt: this.#now() };
      const next = { ...current.value, stateVersion: current.value.stateVersion + 1, status,
        generationJob: { jobId: runtime.id, ...origin, startedAt: this.#now() },
        clarifications: { history: [...(current.value.clarifications?.history ?? []), answered], origin }, lastError: undefined } as PlanSession;
      const committed = await this.#commit(next, current.value, "state-changed"); if (!committed.ok) return committed;
      this.#active = runtime; this.#reserved.add(runtime.id); return success({ state: next, runtime });
    });
    if (!started.ok) return started;
    return success({ jobId: started.value.runtime.id, completion: this.#runJob(started.value.state, started.value.runtime) });
  }
  configureWriterEndpoint(url: string): PlanControllerResult {
    if (this.#closed || this.#closing) return failure("controller-closed", "The plan controller is closed.");
    return this.#options.generator.configureWriterEndpoint(url);
  }
  async submitWriterResult(input: WriterHttpSubmission): Promise<PlanControllerResult> {
    const state = this.#state; const job = state?.generationJob;
    if (this.#closed || this.#closing) return failure("controller-closed", "The plan controller is closed.");
    if (!state || !job || this.#active?.id !== job.jobId || job.baseDocumentRevision !== state.documentRevision) {
      return failure("writer-submission-stale", "The writer submission is not active.");
    }
    const submission: WriterSubmissionInput = {
      sessionId: state.id, jobId: job.jobId, operation: job.operation, baseDocumentRevision: job.baseDocumentRevision,
      attemptId: input.attemptId, kind: input.kind, body: input.body,
    };
    return this.#options.generator.submitWriterResult(submission);
  }
  dispatchGeneration(jobId: string): PlanControllerResult {
    const state = this.#state;
    if (this.#closed || this.#closing) return failure("controller-closed", "The plan controller is closed.");
    if (!state?.generationJob || state.generationJob.jobId !== jobId || this.#active?.id !== jobId) return failure("job-stale", "The generation job is no longer active.");
    return this.#options.generator.dispatch(jobId);
  }

  async addAnnotation(input: VersionedInput & { readonly target: AnnotationTarget; readonly body: string }): Promise<PlanControllerResult> {
    return this.#enqueue(async () => {
      const state = this.#mutableState(input.expectedStateVersion); if (!state.ok) return state;
      if (state.value.status === "awaiting-clarification") return failure("clarification-read-only", "Annotations are read-only while clarification answers are pending.");
      if (!state.value.document) return failure("plan-not-ready", "A materialized plan is required.");
      const projection = isMarkdownPlanProjection(state.value.document, state.value.documentRevision)
        && projectionMarkdown(state.value.document) === state.value.committedMarkdown;
      const projectionId = projection ? this.#allocateId() : undefined; if (projectionId && !projectionId.ok) return projectionId;
      const made = projection
        ? createProjectionAnnotation(state.value.document, state.value.documentRevision, input.target, input.body, projectionId!.value, this.#now())
        : createAnnotation(state.value.document, state.value.documentRevision, input.target, input.body, { idFactory: this.#options.idFactory, reservedIds: this.#reserved, now: this.#now() });
      if (!made.ok) return validationFailure(made.issues);
      const annotation = { ...made.value, author: "user" as const };
      const next = { ...state.value, stateVersion: state.value.stateVersion + 1, annotations: [...state.value.annotations, annotation] } as PlanSession;
      const committed = await this.#commit(next, state.value, "state-changed"); if (committed.ok) this.#reserved.add(made.value.id); return committed;
    });
  }

  async updateAnnotationBody(input: VersionedInput & { readonly annotationId: string; readonly body: string }): Promise<PlanControllerResult> {
    return this.#updateAnnotation(input, (annotation) => annotation.author === "grill"
      ? failure("generated-annotation-immutable", "Generated Adversarial Review finding bodies are immutable.")
      : success({ ...annotation, body: normalizePlanText(input.body), updatedAt: this.#now() }));
  }
  async transitionAnnotation(input: VersionedInput & { readonly annotationId: string; readonly status: AnnotationStatus }): Promise<PlanControllerResult> {
    return this.#updateAnnotation(input, (annotation) => {
      if (annotation.author === "grill" && !((annotation.status === "open" && input.status === "dismissed") || (annotation.status === "dismissed" && input.status === "open"))) return failure("generated-annotation-immutable", "Generated Adversarial Review findings may only transition between open and dismissed.");
      const changed = transitionAnnotationStatus(annotation, input.status, { actor: "user", now: this.#now() });
      return changed.ok ? success(changed.value) : validationFailure(changed.issues);
    });
  }

  async verifySkills(input: VersionedInput): Promise<PlanControllerResult> {
    const observed = this.#mutableState(input.expectedStateVersion); if (!observed.ok) return observed;
    if (this.#active) return failure("job-active", "A generation job is already active.");
    const references = [...observed.value.source.skills];
    let loaded: ValidationResult<LoadedPrivateSkills>;
    try { loaded = await this.#options.skills.reload(references); }
    catch { loaded = { ok: false, issues: [{ path: "$", code: "skill-context-changed", message: "Skill context could not be reloaded." }] }; }
    return this.#enqueue(async () => {
      const current = this.#mutableState(input.expectedStateVersion); if (!current.ok) return current;
      if (this.#active) return failure("job-active", "A generation job is already active.");
      if (!loaded.ok || !exactLoadedSkills(references, loaded.value)) return this.#commitSkillFailure(current.value);
      return success(undefined);
    });
  }

  async refreshSkills(input: VersionedInput & { readonly selectedNames: readonly string[]; readonly discovered: readonly unknown[] }): Promise<PlanControllerResult> {
    const state = this.#state;
    if (!state || state.stateVersion !== input.expectedStateVersion) return failure("state-conflict", "The expected state version is stale.");
    let refreshed: ValidationResult<LoadedPrivateSkills>;
    try { refreshed = await this.#options.skills.refresh(input.selectedNames, input.discovered); }
    catch { refreshed = { ok: false, issues: [{ path: "$", code: "skill-context-changed", message: "Skill context could not be refreshed." }] }; }
    return this.#enqueue(async () => {
      const current = this.#mutableState(input.expectedStateVersion); if (!current.ok) return current;
      if (this.#active) return failure("job-active", "A generation job is already active.");
      if (!refreshed.ok) return this.#commitSkillFailure(current.value);
      const status = current.value.document ? "ready" : "paused";
      const next = { ...current.value, stateVersion: current.value.stateVersion + 1, status, source: { ...current.value.source, skills: [...refreshed.value.references] }, lastError: undefined, generationJob: undefined } as PlanSession;
      return this.#commit(next, current.value, "state-changed");
    });
  }

  async pause(input: VersionedInput): Promise<PlanControllerResult> { return this.#stop(input.expectedStateVersion, "paused", "paused"); }
  async resumeReview(input: VersionedInput): Promise<PlanControllerResult> {
    return this.#enqueue(async () => {
      const current = this.#mutableState(input.expectedStateVersion); if (!current.ok) return current;
      if (current.value.status !== "paused" || (!current.value.document && !current.value.clarifications?.pending) || current.value.generationJob || this.#active) {
        return failure("invalid-status", "Only a paused review or clarification without an active job can resume.");
      }
      const next = { ...current.value, stateVersion: current.value.stateVersion + 1, status: current.value.clarifications?.pending ? "awaiting-clarification" : "ready", lastError: undefined } as PlanSession;
      return this.#commit(next, current.value, "state-changed");
    });
  }
  async cancel(input: VersionedInput): Promise<PlanControllerResult> { return this.#stop(input.expectedStateVersion, "cancelled", "cancelled"); }

  accept(input: VersionedInput & { readonly documentRevision: number; readonly confirmed: boolean }): Promise<PlanControllerResult> {
    if (!input.confirmed) return Promise.resolve(failure("confirmation-required", "Plan acceptance requires explicit confirmation."));
    if (this.#acceptInFlight) return this.#acceptInFlight;
    const observed = this.#state;
    const acceptedRetry = observed?.status === "accepted" && !observed.generationJob && observed.document !== null
      && observed.documentRevision === input.documentRevision && observed.stateVersion === input.expectedStateVersion;
    const ready = observed?.status === "ready" && !observed.generationJob && observed.document !== null
      && observed.stateVersion === input.expectedStateVersion && observed.documentRevision === input.documentRevision;
    if ((!ready && !acceptedRetry) || !observed?.document) return Promise.resolve(failure("state-conflict", "The plan is not ready at the expected version."));
    if (acceptedRetry && this.#acceptedStaged) return Promise.resolve(success(undefined));
    const operation = this.#performAccept(input, observed, acceptedRetry);
    this.#acceptInFlight = operation;
    void operation.finally(() => { if (this.#acceptInFlight === operation) this.#acceptInFlight = null; }).catch(() => undefined);
    return operation;
  }

  async #performAccept(
    input: VersionedInput & { readonly documentRevision: number }, observed: PlanSession, acceptedRetry: boolean,
  ): Promise<PlanControllerResult> {
    if (!observed.document) return failure("state-conflict", "The plan is not ready at the expected version.");
    let loaded: ValidationResult<LoadedPrivateSkills>;
    try { loaded = await this.#options.skills.reload(observed.source.skills); }
    catch { loaded = { ok: false, issues: [{ path: "$", code: "skill-context-changed", message: "Skill context could not be reloaded." }] }; }
    if (!loaded.ok || !exactLoadedSkills(observed.source.skills, loaded.value)) {
      if (acceptedRetry) return failure("skill-context-changed", "Selected skill context changed and must be refreshed.");
      return this.#enqueue(async () => {
        const current = this.#mutableState(input.expectedStateVersion); return current.ok ? this.#commitSkillFailure(current.value) : current;
      });
    }
    const blocks = [
      EXECUTION_LEADERSHIP_BOOTSTRAP,
      ...loaded.value.contexts.map((context, index) => skillBlock(context, observed.source.skills[index]?.baseDir ?? "")),
    ];
    const markdown = observed.committedMarkdown ?? renderPlanMarkdown(observed.document);
    const staged = formatStagedPlan(markdown, observed.execution, blocks);
    if (!acceptedRetry) {
      const committed = await this.#enqueue(async () => {
        const current = this.#mutableState(input.expectedStateVersion); if (!current.ok) return current;
        if (current.value.status !== "ready" || current.value.documentRevision !== input.documentRevision || !current.value.document || current.value.generationJob) return failure("state-conflict", "The plan is not ready at the expected version.");
        const next = { ...current.value, stateVersion: current.value.stateVersion + 1, status: "accepted", lastError: undefined } as PlanSession;
        return this.#commitAccepted(next, current.value, markdown);
      });
      if (!committed.ok) return committed;
    }
    try { await this.#options.stager.stage(staged); this.#acceptedStaged = true; return success(undefined); }
    catch { return failure("stage-failed", "The accepted plan was saved but could not be sent to the agent."); }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const operation = this.#performClose(); this.#closePromise = operation;
    void operation.catch(() => { if (!this.#closed && this.#closePromise === operation) { this.#closePromise = null; this.#closing = false; } });
    return operation;
  }

  async #performClose(): Promise<void> {
    this.#closing = true;
    const runtime = this.#active;
    const stopped = await this.#enqueue(async () => {
      const state = this.#state;
      if (state && (state.status === "generating" || state.status === "revising" || state.status === "grilling" || state.status === "awaiting-clarification")) {
        const next = { ...state, stateVersion: state.stateVersion + 1, status: "paused", generationJob: undefined } as PlanSession;
        return this.#commit(next, state, "paused");
      }
      return success(undefined);
    }, true);
    if (!stopped.ok) throw new Error(stopped.error.code);
    runtime?.abort.abort(); if (this.#active === runtime) this.#active = null;
    await this.#tail;
    try { await this.#options.generator.close(); }
    finally { try { await this.#options.repository.close(); } finally { this.#listeners.clear(); this.#closed = true; } }
  }

  async #startJob(operation: "initial" | "revision" | "grill", expected: number, selectedIds: readonly string[], instruction?: string): Promise<PlanControllerResult<PlanJobHandle>> {
    const resumable = this.#state?.clarifications?.origin && !this.#state.clarifications.pending ? this.#state.clarifications.origin : undefined;
    const effectiveOperation = resumable?.operation ?? operation;
    const effectiveSelectedIds = resumable?.selectedAnnotationIds ?? selectedIds;
    const canonicalInstruction = resumable?.instruction ?? (instruction === undefined ? undefined : normalizePlanText(instruction));
    if (canonicalInstruction !== undefined && Buffer.byteLength(canonicalInstruction, "utf8") > PLAN_LIMITS.generationInstructionBytes) return failure("invalid-instruction", "Generation instruction is too long.");
    const started = await this.#enqueue(async (): Promise<PlanControllerResult<{ readonly state: PlanSession; readonly runtime: JobRuntime }>> => {
      const current = this.#mutableState(expected); if (!current.ok) return current;
      if (this.#active || current.value.generationJob) return failure("job-active", "A generation job is already active.");
      if (effectiveOperation !== operation) return failure("clarification-conflict", "The resumable clarification operation does not match this request.");
      if (operation === "initial" && (current.value.document || !["paused", "error"].includes(current.value.status))) return failure("invalid-status", "Initial generation requires an empty paused or error session.");
      if (operation === "revision" && (!current.value.document || !["ready", "error"].includes(current.value.status))) return failure("invalid-status", "Revision requires a materialized ready or error session.");
      if (operation === "grill" && (!current.value.document || !["ready", "error"].includes(current.value.status))) return failure("invalid-status", "Adversarial Review requires a materialized ready or safely failed session.");
      if (new Set(effectiveSelectedIds).size !== effectiveSelectedIds.length || effectiveSelectedIds.some((id) => !current.value.annotations.some((annotation) => annotation.id === id))) return failure("invalid-annotations", "Selected annotation IDs must be unique and current.");
      const allocated = this.#allocateId(); if (!allocated.ok) return allocated;
      const runtime = { id: allocated.value, abort: new AbortController() };
      const status = operation === "initial" ? "generating" : operation === "revision" ? "revising" : "grilling";
      const baseDocumentRevision = resumable?.baseDocumentRevision ?? current.value.documentRevision;
      const next = { ...current.value, stateVersion: current.value.stateVersion + 1, status, generationJob: { jobId: runtime.id, operation, baseDocumentRevision, selectedAnnotationIds: [...effectiveSelectedIds], ...(canonicalInstruction === undefined ? {} : { instruction: canonicalInstruction }), startedAt: this.#now() }, lastError: undefined } as PlanSession;
      const committed = await this.#commit(next, current.value, "state-changed");
      if (!committed.ok) return committed;
      this.#active = runtime; this.#reserved.add(runtime.id); return success({ state: next, runtime });
    });
    if (!started.ok) return started;
    const completion = this.#runJob(started.value.state, started.value.runtime);
    return success({ jobId: started.value.runtime.id, completion });
  }

  async #runJob(started: PlanSession, runtime: JobRuntime): Promise<PlanControllerResult> {
    const job = started.generationJob;
    if (!job) return failure("job-lost", "The generation job could not be started.");
    let result: PlanGeneratorResult;
    try {
      result = await this.#options.generator.generate({ session: started, jobId: job.jobId, operation: job.operation, selectedAnnotationIds: job.selectedAnnotationIds, ...(job.instruction === undefined ? {} : { instruction: job.instruction }), signal: runtime.abort.signal, loadSkills: async () => {
        try {
          const loaded = await this.#options.skills.reload(started.source.skills);
          return loaded.ok && exactLoadedSkills(started.source.skills, loaded.value) ? { ok: true, value: loaded.value.contexts } : { ok: false, issues: [{ path: "$", code: "skill-context-changed", message: "Private skill context changed." }] };
        } catch { return { ok: false, issues: [{ path: "$", code: "skill-context-changed", message: "Private skill context changed." }] }; }
      } });
    } catch { result = { ok: false, error: { code: "generation-failed", message: "Plan generation failed." } }; }
    return this.#enqueue(async () => {
      const completed = await this.#completeJob(job.jobId, result);
      if (completed.ok && this.#state?.generationJob === undefined && this.#active?.id === job.jobId) this.#active = null;
      return completed;
    });
  }

  async #completeJob(jobId: string, result: PlanGeneratorResult): Promise<PlanControllerResult> {
    const state = this.#state; const job = state?.generationJob;
    if (!state || !job || job.jobId !== jobId || this.#active?.id !== jobId || job.baseDocumentRevision !== state.documentRevision) return failure("job-stale", "A late generation result was ignored.");
    if (!result.ok) {
      if (result.error.code === "skill-context-changed") return this.#commitSkillFailure(state);
      if (result.error.code === "delegated-planning-paused") {
        const paused = { ...state, stateVersion: state.stateVersion + 1, status: "paused", generationJob: undefined, lastError: safeError(result.error) } as PlanSession;
        return this.#commit(paused, state, "paused");
      }
      const next = { ...state, stateVersion: state.stateVersion + 1, status: "error", generationJob: undefined, lastError: safeError(result.error) } as PlanSession;
      return this.#commit(next, state, "state-changed");
    }
    const outcome = result.outcome;
    if (job.operation === "grill") {
      if (outcome.kind !== "grill" || !state.document || outcome.basedOnDocumentRevision !== state.documentRevision) return this.#commitGenerationError(state, "invalid-grill-result", "The Adversarial Review result could not be applied safely.");
      const reserved = new Set(this.#reserved); const generated = []; const annotationIds: Record<string, string> = Object.create(null) as Record<string, string>;
      const projection = isMarkdownPlanProjection(state.document, state.documentRevision) && projectionMarkdown(state.document) === state.committedMarkdown;
      for (const [key, draft] of Object.entries(outcome.annotations)) {
        const target = canonicalGrillTarget(state.document, draft.target); if (!target.ok) return this.#commitGenerationError(state, "invalid-grill-anchor", "An Adversarial Review finding did not match the current plan.");
        const projectionId = projection ? this.#allocateId(reserved) : undefined;
        if (projectionId && !projectionId.ok) return this.#commitGenerationError(state, "invalid-grill-anchor", "An Adversarial Review finding ID could not be allocated safely.");
        const made = projection
          ? createProjectionAnnotation(state.document, state.documentRevision, target.value, draft.body, projectionId!.value, this.#now())
          : createAnnotation(state.document, state.documentRevision, target.value, draft.body, { idFactory: this.#options.idFactory, reservedIds: reserved, now: this.#now() });
        if (!made.ok) return this.#commitGenerationError(state, "invalid-grill-anchor", "An Adversarial Review finding did not match the current plan.");
        reserved.add(made.value.id); annotationIds[key] = made.value.id; generated.push({ ...made.value, author: "grill" as const });
      }
      const artifact = { basedOnDocumentRevision: state.documentRevision, annotationIds: Object.fromEntries(Object.entries(annotationIds)), decisionTree: outcome.decisionTree, generatedAt: this.#now() };
      const next = { ...state, stateVersion: state.stateVersion + 1, status: "ready", generationJob: undefined, annotations: [...state.annotations.filter((annotation) => annotation.author !== "grill"), ...generated], grill: artifact, lastError: undefined } as PlanSession;
      const committed = await this.#commit(next, state, "state-changed"); if (committed.ok) for (const annotation of generated) this.#reserved.add(annotation.id); return committed;
    }
    if (outcome.kind === "grill") return this.#commitGenerationError(state);
    if (outcome.kind === "clarification") {
      const history = state.clarifications?.history ?? [];
      if (history.length >= PLAN_LIMITS.clarificationRounds) return this.#commitGenerationError(state, "clarification-limit-reached", "The clarification limit was reached. Retry generation to continue with the answers already provided.");
      const clarificationId = this.#allocateId(); if (!clarificationId.ok) return clarificationId;
      const origin: ClarificationOrigin = { operation: job.operation, baseDocumentRevision: job.baseDocumentRevision, selectedAnnotationIds: [...job.selectedAnnotationIds], ...(job.instruction === undefined ? {} : { instruction: job.instruction }) };
      const pending: PendingClarification = { id: clarificationId.value, questions: outcome.questions, ...origin };
      const next = { ...state, stateVersion: state.stateVersion + 1, status: "awaiting-clarification", generationJob: undefined,
        clarifications: { history, origin, pending }, lastError: undefined } as PlanSession;
      const committed = await this.#commit(next, state, "state-changed");
      if (committed.ok) this.#reserved.add(clarificationId.value);
      return committed;
    }
    if (job.operation === "initial") {
      if (outcome.kind !== "plan") return this.#commitGenerationError(state);
      const allocated = allocateInitialPlanDocument(outcome.document, { idFactory: this.#options.idFactory, reservedIds: this.#reserved });
      if (!allocated.ok) return this.#commitGenerationError(state);
      const markdown = outcome.markdown ?? renderPlanMarkdown(allocated.value);
      const next = { ...state, stateVersion: state.stateVersion + 1, documentRevision: 1, document: allocated.value, committedMarkdown: markdown, annotations: [], status: "ready", generationJob: undefined, clarifications: { history: state.clarifications?.history ?? [] }, lastError: undefined } as PlanSession;
      const committed = await this.#commit(next, state, "revision-committed"); if (committed.ok) for (const id of collectPlanElementIds(allocated.value)) this.#reserved.add(id); return committed;
    }
    if (outcome.kind !== "revision-markdown" || !state.document) return this.#commitGenerationError(state);
    const document = projectMarkdownPlan(outcome.markdown, state.documentRevision + 1);
    const annotations = orphanRevisionAnnotations(state.annotations, job.selectedAnnotationIds, document.id, this.#now());
    if (!annotations.ok) return this.#commitGenerationError(state);
    const next = { ...state, stateVersion: state.stateVersion + 1, documentRevision: state.documentRevision + 1, document, committedMarkdown: outcome.markdown, annotations: annotations.value, grill: undefined, status: "ready", generationJob: undefined, clarifications: { history: state.clarifications?.history ?? [] }, lastError: undefined } as PlanSession;
    const committed = await this.#commit(next, state, "revision-committed");
    if (committed.ok) for (const id of collectPlanElementIds(document)) this.#reserved.add(id);
    return committed;
  }

  async #commitGenerationError(state: PlanSession, code = "invalid-generation-result", message = "The planner output could not be applied safely. Retry generation."): Promise<PlanControllerResult> {
    const next = { ...state, stateVersion: state.stateVersion + 1, status: "error", generationJob: undefined, lastError: { code, message } } as PlanSession;
    return this.#commit(next, state, "state-changed");
  }
  async #commitSkillFailure(state: PlanSession): Promise<PlanControllerResult> {
    const next = { ...state, stateVersion: state.stateVersion + 1, status: "needs-input", generationJob: undefined, lastError: { code: "skill-context-changed", message: "Selected skill context changed and must be refreshed." } } as PlanSession;
    const committed = await this.#commit(next, state, "skill-check-failed");
    if (committed.ok) this.#active?.abort.abort();
    return committed;
  }

  async #updateAnnotation(input: VersionedInput & { readonly annotationId: string }, change: (annotation: PlanSession["annotations"][number]) => PlanControllerResult<PlanSession["annotations"][number]>): Promise<PlanControllerResult> {
    return this.#enqueue(async () => {
      const current = this.#mutableState(input.expectedStateVersion); if (!current.ok) return current;
      if (current.value.status === "awaiting-clarification") return failure("clarification-read-only", "Annotations are read-only while clarification answers are pending.");
      const index = current.value.annotations.findIndex((annotation) => annotation.id === input.annotationId); const annotation = current.value.annotations[index];
      if (annotation === undefined) return failure("annotation-not-found", "The annotation does not exist.");
      if (current.value.generationJob?.selectedAnnotationIds.includes(annotation.id) || current.value.clarifications?.pending?.selectedAnnotationIds.includes(annotation.id)) return failure("annotation-locked", "Selected feedback is locked while its planning operation is active.");
      const changed = change(annotation); if (!changed.ok) return changed;
      const annotations = [...current.value.annotations]; annotations[index] = changed.value;
      const next = { ...current.value, stateVersion: current.value.stateVersion + 1, annotations } as PlanSession;
      return this.#commit(next, current.value, "state-changed");
    });
  }

  async #stop(expected: number, status: "paused" | "cancelled", event: "paused" | "cancelled"): Promise<PlanControllerResult> {
    return this.#enqueue(async () => {
      const current = this.#mutableState(expected); if (!current.ok) return current;
      const runtime = this.#active;
      const next = { ...current.value, stateVersion: current.value.stateVersion + 1, status, generationJob: undefined } as PlanSession;
      const committed = await this.#commit(next, current.value, event);
      if (committed.ok) { runtime?.abort.abort(); if (this.#active === runtime) this.#active = null; }
      return committed;
    });
  }

  #mutableState(expected: number): PlanControllerResult<PlanSession> {
    if (this.#closed || this.#closing) return failure("controller-closed", "The plan controller is closed.");
    const state = this.#state; if (!state) return failure("not-created", "The plan session has not been created.");
    if (state.status === "accepted" || state.status === "cancelled") return failure("terminal-state", "The plan session is terminal.");
    return state.stateVersion === expected ? success(state) : failure("state-conflict", "The expected state version is stale.");
  }
  async #commit(candidate: PlanSession, previous: PlanSession | null, eventKind: EventKind): Promise<PlanControllerResult> {
    const validated = validatePlanSession(candidate); if (!validated.ok) return failure("invalid-state", "The plan state mutation was invalid.");
    try { const committed = await this.#options.repository.commit({ session: validated.value, previous, eventKind, appendLocator: this.#options.appendLocator }); this.#state = committed.state; this.#publish(eventKind, committed.state); return success(undefined); }
    catch { return failure("persistence-failed", "The plan state could not be saved."); }
  }
  async #commitAccepted(candidate: PlanSession, previous: PlanSession, finalPlan: string): Promise<PlanControllerResult> {
    const validated = validatePlanSession(candidate); if (!validated.ok) return failure("invalid-state", "The accepted plan state was invalid.");
    try { const committed = await this.#options.repository.commitAccepted({ session: validated.value, previous, eventKind: "accepted", finalPlan, appendLocator: this.#options.appendLocator }); this.#state = committed.state; this.#publish("accepted", committed.state); return success(undefined); }
    catch { return failure("persistence-failed", "The accepted plan could not be saved."); }
  }
  #publish(kind: EventKind, state: PlanSession): void {
    const event: PlanControllerEvent = Object.freeze({ kind, sessionId: state.id, status: state.status, stateVersion: state.stateVersion, documentRevision: state.documentRevision, ...(state.lastError ? { errorCode: state.lastError.code } : {}) });
    for (const listener of this.#listeners) { try { listener(event); } catch { /* observers cannot affect durable commits */ } }
  }
  #enqueue<T>(work: () => Promise<T>, duringClose = false): Promise<T> {
    if ((this.#closing && !duringClose) || this.#closed) return Promise.resolve(failure("controller-closed", "The plan controller is closed.") as T);
    const run = this.#tail.then(work, work); this.#tail = run.then(() => undefined, () => undefined); return run;
  }
  #allocateId(additional: ReadonlySet<string> = new Set()): PlanControllerResult<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) { let id: string; try { id = this.#options.idFactory(); } catch { break; } if (/^[!-~]{1,64}$/.test(id) && !this.#reserved.has(id) && !additional.has(id)) return success(id); }
    return failure("id-allocation-failed", "A unique plan ID could not be allocated.");
  }
  #now(): string { const raw = this.#options.clock(); return raw instanceof Date ? raw.toISOString() : raw; }
}

function orphanRevisionAnnotations(
  annotations: readonly Annotation[], selectedAnnotationIds: readonly string[], documentId: string, now: string,
): ValidationResult<readonly Annotation[]> {
  const selected = new Set(selectedAnnotationIds); const survivors: Annotation[] = [];
  for (const annotation of annotations) {
    if (selected.has(annotation.id) || annotation.author === "grill") continue;
    const retargeted = annotation.target.kind === "root"
      ? { ...annotation, target: { kind: "root" as const, elementId: documentId }, targetSnapshot: { ...annotation.targetSnapshot, target: { kind: "root" as const, elementId: documentId } } }
      : annotation;
    if (retargeted.status === "orphaned") { survivors.push(retargeted); continue; }
    const orphaned = transitionAnnotationStatus(retargeted, "orphaned", { actor: "system", now });
    if (!orphaned.ok) return orphaned;
    survivors.push(orphaned.value);
  }
  return { ok: true, value: survivors };
}

function canonicalGrillTarget(document: PlanDocument, target: GrillAnnotationTargetDraft): ValidationResult<AnnotationTarget> {
  if (target.kind !== "range" || "selector" in target) return { ok: true, value: target };
  if (!/^[!-~]{1,64}$/u.test(target.elementId)) return invalidAnnotation("$.target.elementId", "invalid-id", "Annotation target ID is invalid.");
  const element = findPlanElement(document, target.elementId); if (!element) return invalidAnnotation("$.target.elementId", "unknown-target", "Annotation target does not exist in the current document.");
  if (target.field !== "title" && target.field !== "body") return invalidAnnotation("$.target.field", "invalid-field", "Selected field is invalid.");
  const text = target.field === "body" ? element.body : element.title; if (text === undefined) return invalidAnnotation("$.target.field", "missing-field", "Selected field does not exist on the target element.");
  const points = [...text];
  if (!Number.isSafeInteger(target.start) || !Number.isSafeInteger(target.end) || target.start < 0 || target.end <= target.start || target.end > points.length) return invalidAnnotation("$.target", "invalid-range", "Range target must be a nonempty in-bounds Unicode code-point range.");
  return { ok: true, value: { kind: "range", elementId: target.elementId, selector: {
    field: target.field, start: target.start, end: target.end, exact: points.slice(target.start, target.end).join(""),
    prefix: points.slice(Math.max(0, target.start - 32), target.start).join(""), suffix: points.slice(target.end, target.end + 32).join(""),
  } } };
}

function createProjectionAnnotation(
  document: PlanDocument, documentRevision: number, target: AnnotationTarget, body: string, id: string, now: string,
): ValidationResult<Annotation> {
  let snapshot: Annotation["targetSnapshot"];
  if (target.kind === "root") {
    if (target.elementId !== document.id) return invalidAnnotation("$.target.elementId", "unknown-target", "Root target must equal the current document ID.");
    snapshot = { documentRevision, target: { kind: "root", elementId: target.elementId }, elementKind: "root", text: "" };
  } else {
    const element = findPlanElement(document, target.elementId);
    if (!element) return invalidAnnotation("$.target.elementId", "unknown-target", "Annotation target does not exist in the current document.");
    if (target.kind === "element") snapshot = { documentRevision, target: { kind: "element", elementId: target.elementId }, elementKind: element.kind, text: elementText(element) };
    else {
      const text = target.selector.field === "body" ? element.body : element.title;
      if (text === undefined) return invalidAnnotation("$.target.selector.field", "missing-field", "Selected field does not exist on the target element.");
      const selector = { ...target.selector };
      snapshot = { documentRevision, target: { kind: "range", elementId: target.elementId, selector }, elementKind: element.kind, text };
    }
  }
  const annotation: Annotation = { id, target: snapshot.target, targetSnapshot: snapshot, body: normalizePlanText(body), status: "open", history: [], createdAgainstRevision: documentRevision, createdAt: now, updatedAt: now };
  const validated = validatePlanAnnotations([annotation], document, documentRevision);
  return validated.ok ? { ok: true, value: validated.value[0] ?? annotation } : validated;
}
function findPlanElement(document: PlanDocument, id: string): PlanElement | undefined {
  const visit = (element: PlanElement): PlanElement | undefined => element.id === id ? element : element.children.map(visit).find(Boolean);
  return visit(document.title) ?? document.elements.map(visit).find(Boolean);
}
function elementText(element: PlanElement): string { return `${element.title === undefined ? "" : `${element.title}\n`}${element.body}`; }
function projectionMarkdown(document: PlanDocument): string { const execution = document.elements[0]; return execution ? [execution.body, ...execution.children.map((child) => child.body)].join("") : ""; }
function invalidAnnotation<T = never>(path: string, code: string, message: string): ValidationResult<T> { return { ok: false, issues: [{ path, code, message }] }; }

function originOf(value: ClarificationOrigin): ClarificationOrigin { return { operation: value.operation, baseDocumentRevision: value.baseDocumentRevision, selectedAnnotationIds: [...value.selectedAnnotationIds], ...(value.instruction === undefined ? {} : { instruction: value.instruction }) }; }
function skillBlock(context: PrivateSkillContent, baseDir: string): string {
  return `<skill name="${escapeXml(context.name)}" baseDir="${escapeXml(baseDir)}">\n${context.body}\n</skill>`;
}
function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function sameReferences(expected: readonly SkillReference[], actual: readonly SkillReference[]): boolean { return expected.length === actual.length && expected.every((value, index) => { const other = actual[index]; return other !== undefined && value.name === other.name && value.path === other.path && value.baseDir === other.baseDir && value.sha256 === other.sha256; }); }
function exactLoadedSkills(expected: readonly SkillReference[], loaded: LoadedPrivateSkills): boolean {
  return sameReferences(expected, loaded.references) && loaded.contexts.length === expected.length
    && loaded.contexts.every((context, index) => context.name === expected[index]?.name);
}
function safeError(error: SafeError): SafeError { return { code: error.code, message: error.message }; }
function success<T>(value: T): PlanControllerResult<T> { return { ok: true, value }; }
function failure<T = never>(code: string, message: string): PlanControllerResult<T> { return { ok: false, error: { code, message } }; }
function validationFailure<T = never>(issues: readonly ValidationIssue[]): PlanControllerResult<T> { const first = issues[0]; return failure(first?.code ?? "invalid-input", first?.message ?? "The input was invalid."); }
