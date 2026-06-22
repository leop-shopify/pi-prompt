import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extensionPromptTemplatesPath, listPromptTemplates, memorizePromptTemplate, promptTemplateName } from "../prompt-templates.js";

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
let tempAgentDir: string | undefined;

const BUNDLED_TEMPLATE_NAMES = [
  "behavior-preserving-refactor",
  "cross-repo-project-plan",
  "documentation-sync",
  "implementation-contract",
  "pr-readiness",
  "project-backlog-burn-down",
  "quality-gate",
  "release-readiness",
  "review-user-stories",
  "root-cause-debug",
  "test-coverage-map",
] as const;

const BUNDLED_TEMPLATE_QUALITY_MARKERS = [
  "## Verification surface",
  "## Completion audit",
  "## Blocked stop condition",
  "## Final artifact",
] as const;

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
  it("builds filename-safe names", () => {
    expect(promptTemplateName("Crème brûlée prompt")).toBe("creme-brulee-prompt");
    expect(promptTemplateName("🤖 !!!")).toBe("saved-prompt-template");
  });
});

describe("listPromptTemplates", () => {
  it("lists user-saved prompt templates from the Pi agent prompt-templates directory", async () => {
    const agentDir = await useTempAgentDir();
    const templatesDir = join(agentDir, "prompt-templates");
    await mkdir(templatesDir, { recursive: true });
    await writeFile(join(templatesDir, "ship-it.md"), [
      "# Ship changes",
      "",
      "Deploy the current branch.",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(templatesDir, "notes.txt"), "ignored", "utf8");

    await expect(listPromptTemplates({ includeExtensionTemplates: false })).resolves.toEqual([
      {
        name: "ship-it",
        path: join(agentDir, "prompt-templates", "ship-it.md"),
        title: "Ship changes",
        text: "# Ship changes\n\nDeploy the current branch.\n",
        source: "user",
      },
    ]);
  });

  it("lists bundled extension prompt templates from a shareable markdown directory", async () => {
    const agentDir = await useTempAgentDir();
    const extensionTemplatesDir = join(agentDir, "extension-prompt-templates");
    await mkdir(extensionTemplatesDir, { recursive: true });
    await writeFile(join(extensionTemplatesDir, "review-user-stories.md"), [
      "# Review user stories",
      "",
      "Create user stories from the app code.",
      "",
    ].join("\n"), "utf8");

    await expect(listPromptTemplates({ extensionTemplatesDir })).resolves.toMatchObject([
      {
        name: "review-user-stories",
        title: "Review user stories",
        text: "# Review user stories\n\nCreate user stories from the app code.\n",
        source: "extension",
      },
    ]);
  });

  it("ships eleven high-signal bundled goal templates", async () => {
    await useTempAgentDir();

    const extensionTemplatesDir = extensionPromptTemplatesPath();
    const markdownFiles = (await readdir(extensionTemplatesDir)).filter((entry) => entry.endsWith(".md"));
    const templates = await listPromptTemplates({ extensionTemplatesDir });
    const bundled = templates.filter((template) => template.source === "extension");

    expect(markdownFiles.sort()).toEqual(BUNDLED_TEMPLATE_NAMES.map((name) => `${name}.md`).sort());
    expect(bundled.map((template) => template.name).sort()).toEqual([...BUNDLED_TEMPLATE_NAMES].sort());

    for (const template of bundled) {
      const raw = await readFile(template.path, "utf8");

      expect(raw).toMatch(/^---\n/);
      expect(raw).toMatch(/\ndescription:\s*["'][^"'\n]+["']\n/);
      expect(template.text.trim()).toMatch(/^\/goal\b/);
      expect(template.text).toMatch(/evidence|verification|verified/i);
      for (const marker of BUNDLED_TEMPLATE_QUALITY_MARKERS) expect(template.text).toContain(marker);
    }
  });

  it("lets user-saved templates override bundled templates with the same name", async () => {
    const agentDir = await useTempAgentDir();
    const extensionTemplatesDir = join(agentDir, "extension-prompt-templates");
    const userTemplatesDir = join(agentDir, "prompt-templates");
    await mkdir(extensionTemplatesDir, { recursive: true });
    await mkdir(userTemplatesDir, { recursive: true });
    await writeFile(join(extensionTemplatesDir, "review.md"), "# Bundled review\n\nBundled text.\n", "utf8");
    await writeFile(join(userTemplatesDir, "review.md"), "# Saved review\n\nSaved text.\n", "utf8");

    await expect(listPromptTemplates({ extensionTemplatesDir, userTemplatesDir })).resolves.toEqual([
      {
        name: "review",
        path: join(userTemplatesDir, "review.md"),
        title: "Saved review",
        text: "# Saved review\n\nSaved text.\n",
        source: "user",
      },
    ]);
  });

  it("falls back to the first prompt line when frontmatter has no title", async () => {
    const agentDir = await useTempAgentDir();
    const templatesDir = join(agentDir, "prompt-templates");
    await mkdir(templatesDir, { recursive: true });
    await writeFile(join(templatesDir, "fallback.md"), "Summarize the diff\n\nUse bullets.\n", "utf8");

    await expect(listPromptTemplates({ includeExtensionTemplates: false })).resolves.toMatchObject([
      {
        name: "fallback",
        title: "Summarize the diff",
        text: "Summarize the diff\n\nUse bullets.\n",
        source: "user",
      },
    ]);
  });
});

describe("memorizePromptTemplate", () => {
  it("writes a user prompt template under the Pi agent prompt-templates directory", async () => {
    const agentDir = await useTempAgentDir();

    const template = await memorizePromptTemplate("Review staged changes\n\nFocus on bugs.");

    expect(template).toEqual({
      name: "review-staged-changes",
      path: join(agentDir, "prompt-templates", "review-staged-changes.md"),
      created: true,
      title: "Review staged changes",
    });
    await expect(readFile(template.path, "utf8")).resolves.toBe([
      "# Review staged changes",
      "",
      "Review staged changes",
      "",
      "Focus on bugs.",
      "",
    ].join("\n"));
  });

  it("does not duplicate an existing identical saved prompt template", async () => {
    await useTempAgentDir();

    const first = await memorizePromptTemplate("Repeatable prompt");
    const second = await memorizePromptTemplate("Repeatable prompt");

    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
  });

  it("uses a numbered name when the generated prompt template name already exists with different content", async () => {
    const agentDir = await useTempAgentDir();
    const templatesDir = join(agentDir, "prompt-templates");
    await mkdir(templatesDir, { recursive: true });
    await writeFile(join(templatesDir, "review-staged-changes.md"), "different prompt", "utf8");

    const template = await memorizePromptTemplate("Review staged changes\n\nFocus on regressions.");

    expect(template.name).toBe("review-staged-changes-2");
    await expect(readFile(template.path, "utf8")).resolves.toContain("Focus on regressions.");
  });

  it("keeps an existing markdown title when saving a template", async () => {
    const agentDir = await useTempAgentDir();

    const template = await memorizePromptTemplate("# Custom title\n\nBody text.");

    expect(template).toMatchObject({
      name: "custom-title",
      path: join(agentDir, "prompt-templates", "custom-title.md"),
      title: "Custom title",
    });
    await expect(readFile(template.path, "utf8")).resolves.toBe("# Custom title\n\nBody text.\n");
  });
});
