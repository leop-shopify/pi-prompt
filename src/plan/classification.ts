import type { PlanDocument, PlanElement } from "./types.js";

export const ACCEPTED_PLAN_IMPLEMENTATION = [
  "## Accepted Plan implementation",
  "IMPLEMENT the accepted Plan now in the current repository and continue through verification.",
  "Do not merely acknowledge it or rewrite it into another plan.",
  "The exact accepted Plan Markdown at the end of this message is authoritative. Follow it without replacing it with a new planning artifact.",
  "Do not create /create-goal or issue-tracker artifacts. Do not commit, push, deploy, install dependencies, or start services unless separately authorized.",
].join("\n\n");

export const EXECUTION_LEADERSHIP_BOOTSTRAP = [
  "## Execution leadership",
  "Before implementation, the receiving lead must inspect the leadership and orchestration skills available in the current session and preload the best fit. Do not assume or hard-code a tool or skill name; use the available task and agent capabilities.",
  "Convert this request or accepted plan into explicit outcome-based tasks and dependencies before implementation. Do not treat the whole request as one lane, and do not give one teammate all substantive outcomes.",
  "Keep a sole execution lane with the lead. Delegate only genuinely independent, bounded lanes; the lead retains integration, cross-lane decisions, and final verification.",
].join("\n\n");

export function renderPlanMarkdown(document: PlanDocument): string {
  const sections: string[] = [`# ${document.title.body}`];
  if (document.title.title) sections.push(document.title.title);
  for (const element of document.elements) renderElement(element, 2, sections);
  return `${sections.join("\n\n").trim()}\n`;
}

function renderElement(element: PlanElement, depth: number, output: string[]): void {
  const heading = element.title ?? labelForKind(element.kind);
  output.push(`${"#".repeat(Math.min(depth, 6))} ${heading}\n\n${element.body}`);
  for (const child of element.children) renderElement(child, depth + 1, output);
}

function labelForKind(kind: PlanElement["kind"]): string {
  return kind.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}
