import { describe, expect, it } from "vitest";
import { operationContract, parseGeneratorReport, validateGeneratorSubmission, validateGrillSubmission } from "../plan/generator.js";
import type { PlanSession } from "../plan/types.js";
import { PLAN_LIMITS } from "../plan/schema.js";
import { liveGrillResultFixture } from "./fixtures/grill-result-shorthand.js";

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
    status: document ? "revising" : "generating", source: { prompt: "Build it", cwd: "/repo", skills: [{ name: "private", path: "/private/skill-base/SKILL.md", baseDir: "/private/skill-base", sha256: "a".repeat(64) }] },
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

  it("accepts exact arbitrary revision Markdown without semantic grading or text mutation", () => {
    const values = [
      "\uFEFFplain text, no headings or tasks\r\nUnicode: cafe\u0301 🧪\u0000\r\n",
      "x".repeat(PLAN_LIMITS.committedMarkdownBytes),
    ];
    for (const markdown of values) {
      const revision = { kind: "revision-markdown" as const, markdown };
      expect(validateGeneratorSubmission(revision, "revision", session(materialized as never), [{ name: "private", body: "PRIVATE SKILL INSTRUCTION THAT MUST NOT LEAK" }])).toEqual({ ok: true, outcome: revision });
    }
    expect(validateGeneratorSubmission({ kind: "revision", document: {}, addressedAnnotationIds: [] }, "revision", session(materialized as never), [])).toMatchObject({ ok: false, error: { code: "invalid-generation-result" } });
  });

  it.each([
    ["loaded skill body", "PRIVATE SKILL INSTRUCTION THAT MUST NOT LEAK"],
    ["selected skill path", "/private/skill-base/SKILL.md"],
    ["selected skill baseDir", "/private/skill-base"],
  ])("rejects revision Markdown containing the literal %s", (_label, markdown) => {
    expect(validateGeneratorSubmission(
      { kind: "revision-markdown", markdown }, "revision", session(materialized as never),
      [{ name: "private", body: "PRIVATE SKILL INSTRUCTION THAT MUST NOT LEAK" }],
    )).toMatchObject({ ok: false, error: { code: "private-output-exposure" } });
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

  it("validates strict Grill results against the exact revision and private-content boundary", () => {
    const current = session(materialized as never); const grill = { kind: "grill", basedOnDocumentRevision: 1, annotations: { risk: { target: { kind: "element", elementId: "task" }, body: "Prove this assumption." } }, decisionTree: { rootNodeId: "root", nodes: [{ id: "root", question: "Proceed?", annotationKeys: ["risk"], options: [{ id: "yes", label: "Yes", decision: "Proceed." }, { id: "no", label: "No", decision: "Rework." }] }] } };
    expect(validateGrillSubmission(grill, current, [])).toMatchObject({ ok: true, outcome: { kind: "grill" } });
    expect(validateGrillSubmission(liveGrillResultFixture(1, "task", "title"), current, [])).toMatchObject({ ok: true, outcome: { decisionTree: { rootNodeId: "decision-root" } } });
    expect(validateGrillSubmission({ kind: "grill", basedOnDocumentRevision: 1, annotations: {}, decisionTree: { nodes: [] } }, current, [])).toMatchObject({ ok: true, outcome: { kind: "grill" } });
    expect(validateGrillSubmission({ ...grill, basedOnDocumentRevision: 2 }, current, [])).toMatchObject({ ok: false, error: { code: "stale-grill" } });
  });

  it("keeps operation and revision out of tool parameters and makes the title element shape explicit", () => {
    expect(operationContract("grill")).toContain('{"kind":"range","elementId":"anchor-id","field":"body","start":0,"end":4}');
    expect(operationContract("grill")).toContain("Do not copy exact/prefix/suffix");
    expect(operationContract("grill")).toContain("exactly one zero-indegree root");
    expect(operationContract("initial")).toContain('"kind":"plan"');
    expect(operationContract("revision")).toContain("exact decoded Markdown");
    expect(operationContract("initial")).toContain('"title":{"kind":"title","body":"Plan title","children":[]}');
    expect(operationContract("initial")).toContain("never a string");
  });
});
