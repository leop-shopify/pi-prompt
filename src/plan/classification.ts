import type { ExecutionKind, PlanDocument, PlanElement, ValidationIssue, ValidationResult } from "./types.js";

export interface NormalizedExecutionInput {
  readonly execution: ExecutionKind;
  readonly promptText: string;
}

export interface StagedPlanOptions {
  readonly document: PlanDocument | string;
  readonly execution: ExecutionKind;
  readonly selectedSkillBlocks?: readonly string[];
}

export function executionKindForTemplate(kind: "goal" | "loop"): ExecutionKind {
  return Object.freeze({ kind });
}

export function normalizeExecutionInput(
  input: string,
  selected: ExecutionKind | ExecutionKind["kind"] = "normal",
): ValidationResult<NormalizedExecutionInput> {
  const selectedKind = typeof selected === "string" ? selected : selected.kind;
  const typed: Array<"goal" | "loop"> = [];
  let promptText = input;

  while (true) {
    const match = promptText.match(/^\s*\/(goal|loop)(?=$|\s)/);
    if (!match) break;
    typed.push(match[1] as "goal" | "loop");
    promptText = promptText.slice(match[0].length);
  }

  const typedKinds = [...new Set(typed)];
  if (typedKinds.length > 1) return classificationFailure("mixed-execution", "Typed /goal and /loop prefixes conflict.");
  const typedKind = typedKinds[0];
  if (typedKind && selectedKind !== "normal" && typedKind !== selectedKind) {
    return classificationFailure("selected-execution-conflict", `Selected ${selectedKind} execution conflicts with typed /${typedKind}.`);
  }

  const kind = typedKind ?? selectedKind;
  return {
    ok: true,
    value: Object.freeze({ execution: Object.freeze({ kind }), promptText: promptText.trimStart() }),
  };
}

export function renderPlanMarkdown(document: PlanDocument): string {
  const sections: string[] = [`# ${document.title.body}`];
  if (document.title.title) sections.push(document.title.title);
  for (const element of document.elements) renderElement(element, 2, sections);
  return `${sections.join("\n\n").trim()}\n`;
}

export function formatStagedPlan(options: StagedPlanOptions): string;
export function formatStagedPlan(document: PlanDocument | string, execution: ExecutionKind, selectedSkillBlocks?: readonly string[]): string;
export function formatStagedPlan(
  optionsOrDocument: StagedPlanOptions | PlanDocument | string,
  positionalExecution?: ExecutionKind,
  positionalSkillBlocks: readonly string[] = [],
): string {
  const options: StagedPlanOptions = isOptions(optionsOrDocument)
    ? optionsOrDocument
    : { document: optionsOrDocument, execution: positionalExecution ?? { kind: "normal" }, selectedSkillBlocks: positionalSkillBlocks };
  const rendered = typeof options.document === "string" ? options.document : renderPlanMarkdown(options.document);
  const planMarkdown = stripAllLeadingExecutionPrefixes(rendered).trim();
  const skillBlocks = options.selectedSkillBlocks ?? [];
  const body = [...skillBlocks, planMarkdown].join("\n\n");
  return options.execution.kind === "normal" ? body : `/${options.execution.kind} ${body}`;
}

function renderElement(element: PlanElement, depth: number, output: string[]): void {
  const heading = element.title ?? labelForKind(element.kind);
  output.push(`${"#".repeat(Math.min(depth, 6))} ${heading}\n\n${element.body}`);
  for (const child of element.children) renderElement(child, depth + 1, output);
}

function labelForKind(kind: PlanElement["kind"]): string {
  return kind.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function stripAllLeadingExecutionPrefixes(value: string): string {
  let result = value;
  while (true) {
    const match = result.match(/^\s*\/(?:goal|loop)(?=$|\s)/);
    if (!match) return result;
    result = result.slice(match[0].length);
  }
}

function isOptions(value: StagedPlanOptions | PlanDocument | string): value is StagedPlanOptions {
  return typeof value === "object" && value !== null && "document" in value && "execution" in value;
}

function classificationFailure(code: string, message: string): ValidationResult<NormalizedExecutionInput> {
  const issues: readonly ValidationIssue[] = Object.freeze([{ path: "$", code, message }]);
  return { ok: false, issues };
}
