import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MemorizedPromptTemplate {
  name: string;
  path: string;
  created: boolean;
}

const MAX_TEMPLATE_NAME_LENGTH = 48;

function promptsPath(): string {
  return join(getAgentDir(), "prompts");
}

export async function memorizePromptTemplate(text: string): Promise<MemorizedPromptTemplate> {
  const prompt = text.trim();
  if (prompt.length === 0) throw new Error("Cannot memorize an empty prompt");

  const description = promptTemplateDescription(prompt);
  const baseName = promptTemplateName(description);
  const content = buildPromptTemplateContent(prompt, description);
  const dir = promptsPath();

  await mkdir(dir, { recursive: true });

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const name = suffix === 0 ? baseName : `${baseName}-${suffix + 1}`;
    const path = join(dir, `${name}.md`);
    const existing = await readExisting(path);

    if (existing === content) return { name, path, created: false };
    if (existing === undefined) {
      await writeFile(path, content, "utf8");
      return { name, path, created: true };
    }
  }

  throw new Error(`Could not find an available prompt template name for ${baseName}`);
}

export function promptTemplateName(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TEMPLATE_NAME_LENGTH)
    .replace(/-+$/g, "");

  return slug.length > 0 ? slug : "memorized-prompt";
}

function promptTemplateDescription(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "Memorized prompt";
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

function buildPromptTemplateContent(prompt: string, description: string): string {
  return [
    "---",
    `description: ${JSON.stringify(description)}`,
    "---",
    prompt,
    "",
  ].join("\n");
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined;
    throw err;
  }
}
