import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MemorizedPromptTemplate {
  name: string;
  path: string;
  created: boolean;
  title: string;
}

export type PromptTemplateSource = "extension" | "user";
export type PromptTemplateKind = "goal" | "loop";

export interface PromptTemplate {
  name: string;
  path: string;
  title: string;
  text: string;
  source: PromptTemplateSource;
}

export interface ListPromptTemplatesOptions {
  userTemplatesDir?: string;
  extensionTemplatesDir?: string;
  includeExtensionTemplates?: boolean;
  kind?: PromptTemplateKind;
}

const MAX_TEMPLATE_NAME_LENGTH = 48;
const PROMPT_TEMPLATE_VARIABLE_PATTERN = /{{\s*([^{}\n]+?)\s*}}/g;

function promptTemplatesDirName(kind: PromptTemplateKind): string {
  return kind === "loop" ? "loop-templates" : "prompt-templates";
}

export function userPromptTemplatesPath(kind: PromptTemplateKind = "goal"): string {
  return join(getAgentDir(), promptTemplatesDirName(kind));
}

export function extensionPromptTemplatesPath(kind: PromptTemplateKind = "goal"): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", promptTemplatesDirName(kind));
}

export async function listPromptTemplates(options: ListPromptTemplatesOptions = {}): Promise<PromptTemplate[]> {
  const kind = options.kind ?? "goal";
  const includeExtensionTemplates = options.includeExtensionTemplates ?? true;
  const extensionTemplates = includeExtensionTemplates
    ? await readPromptTemplates(options.extensionTemplatesDir ?? extensionPromptTemplatesPath(kind), "extension")
    : [];
  const userTemplates = await readPromptTemplates(options.userTemplatesDir ?? userPromptTemplatesPath(kind), "user");

  return mergePromptTemplates([...extensionTemplates, ...userTemplates]);
}

export async function memorizePromptTemplate(text: string): Promise<MemorizedPromptTemplate> {
  const prompt = text.trim();
  if (prompt.length === 0) throw new Error("Cannot save an empty prompt template");

  const title = promptTemplateTitle(prompt);
  const baseName = promptTemplateName(title);
  const content = buildPromptTemplateContent(prompt, title);
  const dir = userPromptTemplatesPath();

  await mkdir(dir, { recursive: true });

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const name = suffix === 0 ? baseName : `${baseName}-${suffix + 1}`;
    const path = join(dir, `${name}.md`);
    const existing = await readExisting(path);

    if (existing === content) return { name, path, created: false, title };
    if (existing === undefined) {
      await writeFile(path, content, "utf8");
      return { name, path, created: true, title };
    }
  }

  throw new Error(`Could not find an available prompt template name for ${baseName}`);
}

export function extractPromptTemplateVariables(text: string): string[] {
  const variables: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(PROMPT_TEMPLATE_VARIABLE_PATTERN)) {
    const variable = match[1]?.trim();
    if (!variable || seen.has(variable)) continue;
    seen.add(variable);
    variables.push(variable);
  }

  return variables;
}

export function applyPromptTemplateVariables(text: string, values: Record<string, string>): string {
  return text.replace(PROMPT_TEMPLATE_VARIABLE_PATTERN, (placeholder, rawVariable: string) => {
    const variable = rawVariable.trim();
    return Object.prototype.hasOwnProperty.call(values, variable) ? values[variable] ?? "" : placeholder;
  });
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

  return slug.length > 0 ? slug : "saved-prompt-template";
}

async function readPromptTemplates(dir: string, source: PromptTemplateSource): Promise<PromptTemplate[]> {
  const entries = await readPromptTemplateEntries(dir);
  const templates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => readPromptTemplate(join(dir, entry.name), entry.name.slice(0, -3), source)),
  );

  return templates.filter((template): template is PromptTemplate => template !== undefined);
}

function mergePromptTemplates(templates: PromptTemplate[]): PromptTemplate[] {
  const byName = new Map<string, PromptTemplate>();
  for (const template of templates) byName.set(template.name, template);
  return [...byName.values()].sort((a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name));
}

function promptTemplateTitle(text: string): string {
  return markdownTitle(text) ?? firstPromptLine(text) ?? "Saved prompt template";
}

function firstPromptLine(text: string): string | undefined {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0)?.trim();
  if (!firstLine) return undefined;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

function buildPromptTemplateContent(prompt: string, title: string): string {
  const content = markdownTitle(prompt) ? prompt : [`# ${title}`, "", prompt].join("\n");
  return `${content.trim()}\n`;
}

async function readPromptTemplateEntries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

async function readPromptTemplate(path: string, name: string, source: PromptTemplateSource): Promise<PromptTemplate | undefined> {
  const raw = await readExisting(path);
  if (raw === undefined) return undefined;

  const { title, text } = parsePromptTemplateContent(raw);
  return { name, path, title, text, source };
}

function parsePromptTemplateContent(raw: string): { title: string; text: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const frontmatter = splitPromptTemplateFrontmatter(normalized);
  const title = frontmatter.title ?? promptTemplateTitle(frontmatter.text);
  return { title, text: frontmatter.text };
}

function splitPromptTemplateFrontmatter(raw: string): { title?: string; text: string } {
  if (!raw.startsWith("---\n")) return { text: raw };

  const lines = raw.split("\n");
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) return { text: raw };

  const metadata = lines.slice(1, endIndex).join("\n");
  const text = lines.slice(endIndex + 1).join("\n");
  return { title: promptTemplateFrontmatterTitle(metadata), text };
}

function promptTemplateFrontmatterTitle(metadata: string): string | undefined {
  for (const key of ["title", "description"]) {
    const title = promptTemplateFrontmatterValue(metadata, key);
    if (title) return title;
  }

  return undefined;
}

function promptTemplateFrontmatterValue(metadata: string, key: string): string | undefined {
  for (const line of metadata.split("\n")) {
    const match = line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (!match) continue;

    const value = match[1]?.trim() ?? "";
    if (!value) return undefined;

    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string" && parsed.trim().length > 0) return parsed.trim();
    } catch {
      // Plain YAML scalars are expected too; fall back to a simple trim below.
    }

    return value.replace(/^['"]|['"]$/g, "").trim() || undefined;
  }

  return undefined;
}

function markdownTitle(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^#\s+(.+?)\s*#*$/);
    if (!match) {
      if (line.trim().length > 0) return undefined;
      continue;
    }

    const title = match[1]?.trim();
    return title && title.length > 120 ? `${title.slice(0, 117)}…` : title;
  }

  return undefined;
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isNotFoundError(err)) return undefined;
    throw err;
  }
}

function isNotFoundError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}
