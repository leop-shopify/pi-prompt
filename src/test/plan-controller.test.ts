import { describe, expect, it } from "vitest";
import { PlanController, type LoadedPrivateSkills, type PlanControllerOptions, type PlanControllerRepository } from "../plan/controller.js";
import type { PlanGeneratorInput, PlanGeneratorResult, WriterSubmissionInput } from "../plan/generator.js";
import type { CommitAcceptedPlanInput, CommitPlanInput, CommittedPlanState, RecoveredPlanState } from "../plan/repository.js";
import type { PlanBranchLocator } from "../plan/locator.js";
import type { PlanSession, SkillReference, ValidationResult } from "../plan/types.js";

const NOW = "2026-07-10T12:00:00.000Z";
const reference: SkillReference = { name: "testing", path: "/private/testing/SKILL.md", baseDir: "/private/testing", sha256: "a".repeat(64) };
const loaded: LoadedPrivateSkills = { references: [reference], contexts: [{ name: "testing", body: "PRIVATE BODY" }] };
const initial = { kind: "plan" as const, document: { title: { kind: "title" as const, body: "Ship", children: [] }, elements: [{ kind: "execution" as const, body: "Run", children: [] }, { kind: "step" as const, title: "Build", body: "Old", children: [] }] } };

class FakeRepository implements PlanControllerRepository {
  readonly commits: CommitPlanInput[] = []; readonly accepted: CommitAcceptedPlanInput[] = []; closed = 0;
  failNextCommit = false; failNextAccepted = false;
  async commit(input: CommitPlanInput): Promise<CommittedPlanState> {
    if (this.failNextCommit) { this.failNextCommit = false; throw new Error("disk"); }
    if (input.previous) {
      if (input.session.stateVersion !== input.previous.stateVersion + 1) throw new Error("state-version-invariant");
      const sameDocument = JSON.stringify(input.session.document) === JSON.stringify(input.previous.document);
      if ((sameDocument && input.session.documentRevision !== input.previous.documentRevision)
        || (!sameDocument && input.session.documentRevision !== input.previous.documentRevision + 1)) throw new Error("document-revision-invariant");
    }
    this.commits.push(input); return { state: input.session, locator: locator(input.session) };
  }
  async commitAccepted(input: CommitAcceptedPlanInput): Promise<CommittedPlanState> { if (this.failNextAccepted) { this.failNextAccepted = false; throw new Error("disk"); } this.accepted.push(input); return { state: input.session, locator: locator(input.session) }; }
  async close(): Promise<void> { this.closed += 1; }
}
class FakeGenerator {
  readonly calls: PlanGeneratorInput[] = []; readonly pending: Array<(value: PlanGeneratorResult) => void> = []; readonly dispatched: string[] = []; readonly submissions: WriterSubmissionInput[] = []; closed = 0;
  generate(input: PlanGeneratorInput): Promise<PlanGeneratorResult> { this.calls.push(input); return new Promise((resolve) => this.pending.push(resolve)); }
  configureWriterEndpoint(_url: string) { return { ok: true as const, value: undefined }; }
  async submitWriterResult(input: WriterSubmissionInput) { this.submissions.push(input); return { ok: true as const, value: undefined }; }
  dispatch(jobId: string) { this.dispatched.push(jobId); return { ok: true as const, value: undefined }; }
  close(): void { this.closed += 1; }
  finish(value: PlanGeneratorResult): void { const resolve = this.pending.shift(); if (!resolve) throw new Error("no job"); resolve(value); }
}
function locator(state: PlanSession): PlanBranchLocator { return { schemaVersion: 1, sessionId: state.id, artifactPath: `/tmp/${state.id}`, status: state.status, stateVersion: state.stateVersion, documentRevision: state.documentRevision, stateSha256: "b".repeat(64), committedAt: NOW }; }
function harness(execution: "normal" | "goal" | "loop" = "normal") {
  const repository = new FakeRepository(); const generator = new FakeGenerator(); const staged: string[] = []; const locators: PlanBranchLocator[] = [];
  let id = 0; let stageFailures = 0; let skillResult: ValidationResult<LoadedPrivateSkills> = { ok: true, value: loaded };
  const options: PlanControllerOptions = { repository, generator, appendLocator: (value) => locators.push(value), skills: { reload: async () => skillResult, refresh: async () => skillResult }, idFactory: () => `id-${++id}`, clock: () => NOW, stager: { stage: (value) => { if (stageFailures > 0) { stageFailures -= 1; throw new Error("editor"); } staged.push(value); } } };
  return { repository, generator, staged, locators, options, setStageFailures: (count: number) => { stageFailures = count; }, setSkillResult: (value: ValidationResult<LoadedPrivateSkills>) => { skillResult = value; }, create: () => PlanController.create(options, { prompt: "Build it", cwd: "/repo", skills: [reference], execution: { kind: execution }, mode: "normal" }) };
}

