import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanRepository, defaultPlanRepositoryRoot, PlanRepositoryError } from "../plan/repository.js";
import type { PlanBranchLocator } from "../plan/locator.js";
import type { PlanSession } from "../plan/types.js";

const NOW = "2026-07-10T12:00:00.000Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "plan-repo-")); roots.push(value); return value; }
function session(overrides: Partial<PlanSession> = {}): PlanSession {
  return {
    schemaVersion: 1, id: "session-1", stateVersion: 1, documentRevision: 1, status: "ready",
    source: { prompt: "private prompt", cwd: "/private/work", skills: [{ name: "secret-skill", path: "/private/SKILL.md", baseDir: "/private", sha256: "a".repeat(64) }] },
    execution: { kind: "normal" }, generation: { mode: "careful" },
    document: { id: "doc", title: { id: "title", kind: "title", body: "Plan", children: [] }, elements: [{ id: "execution", kind: "execution", body: "Normal", children: [] }] }, annotations: [],
    ...overrides,
  } as PlanSession;
}
const canonical = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("private plan repository", () => {
  it("uses the documented per-session plan root", () => {
    expect(defaultPlanRepositoryRoot()).toBe(join(homedir(), ".pi", "agent", "pi-prompt", "plans"));
  });

  it("commits content-addressed state and revision before the locator with private modes", async () => {
    const base = await root(); const repo = createPlanRepository({ rootDir: base, clock: () => NOW }); const locators: PlanBranchLocator[] = [];
    const value = session(); const result = await repo.commit({ session: value, previous: null, eventKind: "created", appendLocator: (locator) => {
      locators.push(locator); expect(locator.stateSha256).toMatch(/^[a-f0-9]{64}$/);
    } });
    const artifact = join(base, value.id); const stateBytes = canonical(result.state); const documentBytes = canonical(result.state.document);
    expect(await readFile(join(artifact, "plan.json"), "utf8")).toBe(stateBytes);
    expect(await readFile(join(artifact, "annotations.json"), "utf8")).toBe("[]\n");
    expect(await readFile(join(artifact, "states", `${value.stateVersion}-${result.locator.stateSha256}.session.json`), "utf8")).toBe(stateBytes);
    const documentSha = createHash("sha256").update(documentBytes).digest("hex");
    expect(await readFile(join(artifact, "revisions", `1-${documentSha}.plan.json`), "utf8")).toBe(documentBytes);
    expect((await stat(artifact)).mode & 0o777).toBe(0o700); expect((await stat(join(artifact, "plan.json"))).mode & 0o777).toBe(0o600);
    const metadata = await readFile(join(artifact, "metadata.json"), "utf8");
    expect(metadata).not.toContain("private prompt"); expect(metadata).not.toContain("secret-skill"); expect(metadata).not.toContain("/private");
    expect(metadata).not.toContain(createHash("sha256").update("private prompt").digest("hex"));
    expect(locators).toHaveLength(1);
  });

  it("projects and recovers exact committed Markdown plus private clarification state while ignoring writer results", async () => {
    const base = await root(); const repo = createPlanRepository({ rootDir: base, clock: () => NOW }); const locators: PlanBranchLocator[] = [];
    const exact = "# Plan\r\n\r\n## Execution\r\nNormal\r\n"; const value = session({ committedMarkdown: exact, clarifications: { history: [] } });
    await repo.commit({ session: value, previous: null, eventKind: "created", appendLocator: (locator) => locators.unshift(locator) }); const artifact = join(base, value.id);
    expect(await readFile(join(artifact, "plan.md"), "utf8")).toBe(exact); expect(await readFile(join(artifact, "clarifications.json"), "utf8")).toBe(canonical({ history: [] }));
    await writeFile(join(artifact, "plan.md"), "tampered"); await writeFile(join(artifact, "clarifications.json"), "tampered");
    const recovered = await repo.recover(locators); expect(recovered.state?.committedMarkdown).toBe(exact); expect(await readFile(join(artifact, "plan.md"), "utf8")).toBe(exact); expect(await readFile(join(artifact, "clarifications.json"), "utf8")).toBe(canonical({ history: [] }));
  });

  it("keeps the document revision for annotation-only state and preserves old revision bytes", async () => {
    const base = await root(); const repo = createPlanRepository({ rootDir: base, clock: () => NOW }); const appendLocator = () => undefined;
    const first = session(); await repo.commit({ session: first, previous: null, eventKind: "created", appendLocator });
    const second = session({ stateVersion: 2, annotations: [] }); await repo.commit({ session: second, previous: first, eventKind: "updated", appendLocator });
    const changedDocument = second.document === null ? undefined : { ...second.document, title: { ...second.document.title, body: "Changed" } };
    const third = session({ stateVersion: 3, documentRevision: 2, ...(changedDocument ? { document: changedDocument } : {}) }); await repo.commit({ session: third, previous: second, eventKind: "updated", appendLocator });
    expect(await readdir(join(base, "session-1", "revisions"))).toHaveLength(2);
    await expect(repo.commit({ session: session({ stateVersion: 4, documentRevision: 2, document: { ...third.document!, title: { ...third.document!.title, body: "Again" } } }), previous: third, eventKind: "updated", appendLocator })).rejects.toMatchObject({ code: "missing-document-revision" });
    await expect(repo.commit({ session: session({ stateVersion: 5 }), previous: third, eventKind: "updated", appendLocator })).rejects.toBeInstanceOf(PlanRepositoryError);
  });

  it("accepts identical immutable artifacts, rejects forged collisions, and rolls projections back when locator append fails", async () => {
    const base = await root(); const repo = createPlanRepository({ rootDir: base, clock: () => NOW }); const first = session();
    await repo.commit({ session: first, previous: null, eventKind: "created", appendLocator: () => undefined });
    const before = await readFile(join(base, first.id, "plan.json")); const second = session({ stateVersion: 2 });
    await expect(repo.commit({ session: second, previous: first, eventKind: "updated", appendLocator: () => { throw new Error("private detail"); } })).rejects.toMatchObject({ code: "locator-append-failed" });
    expect(await readFile(join(base, first.id, "plan.json"))).toEqual(before);
    const stateFile = (await readdir(join(base, first.id, "states"))).find((name) => name.startsWith("2-"));
    expect(stateFile).toBeDefined(); if (!stateFile) return;
    await writeFile(join(base, first.id, "states", stateFile), "forged");
    await expect(repo.commit({ session: second, previous: first, eventKind: "updated", appendLocator: () => undefined })).rejects.toMatchObject({ code: "immutable-mismatch" });
  });

  it("rolls final text and projections back when the accepted locator append fails", async () => {
    const base = await root(); const repo = createPlanRepository({ rootDir: base, clock: () => NOW }); const first = session();
    await repo.commit({ session: first, previous: null, eventKind: "created", appendLocator: () => undefined });
    const before = await readFile(join(base, first.id, "plan.json"));
    const accepted = session({ stateVersion: 2, status: "accepted" });
    await expect(repo.commitAccepted({ session: accepted, previous: first, eventKind: "accepted", finalPlan: "# Final\n", appendLocator: () => { throw new Error("private"); } })).rejects.toMatchObject({ code: "locator-append-failed" });
    expect(await readFile(join(base, first.id, "plan.json"))).toEqual(before);
    await expect(readFile(join(base, first.id, "final-plan.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back from a corrupt newest locator and repairs projections without promoting unlocated files", async () => {
    const base = await root(); const repo = createPlanRepository({ rootDir: base, clock: () => NOW }); const locators: PlanBranchLocator[] = [];
    const first = session(); const one = await repo.commit({ session: first, previous: null, eventKind: "created", appendLocator: (value) => locators.unshift(value) });
    const second = session({ stateVersion: 2 }); const two = await repo.commit({ session: second, previous: first, eventKind: "updated", appendLocator: (value) => locators.unshift(value) });
    await writeFile(join(base, second.id, "states", `2-${two.locator.stateSha256}.session.json`), "corrupt");
    await writeFile(join(base, second.id, "plan.json"), canonical(session({ stateVersion: 99 })));
    await writeFile(join(base, second.id, ".tmp-unlocated"), "ignore");
    const recovered = await repo.recover(locators); expect(recovered.state?.stateVersion).toBe(1); expect(recovered.warnings).toContain("invalid-state"); expect(recovered.warnings).toContain("plan-rebuilt");
    expect(await readFile(join(base, second.id, "plan.json"), "utf8")).toBe(canonical(one.state));
  });

  it("recovers deterministic never-reuse IDs only from valid committed history through the chosen locator", async () => {
    const base = await root(); const repo = createPlanRepository({ rootDir: base, clock: () => NOW }); const locators: PlanBranchLocator[] = [];
    const appendLocator = (value: PlanBranchLocator) => locators.unshift(value);
    const first = session({ annotations: [{
      id: "old-annotation", target: { kind: "root", elementId: "doc" },
      targetSnapshot: { documentRevision: 1, target: { kind: "root", elementId: "doc" }, elementKind: "root", text: "" },
      body: "historical", status: "open", history: [], createdAgainstRevision: 1, createdAt: NOW, updatedAt: NOW,
    }] });
    await repo.commit({ session: first, previous: null, eventKind: "created", appendLocator });
    expect(JSON.parse(await readFile(join(base, first.id, "annotations.json"), "utf8"))).toEqual(first.annotations);
    const second = session({ stateVersion: 2, status: "revising", annotations: first.annotations, generationJob: {
      jobId: "old-job", operation: "revision", baseDocumentRevision: 1, selectedAnnotationIds: ["old-annotation"], startedAt: NOW,
    } });
    await repo.commit({ session: second, previous: first, eventKind: "state-changed", appendLocator });
    const currentDocument = { id: "doc", title: { id: "title", kind: "title" as const, body: "Plan", children: [] }, elements: [{ id: "execution", kind: "execution" as const, body: "Normal", children: [] }, { id: "current-step", kind: "step" as const, body: "Current", children: [] }] };
    const third = session({ stateVersion: 3, documentRevision: 2, status: "ready", document: currentDocument, annotations: [], generationJob: undefined });
    await repo.commit({ session: third, previous: second, eventKind: "revision-committed", appendLocator });

    const future = session({ stateVersion: 4, documentRevision: 3, document: { ...currentDocument, elements: [...currentDocument.elements, { id: "future-id", kind: "risk", body: "future", children: [] }] } });
    const futureCommit = await repo.commit({ session: future, previous: third, eventKind: "revision-committed", appendLocator });
    const corruptFuture = { ...future, document: { ...future.document!, elements: [...future.document!.elements, { id: "corrupt-injected-id", kind: "risk" as const, body: "forged", children: [] }] } };
    await writeFile(join(base, future.id, "states", `4-${futureCommit.locator.stateSha256}.session.json`), canonical(corruptFuture));
    const unrelated = session({ id: "other-session", document: { id: "other-doc", title: { id: "other-title", kind: "title", body: "Other", children: [] }, elements: [{ id: "other-id", kind: "execution", body: "Other", children: [] }] } });
    let unrelatedLocator: PlanBranchLocator | undefined;
    await repo.commit({ session: unrelated, previous: null, eventKind: "created", appendLocator: (value) => { unrelatedLocator = value; } });
    if (!unrelatedLocator) return;
    locators.splice(2, 0, unrelatedLocator);

    const recovered = await repo.recover(locators);
    expect(recovered.state?.stateVersion).toBe(3);
    expect(recovered.reservedIds).toEqual([...recovered.reservedIds].sort());
    expect(recovered.reservedIds).toEqual(expect.arrayContaining(["session-1", "doc", "title", "execution", "current-step", "old-annotation", "old-job"]));
    expect(recovered.reservedIds).not.toEqual(expect.arrayContaining(["future-id", "corrupt-injected-id", "other-session", "other-doc", "other-id"]));
    expect(recovered.warnings).toContain("invalid-state");
  });

  it("returns an empty reserved-ID set when no locator can be recovered", async () => {
    const repo = createPlanRepository({ rootDir: await root(), clock: () => NOW });
    await expect(repo.recover([])).resolves.toMatchObject({ state: null, locator: null, reservedIds: [] });
  });

  it("bounds audit events and never copies private source text into them", async () => {
    const base = await root(); const repo = createPlanRepository({ rootDir: base, clock: () => NOW }); const first = session();
    await repo.commit({ session: first, previous: null, eventKind: "created", appendLocator: () => undefined });
    const event = JSON.stringify({ kind: "updated", at: NOW, id: first.id, status: first.status, stateVersion: 1, documentRevision: 1 });
    await writeFile(join(base, first.id, "events.jsonl"), `${Array.from({ length: 256 }, () => event).join("\n")}\n`);
    const second = session({ stateVersion: 2 }); await repo.commit({ session: second, previous: first, eventKind: "updated", appendLocator: () => undefined });
    const events = await readFile(join(base, first.id, "events.jsonl"), "utf8");
    expect(events.trimEnd().split("\n")).toHaveLength(256); expect(events).not.toContain("private prompt"); expect(events).not.toContain("secret-skill");
  });

  it("commits final text in the accepted transaction before locator append and closes idempotently", async () => {
    const base = await root(); const repo = createPlanRepository({ rootDir: base, clock: () => NOW }); const first = session();
    await repo.commit({ session: first, previous: null, eventKind: "created", appendLocator: () => undefined });
    await expect(repo.commitAccepted({ session: first, previous: null, eventKind: "accepted", finalPlan: "no", appendLocator: () => undefined })).rejects.toMatchObject({ code: "not-accepted" });
    const accepted = session({ stateVersion: 2, status: "accepted" });
    await expect(repo.commit({ session: accepted, previous: first, eventKind: "accepted", appendLocator: () => undefined })).rejects.toMatchObject({ code: "accepted-requires-final" });
    await repo.commitAccepted({ session: accepted, previous: first, eventKind: "accepted", finalPlan: "# Final\n", appendLocator: () => {
      expect(readFileSync(join(base, accepted.id, "final-plan.md"), "utf8")).toBe("# Final\n");
    } });
    expect(await readFile(join(base, accepted.id, "final-plan.md"), "utf8")).toBe("# Final\n");
    expect((await stat(join(base, accepted.id, "final-plan.md"))).mode & 0o777).toBe(0o600);
    await repo.close(); await repo.close();
    await expect(repo.commitAccepted({ session: accepted, previous: first, eventKind: "accepted", finalPlan: "again", appendLocator: () => undefined })).rejects.toMatchObject({ code: "repository-closed" });
    await chmod(base, 0o700);
  });
});
