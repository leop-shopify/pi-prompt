import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memorizePromptTemplate, promptTemplateName } from "../prompt-templates.js";

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
let tempAgentDir: string | undefined;

async function useTempAgentDir(): Promise<string> {
  tempAgentDir = await mkdtemp(join(tmpdir(), "pi-prompt-"));
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  return tempAgentDir;
}

afterEach(async () => {
  if (tempAgentDir) await rm(tempAgentDir, { recursive: true, force: true });
  tempAgentDir = undefined;

  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
});

describe("promptTemplateName", () => {
  it("builds slash-command-safe names", () => {
    expect(promptTemplateName("Crème brûlée prompt")).toBe("creme-brulee-prompt");
    expect(promptTemplateName("🤖 !!!")).toBe("memorized-prompt");
  });
});

describe("memorizePromptTemplate", () => {
  it("writes a global prompt template under the Pi agent prompts directory", async () => {
    const agentDir = await useTempAgentDir();

    const template = await memorizePromptTemplate("Review staged changes\n\nFocus on bugs.");

    expect(template).toEqual({
      name: "review-staged-changes",
      path: join(agentDir, "prompts", "review-staged-changes.md"),
      created: true,
    });
    await expect(readFile(template.path, "utf8")).resolves.toBe([
      "---",
      'description: "Review staged changes"',
      "---",
      "Review staged changes",
      "",
      "Focus on bugs.",
      "",
    ].join("\n"));
  });

  it("reuses an existing identical memorized prompt instead of duplicating it", async () => {
    await useTempAgentDir();

    const first = await memorizePromptTemplate("Repeatable prompt");
    const second = await memorizePromptTemplate("Repeatable prompt");

    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
  });

  it("uses a numbered name when the generated prompt template name already exists with different content", async () => {
    const agentDir = await useTempAgentDir();
    const promptsDir = join(agentDir, "prompts");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(join(promptsDir, "review-staged-changes.md"), "different prompt", "utf8");

    const template = await memorizePromptTemplate("Review staged changes\n\nFocus on regressions.");

    expect(template.name).toBe("review-staged-changes-2");
    await expect(readFile(template.path, "utf8")).resolves.toContain("Focus on regressions.");
  });
});
