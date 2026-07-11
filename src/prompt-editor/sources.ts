import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { draftPreview, listDrafts } from "../drafts.js";
import {
  applyPromptTemplateVariables,
  extractPromptTemplateVariables,
  listPromptTemplates,
  type PromptTemplate,
  type PromptTemplateKind,
} from "../prompt-templates.js";
import { executionKindForTemplate, normalizeExecutionInput } from "../plan/classification.js";
import type { ExecutionKind, ValidationResult } from "../plan/types.js";
import type { PromptEditorInitialState } from "./types.js";

export async function preloadPromptFile(
  cwd: string, rawPath: string,
): Promise<{ readonly path: string; readonly text: string } | { readonly error: string }> {
  const cleaned = rawPath.trim().replace(/^@/, "");
  const path = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
  try { return { path, text: await readFile(path, "utf8") }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

export async function chooseDraft(ctx: ExtensionCommandContext): Promise<PromptEditorInitialState | undefined> {
  const drafts = await listDrafts();
  if (drafts.length === 0) { ctx.ui.notify("No saved drafts", "info"); return undefined; }
  const labels = drafts.map((draft, index) => `${index + 1}. ${draftPreview(draft)}  (${new Date(draft.updatedAt).toLocaleString()})`);
  const chosen = await ctx.ui.select("Open a draft", labels);
  const draft = chosen === undefined ? undefined : drafts[labels.indexOf(chosen)];
  return draft ? { text: draft.text, draftId: draft.id } : undefined;
}

export async function choosePromptTemplate(
  ctx: ExtensionCommandContext, kind: PromptTemplateKind,
): Promise<PromptEditorInitialState | undefined> {
  const templates = await listPromptTemplates({ kind });
  const noun = kind === "goal" ? "goal template" : "loop template";
  if (templates.length === 0) { ctx.ui.notify(`No saved ${noun}s`, "info"); return undefined; }
  const labels = templates.map(promptTemplateLabel);
  const chosen = await ctx.ui.select(`Open a ${noun}`, labels);
  const template = chosen === undefined ? undefined : templates[labels.indexOf(chosen)];
  if (!template) return undefined;
  const filled = await fillPromptTemplateVariables(ctx, template.text);
  if (filled === undefined) return undefined;
  const normalized = normalizeEditorSource(filled, executionKindForTemplate(kind));
  if (!normalized.ok) { ctx.ui.notify(normalized.issues[0]?.message ?? "Template execution kind conflicts.", "error"); return undefined; }
  return {
    text: normalized.value.promptText,
    execution: normalized.value.execution,
    preloadedPath: template.path,
    templateName: template.name,
    templateKind: kind,
  };
}

export function normalizeEditorSource(
  text: string, execution: ExecutionKind = { kind: "normal" },
): ValidationResult<{ readonly promptText: string; readonly execution: ExecutionKind }> {
  return normalizeExecutionInput(text, execution);
}

async function fillPromptTemplateVariables(ctx: ExtensionCommandContext, text: string): Promise<string | undefined> {
  const variables = extractPromptTemplateVariables(text);
  if (variables.length === 0) return text;
  const values: Record<string, string> = {};
  for (const variable of variables) {
    const value = await ctx.ui.input(`Fill template variable: {{${variable}}}`, variable);
    if (value === undefined) return undefined;
    values[variable] = value;
  }
  return applyPromptTemplateVariables(text, values);
}

function promptTemplateLabel(template: PromptTemplate): string {
  return `${template.title}  (${template.source === "extension" ? "extension" : "saved"}: ${template.name}.md)`;
}
