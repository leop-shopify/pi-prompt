import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listDrafts, saveDraft } from "../drafts.js";
import { applyPromptTemplateVariables, extractPromptTemplateVariables } from "../prompt-templates.js";
import { normalizeEditorSource, preloadPromptFile } from "../prompt-editor/sources.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempPaths: string[] = [];
afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

async function tempDir(prefix: string): Promise<string> { const path = await mkdtemp(join(tmpdir(), prefix)); tempPaths.push(path); return path; }

describe("prompt editor sources", () => {
  it("preloads relative files without changing their text", async () => {
    const cwd = await tempDir("pi-prompt-source-");
    await writeFile(join(cwd, "request.md"), "/goal\r\nBuild this\n", "utf8");
    await expect(preloadPromptFile(cwd, "@request.md")).resolves.toEqual({ path: join(cwd, "request.md"), text: "/goal\r\nBuild this\n" });
  });

  it("persists and reopens drafts only in an isolated agent directory", async () => {
    process.env.PI_CODING_AGENT_DIR = await tempDir("pi-prompt-agent-");
    const draft = await saveDraft("unfinished plan");
    await expect(listDrafts()).resolves.toEqual([draft]);
  });

  it("preserves template variables", () => {
    const source = "Build {{ feature }} in {{repo}} then verify {{ feature }}";
    expect(extractPromptTemplateVariables(source)).toEqual(["feature", "repo"]);
    expect(applyPromptTemplateVariables(source, { feature: "search", repo: "app" })).toBe("Build search in app then verify search");
  });

  it("normalizes matching template and typed execution without preserving the controlled prefix", () => {
    expect(normalizeEditorSource("/goal\nBuild it", { kind: "goal" })).toEqual({
      ok: true, value: { promptText: "Build it", execution: { kind: "goal" } },
    });
    expect(normalizeEditorSource("/loop /goal Build it", { kind: "loop" })).toMatchObject({ ok: false });
    expect(normalizeEditorSource("/goal Build it", { kind: "loop" })).toMatchObject({ ok: false });
  });
});
