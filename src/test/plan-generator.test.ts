import { describe, expect, it } from "vitest";
import { operationContract, parseGeneratorReport, validateGeneratorSubmission } from "../plan/generator.js";
import type { PlanSession } from "../plan/types.js";

const taskBody = "Scope: src/feature.ts\nTest first: Add a failing focused test.\nImplement: Make the bounded change.\nVerify: Run the focused test.\nDone when: The test passes.";
const initial = {
  kind: "plan",
  document: {
    title: { kind: "title", body: "Plan", children: [] },
    elements: [
      { kind: "execution", body: "Execute normally.", children: [] },
      { kind: "milestone", title: "Implementation Tasks", body: "Ordered work.", children: [{ kind: "step", title: "Build", body: taskBody, children: [] }] },
    ],
  },
};
const materialized = {
  id: "document", title: { id: "title", kind: "title", body: "Plan", children: [] },
  elements: [
    { id: "execution", kind: "execution", body: "Execute normally.", children: [] },
    { id: "tasks", kind: "milestone", title: "Implementation Tasks", body: "Ordered work.", children: [{ id: "task", kind: "step", title: "Build", body: taskBody, children: [] }] },
  ],
};
function session(document: PlanSession["document"] = null): PlanSession {
  return {
    schemaVersion: 1, id: "session", stateVersion: 2, documentRevision: document ? 1 : 0,
    status: document ? "revising" : "generating", source: { prompt: "Build it", cwd: "/repo", skills: [{ name: "private", path: "/private/SKILL.md", baseDir: "/private", sha256: "a".repeat(64) }] },
    execution: { kind: "normal" }, generation: { mode: "normal" }, document, annotations: [],
    generationJob: { jobId: "job", operation: document ? "revision" : "initial", baseDocumentRevision: document ? 1 : 0, selectedAnnotationIds: [], startedAt: "2026-07-11T00:00:00.000Z" },
  } as PlanSession;
}

describe("current-agent result validation", () => {
  it("accepts a strict initial result with actionable Implementation Tasks", () => {
    expect(validateGeneratorSubmission(initial, "initial", session(), [{ name: "private", body: "PRIVATE SKILL INSTRUCTION THAT MUST NOT LEAK" }])).toEqual({ ok: true, outcome: initial });
    expect(parseGeneratorReport(JSON.stringify(initial), "initial", session(), [])).toEqual({ ok: true, outcome: initial });
  });

  it("rejects summary-only primary reports without fabricating a replacement", () => {
    expect(parseGeneratorReport("Submitted the complete plan to the lead.", "initial", session(), [])).toMatchObject({
      ok: false, error: { code: "invalid-generation-report", message: expect.stringContaining("one complete JSON result") },
    });
    expect(parseGeneratorReport('```json\n{"kind":"plan"}\n```', "initial", session(), [])).toMatchObject({ ok: false, error: { code: "invalid-generation-report" } });
  });

  it("accepts a strict revision result with controller-known retained IDs", () => {
    const revision = {
      kind: "revision", addressedAnnotationIds: [],
      document: {
        retainedId: "document", title: { retainedId: "title", kind: "title", body: "Revised", children: [] },
        elements: [
          { retainedId: "execution", kind: "execution", body: "Execute normally.", children: [] },
          { retainedId: "tasks", kind: "milestone", title: "Implementation Tasks", body: "Ordered work.", children: [{ retainedId: "task", kind: "step", title: "Build", body: taskBody, children: [] }] },
        ],
      },
    };
    expect(validateGeneratorSubmission(revision, "revision", session(materialized as never), [{ name: "private", body: "PRIVATE SKILL INSTRUCTION THAT MUST NOT LEAK" }])).toEqual({ ok: true, outcome: revision });
  });

  it("rejects wrong contracts with actionable paths, missing task fields, and private output", () => {
    expect(validateGeneratorSubmission({ ...initial, document: { ...initial.document, title: "Plan" } }, "initial", session(), [])).toMatchObject({
      ok: false, error: { code: "invalid-generation-result", message: expect.stringContaining("$.document.title") },
    });
    expect(validateGeneratorSubmission({ ...initial, extra: true }, "initial", session(), [])).toMatchObject({ ok: false, error: { code: "invalid-generation-result" } });
    const shallow = structuredClone(initial); shallow.document.elements[1]!.children[0]!.body = "Implement it.";
    expect(validateGeneratorSubmission(shallow, "initial", session(), [])).toMatchObject({ ok: false, error: { code: "missing-implementation-tasks" } });
    const leaked = structuredClone(initial); leaked.document.title.body = "PRIVATE SKILL INSTRUCTION THAT MUST NOT LEAK";
    expect(validateGeneratorSubmission(leaked, "initial", session(), [{ name: "private", body: "PRIVATE SKILL INSTRUCTION THAT MUST NOT LEAK" }])).toMatchObject({ ok: false, error: { code: "private-output-exposure" } });
  });

  it("keeps operation and revision out of tool parameters and makes the title element shape explicit", () => {
    expect(operationContract("initial")).toContain('"kind":"plan"');
    expect(operationContract("revision")).toContain('"kind":"revision"');
    expect(operationContract("initial")).toContain('"title":{"kind":"title","body":"Plan title","children":[]}');
    expect(operationContract("initial")).toContain("never a string");
  });
});
