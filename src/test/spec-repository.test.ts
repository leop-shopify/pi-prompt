import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSpecRepository } from "../spec/repository.js";
import { sha256Text } from "../spec/schema.js";
import type { SpecBranchLocator, SpecSession } from "../spec/types.js";
import { MARKDOWN, NOW, source } from "./spec-fixtures.js";

const roots: string[] = []; async function root() { const value = await mkdtemp(join(tmpdir(), "spec-repo-")); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
describe("durable Spec repository", () => {
  it("commits independent immutable states/revisions, projections, atomic final, and recovery", async () => {
    const base = await root(); const repo = createSpecRepository({ rootDir: base, clock: () => NOW }); const locators: SpecBranchLocator[] = [];
    const initial: SpecSession = { schemaVersion: 1, planSessionId: "plan-session", stateVersion: 1, specRevision: 0, status: "paused", source: source(base), markdown: null, comments: [] };
    await repo.commit({ session: initial, previous: null, eventKind: "created", appendLocator: (locator) => locators.unshift(locator) });
    const ready: SpecSession = { ...initial, stateVersion: 2, specRevision: 1, status: "ready", markdown: MARKDOWN };
    await repo.commit({ session: ready, previous: initial, eventKind: "revision-committed", appendLocator: (locator) => locators.unshift(locator) });
    const artifact = join(base, "plan-session", "spec"); await expect(readFile(join(artifact, "final-spec.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const nonacceptedRecovery = await createSpecRepository({ rootDir: base, clock: () => NOW }).recover(locators); expect(nonacceptedRecovery.state).toEqual(ready); await expect(readFile(join(artifact, "final-spec.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const accepted: SpecSession = { ...ready, stateVersion: 3, status: "accepted" };
    await repo.commitAccepted({ session: accepted, previous: ready, eventKind: "accepted", finalMarkdown: MARKDOWN, appendLocator: (locator) => locators.unshift(locator) });
    expect(await readFile(join(artifact, "spec.md"), "utf8")).toBe(MARKDOWN); expect(await readFile(join(artifact, "final-spec.md"), "utf8")).toBe(MARKDOWN); expect((await stat(join(artifact, "final-spec.md"))).mode & 0o777).toBe(0o600); expect(JSON.parse(await readFile(join(artifact, "comments.json"), "utf8"))).toEqual([]);
    const revisions = await readFile(join(artifact, "revisions", `${1}-${locators[0]!.stateSha256}.spec.md`), "utf8").catch(() => null); expect(revisions).toBeNull();
    const recoveredRepo = createSpecRepository({ rootDir: base, clock: () => NOW }); const recovered = await recoveredRepo.recover(locators); expect(recovered.state).toEqual(accepted);
  });
  it("allows only a dedicated rebase to reset materialization while retaining immutable history and recovering the latest source", async () => {
    const base = await root(); const repo = createSpecRepository({ rootDir: base, clock: () => NOW }); const locators: SpecBranchLocator[] = [];
    const initial: SpecSession = { schemaVersion: 1, planSessionId: "plan-session", stateVersion: 1, specRevision: 0, status: "paused", source: source(base), markdown: null, comments: [] };
    await repo.commit({ session: initial, previous: null, eventKind: "created", appendLocator: (locator) => locators.unshift(locator) });
    const ready: SpecSession = { ...initial, stateVersion: 2, specRevision: 1, status: "ready", markdown: MARKDOWN }; const readyCommit = await repo.commit({ session: ready, previous: initial, eventKind: "revision-committed", appendLocator: (locator) => locators.unshift(locator) });
    const freshSource = { ...source(base), planStateVersion: 6, annotationsSha256: "b".repeat(64), grillStateVersion: 6, grillDecisionTreeSha256: "c".repeat(64) };
    const rebased: SpecSession = { ...ready, stateVersion: 3, specRevision: 0, status: "generating", source: freshSource, markdown: null, comments: [], generationJob: { jobId: "fresh-job", operation: "initial", baseSpecRevision: 0, selectedCommentIds: [], source: freshSource, startedAt: NOW } };
    await expect(repo.commit({ session: rebased, previous: ready, eventKind: "state-changed", appendLocator: () => undefined })).rejects.toMatchObject({ code: "invalid-transition" });
    await repo.commit({ session: rebased, previous: ready, eventKind: "rebased", appendLocator: (locator) => locators.unshift(locator) });
    const artifact = join(base, "plan-session", "spec"); await expect(readFile(join(artifact, "spec.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(artifact, "states", `${readyCommit.locator.stateVersion}-${readyCommit.locator.stateSha256}.spec.json`), "utf8"))).toEqual(ready);
    expect(await readFile(join(artifact, "revisions", `1-${sha256Text(MARKDOWN)}.spec.md`), "utf8")).toBe(MARKDOWN);
    const recovered = await createSpecRepository({ rootDir: base, clock: () => NOW }).recover(locators); expect(recovered.state).toEqual(rebased); await expect(readFile(join(artifact, "spec.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("removes stale final-spec.md when a corrupt accepted locator falls back from paused through ready", async () => {
    const base = await root(); const repo = createSpecRepository({ rootDir: base, clock: () => NOW }); const locators: SpecBranchLocator[] = [];
    const paused: SpecSession = { schemaVersion: 1, planSessionId: "plan-session", stateVersion: 1, specRevision: 0, status: "paused", source: source(base), markdown: null, comments: [] };
    await repo.commit({ session: paused, previous: null, eventKind: "created", appendLocator: (locator) => locators.unshift(locator) });
    const ready: SpecSession = { ...paused, stateVersion: 2, specRevision: 1, status: "ready", markdown: MARKDOWN };
    await repo.commit({ session: ready, previous: paused, eventKind: "revision-committed", appendLocator: (locator) => locators.unshift(locator) });
    const accepted: SpecSession = { ...ready, stateVersion: 3, status: "accepted" };
    await repo.commitAccepted({ session: accepted, previous: ready, eventKind: "accepted", finalMarkdown: MARKDOWN, appendLocator: (locator) => locators.unshift(locator) });
    const artifact = join(base, "plan-session", "spec"); await writeFile(join(artifact, "states", `${locators[0]!.stateVersion}-${locators[0]!.stateSha256}.spec.json`), "corrupt\n");
    const recovered = await createSpecRepository({ rootDir: base, clock: () => NOW }).recover(locators);
    expect(recovered.state).toEqual(ready); expect(recovered.warnings).toContain("invalid-state"); await expect(readFile(join(artifact, "final-spec.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["deleted", "tampered"] as const)("recovers accepted final-spec.md when it is %s", async (condition) => {
    const base = await root(); const repo = createSpecRepository({ rootDir: base, clock: () => NOW }); const locators: SpecBranchLocator[] = [];
    const initial: SpecSession = { schemaVersion: 1, planSessionId: "plan-session", stateVersion: 1, specRevision: 0, status: "paused", source: source(base), markdown: null, comments: [] };
    await repo.commit({ session: initial, previous: null, eventKind: "created", appendLocator: (locator) => locators.unshift(locator) }); const ready: SpecSession = { ...initial, stateVersion: 2, specRevision: 1, status: "ready", markdown: MARKDOWN };
    await repo.commit({ session: ready, previous: initial, eventKind: "revision-committed", appendLocator: (locator) => locators.unshift(locator) }); const accepted: SpecSession = { ...ready, stateVersion: 3, status: "accepted" };
    await repo.commitAccepted({ session: accepted, previous: ready, eventKind: "accepted", finalMarkdown: MARKDOWN, appendLocator: (locator) => locators.unshift(locator) }); const finalPath = join(base, "plan-session", "spec", "final-spec.md");
    if (condition === "deleted") await unlink(finalPath); else await writeFile(finalPath, "tampered\n");
    const recovered = await createSpecRepository({ rootDir: base, clock: () => NOW }).recover(locators);
    expect(recovered.state).toEqual(accepted); expect(await readFile(finalPath, "utf8")).toBe(MARKDOWN); expect((await stat(finalPath)).mode & 0o777).toBe(0o600);
  });
  it.each(["outside", "sibling"] as const)("rejects hash-valid recovered state whose source points %s before rebuilding projections", async (condition) => {
    const base = await root(); const outside = condition === "outside" ? await root() : join(base, "sibling"); const repo = createSpecRepository({ rootDir: base, clock: () => NOW }); const locators: SpecBranchLocator[] = [];
    const initial: SpecSession = { schemaVersion: 1, planSessionId: "plan-session", stateVersion: 1, specRevision: 0, status: "paused", source: source(base), markdown: null, comments: [] };
    await repo.commit({ session: initial, previous: null, eventKind: "created", appendLocator: (locator) => locators.unshift(locator) }); const ready: SpecSession = { ...initial, stateVersion: 2, specRevision: 1, status: "ready", markdown: MARKDOWN };
    await repo.commit({ session: ready, previous: initial, eventKind: "revision-committed", appendLocator: (locator) => locators.unshift(locator) }); const accepted: SpecSession = { ...ready, stateVersion: 3, status: "accepted" };
    await repo.commitAccepted({ session: accepted, previous: ready, eventKind: "accepted", finalMarkdown: MARKDOWN, appendLocator: (locator) => locators.unshift(locator) });
    const tampered: SpecSession = { ...accepted, source: { ...accepted.source, planArtifactPath: outside, planMarkdownPath: join(outside, "plan.md"), annotationsPath: join(outside, "annotations.json"), grillPath: join(outside, "grill.json") } };
    const bytes = `${JSON.stringify(tampered, null, 2)}\n`; const stateSha256 = sha256Text(bytes); const artifact = join(base, "plan-session", "spec");
    await writeFile(join(artifact, "states", `3-${stateSha256}.spec.json`), bytes); const locator = { ...locators[0]!, stateSha256 };
    await Promise.all(["spec.json", "comments.json", "spec.md", "final-spec.md"].map((name) => unlink(join(artifact, name))));
    const recovered = await createSpecRepository({ rootDir: base, clock: () => NOW }).recover([locator]);
    expect(recovered.state).toBeNull(); expect(recovered.locator).toBeNull(); expect(recovered.warnings).toContain("invalid-state");
    for (const name of ["spec.json", "comments.json", "spec.md", "final-spec.md"]) await expect(readFile(join(artifact, name))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outside, "spec", "spec.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects final bytes that differ from accepted exact Markdown", async () => {
    const base = await root(); const repo = createSpecRepository({ rootDir: base, clock: () => NOW }); const initial: SpecSession = { schemaVersion: 1, planSessionId: "plan-session", stateVersion: 1, specRevision: 0, status: "paused", source: source(base), markdown: null, comments: [] }; await repo.commit({ session: initial, previous: null, eventKind: "created", appendLocator: () => undefined }); const ready: SpecSession = { ...initial, stateVersion: 2, specRevision: 1, status: "ready", markdown: MARKDOWN }; await repo.commit({ session: ready, previous: initial, eventKind: "revision-committed", appendLocator: () => undefined }); await expect(repo.commitAccepted({ session: { ...ready, stateVersion: 3, status: "accepted" }, previous: ready, eventKind: "accepted", finalMarkdown: "# Other\n", appendLocator: () => undefined })).rejects.toMatchObject({ code: "final-spec-mismatch" });
  });
});
