import type {
  InitialPlanResultDraft, ModelPlanElementDraft, ModelRevisionPlanElementDraft, PlanElement, PlanElementKind,
  PlanSession, RevisionPlanResultDraft, ValidationResult,
} from "./types.js";

interface MarkdownSection { readonly title: string; readonly body: string; readonly children: readonly MarkdownSection[] }
interface ParsedMarkdownPlan { readonly title: string; readonly sections: readonly MarkdownSection[] }

export function planOutcomeFromMarkdown(
  markdown: string,
  operation: "initial" | "revision",
  session: PlanSession,
  addressedAnnotationIds: readonly string[],
): ValidationResult<InitialPlanResultDraft | RevisionPlanResultDraft> {
  const parsed = parseMarkdownPlan(markdown);
  if (!parsed.ok) return parsed;
  const elements = parsed.value.sections.map(sectionToElement);
  const executionCount = elements.filter((element) => element.kind === "execution").length;
  if (executionCount !== 1) return invalid("$.plan.md", "execution-section", "plan.md must contain exactly one `## Execution` section.");
  const tasks = elements.find((element) => element.kind === "milestone" && element.title === "Implementation Tasks");
  if (!tasks || tasks.children.length === 0) return invalid("$.plan.md", "implementation-tasks", "plan.md must contain `## Implementation Tasks` with at least one `###` task.");

  const title: ModelPlanElementDraft = { kind: "title", body: parsed.value.title, children: [] };
  if (operation === "initial") return { ok: true, value: { kind: "plan", document: { title, elements } } };
  if (!session.document) return invalid("$", "missing-document", "A revision requires the current plan.");
  const prior = session.document;
  const revisedTitle: ModelRevisionPlanElementDraft = { retainedId: prior.title.id, ...title };
  const revisedElements = retainElements(elements, prior.elements);
  return {
    ok: true,
    value: {
      kind: "revision",
      document: { retainedId: prior.id, title: revisedTitle, elements: revisedElements },
      addressedAnnotationIds: [...addressedAnnotationIds],
    },
  };
}

function parseMarkdownPlan(markdown: string): ValidationResult<ParsedMarkdownPlan> {
  const lines = markdown.replace(/\r\n?/gu, "\n").normalize("NFC").split("\n");
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLine < 0 || !/^#\s+\S/u.test(lines[firstContentLine]!)) {
    return invalid("$.plan.md", "title-position", "plan.md must begin with exactly one `#` title.");
  }
  const titleLines = lines.flatMap((line, index) => /^#\s+\S/u.test(line) ? [index] : []);
  if (titleLines.length !== 1) return invalid("$.plan.md", "duplicate-title", "plan.md must contain exactly one `#` title.");
  const titleLine = firstContentLine;
  const title = lines[titleLine]!.replace(/^#\s+/u, "").trim();
  const sections: Array<{ title: string; body: string[]; children: Array<{ title: string; body: string[] }> }> = [];
  let current: (typeof sections)[number] | undefined;
  let child: (typeof sections)[number]["children"][number] | undefined;
  for (const line of lines.slice(titleLine + 1)) {
    const h2 = /^##\s+(.+)$/u.exec(line);
    if (h2) { current = { title: h2[1]!.trim(), body: [], children: [] }; sections.push(current); child = undefined; continue; }
    const h3 = /^###\s+(.+)$/u.exec(line);
    if (h3 && current) { child = { title: h3[1]!.trim(), body: [] }; current.children.push(child); continue; }
    if (!current) continue;
    (child?.body ?? current.body).push(line);
  }
  if (sections.length === 0) return invalid("$.plan.md", "missing-sections", "plan.md must contain `##` sections.");
  const normalized = sections.map((section) => ({
    title: section.title,
    body: bodyText(section.body, section.children.length > 0),
    children: section.children.map((entry) => ({ title: entry.title, body: bodyText(entry.body, false), children: [] })),
  }));
  const blank = normalized.find((section) => !section.body || section.children.some((entry) => !entry.body));
  if (blank) return invalid("$.plan.md", "empty-section", `The section \`${blank.title}\` contains an empty body.`);
  return { ok: true, value: { title, sections: normalized } };
}

function bodyText(lines: readonly string[], hasChildren: boolean): string {
  const body = lines.join("\n").trim();
  return body || (hasChildren ? "Tasks required to implement this plan." : "");
}

function sectionToElement(section: MarkdownSection): ModelPlanElementDraft {
  const kind = kindFor(section.title);
  return {
    kind,
    ...(kind === "execution" ? {} : { title: section.title }),
    body: section.body,
    children: section.children.map((child) => ({ kind: "step", title: child.title, body: child.body, children: [] })),
  };
}

function kindFor(title: string): PlanElementKind {
  const key = title.trim().toLowerCase();
  if (key === "execution") return "execution";
  if (key === "implementation tasks") return "milestone";
  if (key === "outcome") return "outcome";
  if (key === "constraints") return "constraint";
  if (key === "non-goals") return "non-goal";
  if (key === "acceptance criteria") return "acceptance-criterion";
  if (key === "risks") return "risk";
  if (key === "verification") return "verification";
  return "milestone";
}

function retainElements(elements: readonly ModelPlanElementDraft[], prior: readonly PlanElement[]): ModelRevisionPlanElementDraft[] {
  const matches = new Map<number, PlanElement>();
  const used = new Set<string>();
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    const exact = prior.filter((candidate) => !used.has(candidate.id) && candidate.kind === element.kind && (candidate.title ?? "") === (element.title ?? ""));
    if (exact.length === 1) { matches.set(index, exact[0]!); used.add(exact[0]!.id); }
  }
  for (let index = 0; index < elements.length; index += 1) {
    if (matches.has(index)) continue;
    const element = elements[index]!; const positional = prior[index];
    if (positional && !used.has(positional.id) && positional.kind === element.kind) { matches.set(index, positional); used.add(positional.id); }
  }
  for (let index = 0; index < elements.length; index += 1) {
    if (matches.has(index)) continue;
    const element = elements[index]!;
    const compatible = prior.filter((candidate) => !used.has(candidate.id) && candidate.kind === element.kind);
    if (compatible.length === 1) { matches.set(index, compatible[0]!); used.add(compatible[0]!.id); }
  }
  return elements.map((element, index) => retainElement(element, matches.get(index)));
}

function retainElement(element: ModelPlanElementDraft, prior: PlanElement | undefined): ModelRevisionPlanElementDraft {
  return {
    ...(prior ? { retainedId: prior.id } : {}),
    ...element,
    children: retainElements(element.children, prior?.children ?? []),
  };
}

function invalid<T>(path: string, code: string, message: string): ValidationResult<T> {
  return { ok: false, issues: [{ path, code, message }] };
}