async function readyController(execution: "normal" | "goal" | "loop" = "normal") {
  const h = harness(execution); const made = await h.create(); if (!made.ok) throw new Error(made.error.code); const controller = made.value;
  const started = await controller.generate({ expectedStateVersion: 1 }); if (!started.ok) throw new Error(started.error.code);
  expect(controller.dispatchGeneration(started.value.jobId).ok).toBe(true);
  h.generator.finish({ ok: true, outcome: initial }); expect((await started.value.completion).ok).toBe(true);
  return { ...h, controller };
}
function revisionFor(state: PlanSession, changed = true, addressedAnnotationIds: readonly string[] = []) {
  if (!state.document) throw new Error("document required");
  return { kind: "revision" as const, document: { retainedId: state.document.id, title: { retainedId: state.document.title.id, kind: "title" as const, body: state.document.title.body, children: [] }, elements: state.document.elements.map((element) => ({ retainedId: element.id, kind: element.kind, ...(element.title ? { title: element.title } : {}), body: changed && element.kind === "step" ? `${element.body} changed` : element.body, children: [] })) }, addressedAnnotationIds };
}

describe("PlanController", () => {
  it("serializes initial generation, commits locator-visible states, and rejects a second active job", async () => {
    const h = harness(); const made = await h.create(); expect(made.ok).toBe(true); if (!made.ok) return;
    expect(made.value.snapshot()).toMatchObject({ status: "paused", stateVersion: 1, documentRevision: 0 });
    const started = await made.value.generate({ expectedStateVersion: 1 }); expect(started.ok).toBe(true); if (!started.ok) return;
    expect(made.value.snapshot()).toMatchObject({ status: "generating", stateVersion: 2, generationJob: { operation: "initial" } });
    expect((await made.value.generate({ expectedStateVersion: 2 })).ok).toBe(false);
    expect(made.value.dispatchGeneration(started.value.jobId).ok).toBe(true);
    expect(made.value.dispatchGeneration("wrong")).toMatchObject({ ok: false, error: { code: "job-stale" } });
    h.generator.finish({ ok: true, outcome: initial }); expect((await started.value.completion).ok).toBe(true);
    expect(made.value.snapshot()).toMatchObject({ status: "ready", stateVersion: 3, documentRevision: 1 });
    expect(h.repository.commits.map((entry) => entry.session.status)).toEqual(["paused", "generating", "ready"]);
  });

  it("correlates writer submissions from the exact active canonical job and rejects them after pause", async () => {
    const h = harness(); const made = await h.create(); if (!made.ok) return; const controller = made.value;
    const started = await controller.generate({ expectedStateVersion: 1 }); if (!started.ok) return;
    const bytes = Buffer.from("# Exact bytes\r\n");
    expect(await controller.submitWriterResult({ attemptId: "attempt_identity_0001", kind: "plan", body: bytes })).toMatchObject({ ok: true });
    expect(h.generator.submissions).toEqual([{ sessionId: "id-1", jobId: started.value.jobId, operation: "initial", baseDocumentRevision: 0, attemptId: "attempt_identity_0001", kind: "plan", body: bytes }]);
    expect((await controller.pause({ expectedStateVersion: 2 })).ok).toBe(true);
    expect(await controller.submitWriterResult({ attemptId: "attempt_identity_0001", kind: "plan", body: bytes })).toMatchObject({ ok: false, error: { code: "writer-submission-stale" } });
  });

  it("persists repeated clarification rounds, validates answers atomically, and commits exact writer Markdown", async () => {
    const h = harness(); const made = await h.create(); if (!made.ok) return; const controller = made.value;
    const first = await controller.generate({ expectedStateVersion: 1 }); if (!first.ok) return; controller.dispatchGeneration(first.value.jobId);
    h.generator.finish({ ok: true, outcome: { kind: "clarification", questions: [{ id: "q-one", prompt: "Choose a target?", options: [{ id: "o-one", label: "First" }, { id: "o-two", label: "Second" }] }] } });
    await first.value.completion; expect(controller.snapshot()).toMatchObject({ status: "awaiting-clarification", stateVersion: 3, clarifications: { history: [], pending: { operation: "initial", baseDocumentRevision: 0, selectedAnnotationIds: [] } } });
    const pendingOne = controller.snapshot()!.clarifications!.pending!;
    expect(await controller.answerClarification({ expectedStateVersion: 3, clarificationId: pendingOne.id, answers: [{ questionId: "q-one", answer: { kind: "option", optionId: "unknown" } }] })).toMatchObject({ ok: false, error: { code: "unknown-option" } });
    expect(controller.snapshot()?.stateVersion).toBe(3);
    const continued = await controller.answerClarification({ expectedStateVersion: 3, clarificationId: pendingOne.id, answers: [{ questionId: "q-one", answer: { kind: "custom", text: "The API" } }] }); if (!continued.ok) return;
    h.generator.finish({ ok: true, outcome: { kind: "clarification", questions: [{ id: "q-two", prompt: "Choose timing?", options: [{ id: "o-three", label: "Now" }, { id: "o-four", label: "Later" }] }] } }); await continued.value.completion;
    expect(controller.snapshot()).toMatchObject({ status: "awaiting-clarification", clarifications: { history: [{ id: pendingOne.id, answers: [{ answer: { kind: "custom", text: "The API" } }] }], pending: { questions: [{ id: "q-two" }] } } });
    const pendingTwo = controller.snapshot()!.clarifications!.pending!;
    const final = await controller.answerClarification({ expectedStateVersion: controller.snapshot()!.stateVersion, clarificationId: pendingTwo.id, answers: [{ questionId: "q-two", answer: { kind: "option", optionId: "o-three" } }] }); if (!final.ok) return;
    const exact = `# Ship\r\n\r\n## Execution\r\nRun\r\n\r\n## Implementation Tasks\r\nTasks\r\n\r\n### Build\r\nScope: src/a.ts\r\nTest first: Add a failing test.\r\nImplement: Make the change.\r\nVerify: Run the test.\r\nDone when: The test passes.\r\n`;
    h.generator.finish({ ok: true, outcome: { ...initial, markdown: exact } }); await final.value.completion;
    expect(controller.snapshot()).toMatchObject({ status: "ready", documentRevision: 1, committedMarkdown: exact, clarifications: { history: [{ id: pendingOne.id }, { id: pendingTwo.id }] } });
    expect(controller.snapshot()?.clarifications).not.toHaveProperty("pending"); expect(controller.snapshot()?.clarifications).not.toHaveProperty("origin");
    const ready = controller.snapshot()!; expect((await controller.accept({ expectedStateVersion: ready.stateVersion, documentRevision: ready.documentRevision, confirmed: true })).ok).toBe(true);
    expect(h.repository.accepted.at(-1)?.finalPlan).toBe(exact);
  });

  it("keeps selected revision notes locked throughout clarification wait", async () => {
    const h = await readyController(); let state = h.controller.snapshot(); if (!state?.document) return; const step = state.document.elements[1]!;
    await h.controller.addAnnotation({ expectedStateVersion: state.stateVersion, target: { kind: "element", elementId: step.id }, body: "Selected" }); state = h.controller.snapshot();
    await h.controller.addAnnotation({ expectedStateVersion: state!.stateVersion, target: { kind: "root", elementId: state!.document!.id }, body: "Unselected" }); state = h.controller.snapshot();
    const note = state?.annotations[0]; const unselected = state?.annotations[1]; if (!state || !note || !unselected) return;
    const job = await h.controller.revise({ expectedStateVersion: state.stateVersion, selectedAnnotationIds: [note.id], instruction: "Only this" }); if (!job.ok) return;
    h.generator.finish({ ok: true, outcome: { kind: "clarification", questions: [{ id: "revision-question", prompt: "Which variant?", options: [{ id: "variant-a", label: "A" }, { id: "variant-b", label: "B" }] }] } }); await job.value.completion;
    const waiting = h.controller.snapshot()!; expect(waiting).toMatchObject({ status: "awaiting-clarification", document: state.document, clarifications: { pending: { selectedAnnotationIds: [note.id], instruction: "Only this" } } });
    expect(await h.controller.addAnnotation({ expectedStateVersion: waiting.stateVersion, target: { kind: "root", elementId: waiting.document!.id }, body: "Blocked" })).toMatchObject({ ok: false, error: { code: "clarification-read-only" } });
    expect(await h.controller.updateAnnotationBody({ expectedStateVersion: waiting.stateVersion, annotationId: note.id, body: "Changed" })).toMatchObject({ ok: false, error: { code: "clarification-read-only" } });
    expect(await h.controller.updateAnnotationBody({ expectedStateVersion: waiting.stateVersion, annotationId: unselected.id, body: "Changed" })).toMatchObject({ ok: false, error: { code: "clarification-read-only" } });
    expect(await h.controller.transitionAnnotation({ expectedStateVersion: waiting.stateVersion, annotationId: unselected.id, status: "dismissed" })).toMatchObject({ ok: false, error: { code: "clarification-read-only" } });
    expect((await h.controller.pause({ expectedStateVersion: waiting.stateVersion })).ok).toBe(true); expect(h.controller.snapshot()?.clarifications?.pending?.id).toBe(waiting.clarifications?.pending?.id);
    expect((await h.controller.resumeReview({ expectedStateVersion: waiting.stateVersion + 1 })).ok).toBe(true); expect(h.controller.snapshot()?.status).toBe("awaiting-clarification");
  });

  it("recovers an awaiting revision clarification with its questions, origin, and selected-note lock intact", async () => {
    const h = await readyController(); let state = h.controller.snapshot(); if (!state?.document) return; const step = state.document.elements[1]!;
    await h.controller.addAnnotation({ expectedStateVersion: state.stateVersion, target: { kind: "element", elementId: step.id }, body: "Selected" }); state = h.controller.snapshot(); const note = state?.annotations[0]; if (!state || !note) return;
    const job = await h.controller.revise({ expectedStateVersion: state.stateVersion, selectedAnnotationIds: [note.id], instruction: "Preserve this origin" }); if (!job.ok) return;
    h.generator.finish({ ok: true, outcome: { kind: "clarification", questions: [{ id: "recover-question", prompt: "Which variant?", options: [{ id: "recover-a", label: "A" }, { id: "recover-b", label: "B" }] }] } }); await job.value.completion;
    const persisted = h.controller.snapshot()!; const recovered = PlanController.fromRecovered(h.options, persisted, ["historical-id"]); if (!recovered.ok) return;
    expect(recovered.value.snapshot()).toMatchObject({ status: "awaiting-clarification", document: persisted.document, clarifications: { pending: { questions: [{ id: "recover-question" }], operation: "revision", baseDocumentRevision: 1, selectedAnnotationIds: [note.id], instruction: "Preserve this origin" }, origin: { selectedAnnotationIds: [note.id] } } });
    expect(await recovered.value.transitionAnnotation({ expectedStateVersion: persisted.stateVersion, annotationId: note.id, status: "dismissed" })).toMatchObject({ ok: false, error: { code: "clarification-read-only" } });
    const continued = await recovered.value.answerClarification({ expectedStateVersion: persisted.stateVersion, clarificationId: persisted.clarifications!.pending!.id, answers: [{ questionId: "recover-question", answer: { kind: "option", optionId: "recover-a" } }] }); if (!continued.ok) return;
    expect(h.generator.calls.at(-1)).toMatchObject({ operation: "revision", selectedAnnotationIds: [note.id], instruction: "Preserve this origin", session: { clarifications: { history: [{ answers: [{ answer: { kind: "option", optionId: "recover-a" } }] }], origin: { baseDocumentRevision: 1, selectedAnnotationIds: [note.id] } } } });
    expect(recovered.value.snapshot()?.generationJob).toMatchObject({ operation: "revision", baseDocumentRevision: 1, selectedAnnotationIds: [note.id] });
  });

  it("durably resumes only a paused materialized review with one version increment", async () => {
    const h = await readyController();
    expect((await h.controller.pause({ expectedStateVersion: 3 })).ok).toBe(true);
    expect(h.controller.snapshot()).toMatchObject({ status: "paused", stateVersion: 4, documentRevision: 1 });
    const commitsBefore = h.repository.commits.length;
    expect((await h.controller.resumeReview({ expectedStateVersion: 4 })).ok).toBe(true);
    expect(h.controller.snapshot()).toMatchObject({ status: "ready", stateVersion: 5, documentRevision: 1 });
    expect(h.repository.commits).toHaveLength(commitsBefore + 1);
    expect(h.repository.commits.at(-1)?.eventKind).toBe("state-changed");
    expect(await h.controller.resumeReview({ expectedStateVersion: 5 })).toMatchObject({ ok: false, error: { code: "invalid-status" } });

    expect((await h.controller.pause({ expectedStateVersion: 5 })).ok).toBe(true);
    h.repository.failNextCommit = true;
    expect(await h.controller.resumeReview({ expectedStateVersion: 6 })).toMatchObject({ ok: false, error: { code: "persistence-failed" } });
    expect(h.controller.snapshot()).toMatchObject({ status: "paused", stateVersion: 6 });
  });

  it("uses one canonical generation instruction for persistence and generator correlation", async () => {
    const h = harness(); const made = await h.create(); if (!made.ok) return;
    const started = await made.value.generate({ expectedStateVersion: 1, instruction: "Keep\r\ncompatibilite\u0301" });
    expect(started.ok).toBe(true); if (!started.ok) return;
    expect(made.value.snapshot()?.generationJob?.instruction).toBe("Keep\ncompatibilité");
    expect(h.generator.calls[0]?.instruction).toBe("Keep\ncompatibilité");
    h.generator.finish({ ok: true, outcome: initial });
    expect((await started.value.completion).ok).toBe(true);
  });

  it("preserves an annotation added while revising and supports body/status transitions", async () => {
    const h = await readyController(); const state = h.controller.snapshot(); if (!state?.document) return;
    const step = state.document.elements[1]; if (!step) return;
    const revision = await h.controller.revise({ expectedStateVersion: 3, selectedAnnotationIds: [] }); expect(revision.ok).toBe(true); if (!revision.ok) return;
    const added = await h.controller.addAnnotation({ expectedStateVersion: 4, target: { kind: "element", elementId: step.id }, body: "Keep this" }); expect(added.ok).toBe(true);
    const note = h.controller.snapshot()?.annotations[0]; if (!note) return;
    expect((await h.controller.updateAnnotationBody({ expectedStateVersion: 5, annotationId: note.id, body: "Updated" })).ok).toBe(true);
    expect((await h.controller.transitionAnnotation({ expectedStateVersion: 6, annotationId: note.id, status: "dismissed" })).ok).toBe(true);
    h.generator.finish({ ok: true, outcome: { kind: "revision", document: { retainedId: state.document.id, title: { retainedId: state.document.title.id, kind: "title", body: "Ship", children: [] }, elements: state.document.elements.map((element) => ({ retainedId: element.id, kind: element.kind, ...(element.title ? { title: element.title } : {}), body: element.kind === "step" ? `${element.body} Revised.` : element.body, children: [] })) }, addressedAnnotationIds: [] } });
    expect((await revision.value.completion).ok).toBe(true);
    expect(h.controller.snapshot()?.annotations[0]).toMatchObject({ body: "Updated", status: "dismissed" });
  });

  it.each(["normal", "goal", "loop"] as const)("atomically accepts and stages %s exactly once", async (execution) => {
    const h = await readyController(execution); const state = h.controller.snapshot(); if (!state) return;
    expect((await h.controller.accept({ expectedStateVersion: state.stateVersion, documentRevision: state.documentRevision, confirmed: false })).ok).toBe(false);
    expect((await h.controller.accept({ expectedStateVersion: state.stateVersion, documentRevision: state.documentRevision, confirmed: true })).ok).toBe(true);
    expect(h.repository.accepted).toHaveLength(1); expect(h.staged).toHaveLength(1);
    expect(h.repository.accepted[0]?.finalPlan).toContain("# Ship");
    expect(h.repository.accepted[0]?.finalPlan).not.toContain("PRIVATE BODY");
    expect(h.repository.accepted[0]?.finalPlan).not.toContain("/private/testing");
    expect(h.staged[0]).toContain("inspect the leadership and orchestration skills available in this Pi session and preload the best fit");
    expect(h.staged[0]).toContain("Do not assume a specific skill name; choose from the available options.");
    expect(h.staged[0]).toContain("organize the plan into specific ordered tasks");
    expect(h.staged[0]).not.toContain('<skill name="team-leader"');
    expect(h.staged[0]).toContain('<skill name="testing" baseDir="/private/testing">\nPRIVATE BODY\n</skill>');
    expect(h.staged[0]?.match(/\/(?:goal|loop)/g)?.length ?? 0).toBe(execution === "normal" ? 0 : 1);
  });

  it("rejects byte-identical no-op revisions without advancing documentRevision or addressing feedback", async () => {
    const h = await readyController(); let state = h.controller.snapshot(); if (!state?.document) return;
    const step = state.document.elements[1]; if (!step) return;
    expect((await h.controller.addAnnotation({ expectedStateVersion: state.stateVersion, target: { kind: "element", elementId: step.id }, body: "Change it" })).ok).toBe(true);
    state = h.controller.snapshot(); const note = state?.annotations[0]; if (!state || !note) return;
    const job = await h.controller.revise({ expectedStateVersion: state.stateVersion, selectedAnnotationIds: [note.id] }); if (!job.ok) return;
    h.generator.finish({ ok: true, outcome: revisionFor(state, false, [note.id]) });
    expect((await job.value.completion)).toMatchObject({ ok: true });
    expect(h.controller.snapshot()).toMatchObject({ status: "error", documentRevision: 1, lastError: { code: "no-op-revision" }, annotations: [{ status: "open" }] });
  });

  it("locks selected annotations during revision while allowing new and unselected feedback", async () => {
    const h = await readyController(); let state = h.controller.snapshot(); if (!state?.document) return;
    const step = state.document.elements[1]; if (!step) return;
    await h.controller.addAnnotation({ expectedStateVersion: state.stateVersion, target: { kind: "element", elementId: step.id }, body: "Selected" });
    state = h.controller.snapshot(); if (!state) return;
    await h.controller.addAnnotation({ expectedStateVersion: state.stateVersion, target: { kind: "root", elementId: state.document!.id }, body: "Unselected" });
    state = h.controller.snapshot(); const selected = state?.annotations[0]; const unselected = state?.annotations[1]; if (!state || !selected || !unselected) return;
    const job = await h.controller.revise({ expectedStateVersion: state.stateVersion, selectedAnnotationIds: [selected.id] }); if (!job.ok) return;
    let version = h.controller.snapshot()!.stateVersion;
    expect(await h.controller.updateAnnotationBody({ expectedStateVersion: version, annotationId: selected.id, body: "stale" })).toMatchObject({ ok: false, error: { code: "annotation-locked" } });
    expect(await h.controller.transitionAnnotation({ expectedStateVersion: version, annotationId: selected.id, status: "dismissed" })).toMatchObject({ ok: false, error: { code: "annotation-locked" } });
    expect((await h.controller.updateAnnotationBody({ expectedStateVersion: version, annotationId: unselected.id, body: "fresh" })).ok).toBe(true);
    version = h.controller.snapshot()!.stateVersion;
    expect((await h.controller.addAnnotation({ expectedStateVersion: version, target: { kind: "root", elementId: state.document!.id }, body: "New" })).ok).toBe(true);
    h.generator.finish({ ok: true, outcome: revisionFor(state, true, [selected.id]) }); await job.value.completion;
    expect(h.controller.snapshot()?.annotations.find((annotation) => annotation.id === selected.id)?.status).toBe("addressed");
  });

  it("keeps accepted state terminal across staging failure and retries staging without re-commit or execution", async () => {
    const h = await readyController(); const ready = h.controller.snapshot(); if (!ready) return;
    expect(h.controller.acceptedStagingPending()).toBe(false);
    h.setStageFailures(1);
    expect(await h.controller.accept({ expectedStateVersion: ready.stateVersion, documentRevision: ready.documentRevision, confirmed: true })).toMatchObject({ ok: false, error: { code: "stage-failed" } });
    expect(h.controller.snapshot()?.status).toBe("accepted"); expect(h.controller.acceptedStagingPending()).toBe(true); expect(h.repository.accepted).toHaveLength(1); expect(h.staged).toHaveLength(0);
    const accepted = h.controller.snapshot()!;
    const [first, second] = await Promise.all([
      h.controller.accept({ expectedStateVersion: accepted.stateVersion, documentRevision: accepted.documentRevision, confirmed: true }),
      h.controller.accept({ expectedStateVersion: accepted.stateVersion, documentRevision: accepted.documentRevision, confirmed: true }),
    ]);
    expect(first.ok && second.ok).toBe(true); expect(h.controller.acceptedStagingPending()).toBe(false); expect(h.repository.accepted).toHaveLength(1); expect(h.staged).toHaveLength(1); expect(h.generator.calls).toHaveLength(1);
    expect((await h.controller.accept({ expectedStateVersion: accepted.stateVersion, documentRevision: accepted.documentRevision, confirmed: true })).ok).toBe(true);
    expect(h.staged).toHaveLength(1);
    const recoveryStaged: string[] = [];
    const recovered = PlanController.fromRecovered({ ...h.options, stager: { stage: (value) => { recoveryStaged.push(value); } } }, h.controller.snapshot()!, []); if (!recovered.ok) return;
    expect(recovered.value.acceptedStagingPending()).toBe(true);
    expect((await recovered.value.accept({ expectedStateVersion: accepted.stateVersion, documentRevision: accepted.documentRevision, confirmed: true })).ok).toBe(true);
    expect(recoveryStaged).toEqual([h.staged[0]]); expect(h.repository.accepted).toHaveLength(1);
  });

  it("does not abort active computation until pause or close persistence succeeds", async () => {
    const h = harness(); const made = await h.create(); if (!made.ok) return; const job = await made.value.generate({ expectedStateVersion: 1 }); if (!job.ok) return;
    const signal = h.generator.calls[0]!.signal;
    h.repository.failNextCommit = true;
    expect(await made.value.pause({ expectedStateVersion: 2 })).toMatchObject({ ok: false, error: { code: "persistence-failed" } });
    expect(signal.aborted).toBe(false); expect(made.value.snapshot()).toMatchObject({ status: "generating", generationJob: { jobId: job.value.jobId } });
    expect((await made.value.pause({ expectedStateVersion: 2 })).ok).toBe(true); expect(signal.aborted).toBe(true);

    const h2 = harness(); const made2 = await h2.create(); if (!made2.ok) return; const job2 = await made2.value.generate({ expectedStateVersion: 1 }); if (!job2.ok) return;
    const signal2 = h2.generator.calls[0]!.signal; h2.repository.failNextCommit = true;
    await expect(made2.value.close()).rejects.toThrow("persistence-failed");
    expect(signal2.aborted).toBe(false); expect(made2.value.snapshot()?.status).toBe("generating");
    expect((await made2.value.pause({ expectedStateVersion: 2 })).ok).toBe(true);
  });

  it("requires historical IDs on recovery and repairs a persisted active job only on explicit pause", async () => {
    const h = harness(); const made = await h.create(); if (!made.ok) return; const job = await made.value.generate({ expectedStateVersion: 1 }); if (!job.ok) return;
    const recoveredState = made.value.snapshot(); if (!recoveredState) return;
    const recovered = PlanController.fromRecovered(h.options, recoveredState, new Set(["historical-id"])); expect(recovered.ok).toBe(true); if (!recovered.ok) return;
    const commitsBefore = h.repository.commits.length; expect(recovered.value.snapshot()?.status).toBe("generating"); expect(h.repository.commits).toHaveLength(commitsBefore);
    expect((await recovered.value.pause({ expectedStateVersion: 2 })).ok).toBe(true); expect(recovered.value.snapshot()?.status).toBe("paused");
  });

  it("keeps last-good state and exact versions across generator and persistence failures", async () => {
    const start = harness(); const made = await start.create(); if (!made.ok) return;
    start.repository.failNextCommit = true;
    expect(await made.value.generate({ expectedStateVersion: 1 })).toMatchObject({ ok: false, error: { code: "persistence-failed" } });
    expect(made.value.snapshot()).toMatchObject({ status: "paused", stateVersion: 1, documentRevision: 0 }); expect(start.generator.calls).toHaveLength(0);

    const h = await readyController(); const before = h.controller.snapshot()!;
    const job = await h.controller.revise({ expectedStateVersion: before.stateVersion, selectedAnnotationIds: [] }); if (!job.ok) return;
    h.generator.finish({ ok: false, error: { code: "model-failed", message: "Safe failure" } }); await job.value.completion;
    expect(h.controller.snapshot()).toMatchObject({ status: "error", stateVersion: before.stateVersion + 2, documentRevision: before.documentRevision, document: before.document });

    const retry = await h.controller.revise({ expectedStateVersion: h.controller.snapshot()!.stateVersion, selectedAnnotationIds: [] }); if (!retry.ok) return;
    h.repository.failNextCommit = true; h.generator.finish({ ok: true, outcome: revisionFor(before) });
    expect(await retry.value.completion).toMatchObject({ ok: false, error: { code: "persistence-failed" } });
    expect(h.controller.snapshot()).toMatchObject({ status: "revising", documentRevision: before.documentRevision, document: before.document });
  });

  it("durably pauses repeated delegated synthesis omission while retaining recoverable request history", async () => {
    const h = harness(); const made = await h.create(); if (!made.ok) return;
    const job = await made.value.generate({ expectedStateVersion: 1 }); if (!job.ok) return;
    h.generator.finish({ ok: false, error: { code: "delegated-planning-paused", message: "Plan synthesis paused after repeated missing submissions; the saved request can be retried." } });
    expect(await job.value.completion).toMatchObject({ ok: true });
    expect(made.value.snapshot()).toMatchObject({
      status: "paused", stateVersion: 3, documentRevision: 0,
      lastError: { code: "delegated-planning-paused" }, source: { prompt: "Build it", cwd: "/repo" },
    });
    expect(made.value.snapshot()).not.toHaveProperty("generationJob");
    expect(h.repository.commits.map((entry) => entry.session.status)).toEqual(["paused", "generating", "paused"]);
  });

  it("keeps accept ready on persistence failure and publishes only after durable commit", async () => {
    const h = await readyController(); const state = h.controller.snapshot()!; const events: string[] = [];
    h.controller.subscribe((event) => events.push(`${event.kind}:${h.repository.accepted.length}`));
    h.repository.failNextAccepted = true;
    expect(await h.controller.accept({ expectedStateVersion: state.stateVersion, documentRevision: state.documentRevision, confirmed: true })).toMatchObject({ ok: false, error: { code: "persistence-failed" } });
    expect(h.controller.snapshot()?.status).toBe("ready"); expect(h.staged).toHaveLength(0); expect(events).toHaveLength(0);
    expect((await h.controller.accept({ expectedStateVersion: state.stateVersion, documentRevision: state.documentRevision, confirmed: true })).ok).toBe(true);
    expect(events).toEqual(["accepted:1"]);
  });

  it("verifies captured skills without mutation and durably fails closed without adopting changed refs", async () => {
    const h = await readyController(); const before = h.controller.snapshot()!; const commitsBefore = h.repository.commits.length;
    expect((await h.controller.verifySkills({ expectedStateVersion: before.stateVersion })).ok).toBe(true);
    expect(h.controller.snapshot()).toEqual(before); expect(h.repository.commits).toHaveLength(commitsBefore);

    const changedReference = { ...reference, sha256: "c".repeat(64) };
    h.setSkillResult({ ok: true, value: { references: [changedReference], contexts: loaded.contexts } });
    expect(await h.controller.verifySkills({ expectedStateVersion: before.stateVersion })).toMatchObject({ ok: true });
    expect(h.controller.snapshot()).toMatchObject({ status: "needs-input", stateVersion: before.stateVersion + 1, lastError: { code: "skill-context-changed" }, source: { skills: [reference] } });
    expect(h.repository.commits.at(-1)?.eventKind).toBe("skill-check-failed");
  });

  it("keeps skill verification stale/job-active/persistence failures race-safe and supports recovered jobs", async () => {
    const stale = await readyController(); const state = stale.controller.snapshot()!;
    expect(await stale.controller.verifySkills({ expectedStateVersion: state.stateVersion - 1 })).toMatchObject({ ok: false, error: { code: "state-conflict" } });

    const active = harness(); const made = await active.create(); if (!made.ok) return;
    const job = await made.value.generate({ expectedStateVersion: 1 }); if (!job.ok) return;
    expect(await made.value.verifySkills({ expectedStateVersion: 2 })).toMatchObject({ ok: false, error: { code: "job-active" } });

    const recoveredState = made.value.snapshot(); if (!recoveredState) return;
    const recovered = PlanController.fromRecovered(active.options, recoveredState, ["historical-id"]); if (!recovered.ok) return;
    active.setSkillResult({ ok: false, issues: [{ path: "$", code: "missing", message: "missing" }] });
    active.repository.failNextCommit = true;
    expect(await recovered.value.verifySkills({ expectedStateVersion: 2 })).toMatchObject({ ok: false, error: { code: "persistence-failed" } });
    expect(recovered.value.snapshot()).toMatchObject({ status: "generating", stateVersion: 2, generationJob: { jobId: job.value.jobId } });
    expect(await recovered.value.verifySkills({ expectedStateVersion: 2 })).toMatchObject({ ok: true });
    expect(recovered.value.snapshot()).toMatchObject({ status: "needs-input", stateVersion: 3, lastError: { code: "skill-context-changed" } });
    expect(recovered.value.snapshot()).not.toHaveProperty("generationJob");
  });

  it("persists skill failure before abort and supports explicit refresh recovery", async () => {
    const h = harness(); const made = await h.create(); if (!made.ok) return; const job = await made.value.generate({ expectedStateVersion: 1 }); if (!job.ok) return;
    const signal = h.generator.calls[0]!.signal; h.repository.failNextCommit = true;
    h.generator.finish({ ok: false, error: { code: "skill-context-changed", message: "safe" } });
    expect(await job.value.completion).toMatchObject({ ok: false, error: { code: "persistence-failed" } });
    expect(signal.aborted).toBe(false); expect(made.value.snapshot()?.status).toBe("generating");
    expect((await made.value.pause({ expectedStateVersion: 2 })).ok).toBe(true);
    h.setSkillResult({ ok: false, issues: [{ path: "$", code: "changed", message: "changed" }] });
    expect(await made.value.refreshSkills({ expectedStateVersion: 3, selectedNames: ["testing"], discovered: [] })).toMatchObject({ ok: true });
    expect(made.value.snapshot()?.status).toBe("needs-input");
    h.setSkillResult({ ok: true, value: loaded });
    expect((await made.value.refreshSkills({ expectedStateVersion: 4, selectedNames: ["testing"], discovered: [] })).ok).toBe(true);
    expect(made.value.snapshot()).toMatchObject({ status: "paused", stateVersion: 5 });
  });

  it("reserves recovered session, active job, document, annotation, and caller historical IDs", async () => {
    const h = await readyController(); let state = h.controller.snapshot(); if (!state?.document) return;
    const step = state.document.elements[1]; if (!step) return;
    await h.controller.addAnnotation({ expectedStateVersion: state.stateVersion, target: { kind: "element", elementId: step.id }, body: "note" });
    state = h.controller.snapshot(); if (!state?.document) return;
    const occupied = [state.id, ...[state.document.id, state.document.title.id, ...state.document.elements.map((element) => element.id)], state.annotations[0]!.id, "historical-id"];
    const sequence = [...occupied, "fresh-job"]; const options = { ...h.options, idFactory: () => sequence.shift() ?? "later" };
    const repositoryRecovery: RecoveredPlanState = { state, reservedIds: ["historical-id"], warnings: [], locator: locator(state) };
    const recovered = PlanController.fromRecovered(options, repositoryRecovery.state!, repositoryRecovery.reservedIds); if (!recovered.ok) return;
    const restarted = await recovered.value.revise({ expectedStateVersion: state.stateVersion, selectedAnnotationIds: [] });
    expect(restarted.ok && restarted.value.jobId).toBe("fresh-job");

    const active = recovered.value.snapshot()!; const activeSequence = [active.id, active.generationJob!.jobId, "historical-id", "fresh-after-active"];
    const activeRecovered = PlanController.fromRecovered({ ...h.options, idFactory: () => activeSequence.shift() ?? "later-active" }, active, ["historical-id"]); if (!activeRecovered.ok) return;
    expect((await activeRecovered.value.pause({ expectedStateVersion: active.stateVersion })).ok).toBe(true);
    const afterPause = await activeRecovered.value.addAnnotation({ expectedStateVersion: active.stateVersion + 1, target: { kind: "root", elementId: active.document!.id }, body: "after active recovery" });
    expect(afterPause.ok && activeRecovered.value.snapshot()?.annotations.at(-1)?.id).toBe("fresh-after-active");
  });

  it("cancels and closes active current-agent gates after durable state transitions", async () => {
    const active = harness(); const made = await active.create(); if (!made.ok) return; const job = await made.value.generate({ expectedStateVersion: 1 }); if (!job.ok) return;
    const signal = active.generator.calls.at(-1)!.signal;
    expect((await made.value.cancel({ expectedStateVersion: 2 })).ok).toBe(true); expect(signal.aborted).toBe(true); expect(made.value.snapshot()?.status).toBe("cancelled");

    const revision = await readyController(); const state = revision.controller.snapshot()!; const revisionJob = await revision.controller.revise({ expectedStateVersion: state.stateVersion, selectedAnnotationIds: [] }); if (!revisionJob.ok) return;
    const revisionSignal = revision.generator.calls.at(-1)!.signal; await revision.controller.close();
    expect(revisionSignal.aborted).toBe(true); expect(revision.controller.snapshot()).toMatchObject({ status: "paused", documentRevision: state.documentRevision });
    expect(revision.repository.commits.at(-1)?.session.status).toBe("paused");
  });

  it("ignores late completion after pause and closes idempotently", async () => {
    const h = harness(); const made = await h.create(); if (!made.ok) return; const job = await made.value.generate({ expectedStateVersion: 1 }); if (!job.ok) return;
    expect((await made.value.pause({ expectedStateVersion: 2 })).ok).toBe(true);
    h.generator.finish({ ok: true, outcome: initial }); expect((await job.value.completion).ok).toBe(false);
    expect(made.value.snapshot()?.status).toBe("paused");
    await made.value.close(); await made.value.close(); expect(h.repository.closed).toBe(1); expect(h.generator.closed).toBe(1);
  });
});
