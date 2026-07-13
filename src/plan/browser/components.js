import { element, replaceChildren } from "./dom.js";

export function renderPlan(snapshot, treeNode, _onComment, onEdit, busy = false, stage = "plan", selectedAnnotationIds = [], onToggleSelection = () => {}) {
  const markdown = typeof snapshot.planMarkdown === "string" ? snapshot.planMarkdown : null;
  treeNode.classList.toggle("single-plan", markdown !== null); treeNode.dataset.stage = stage;
  if (markdown === null || !snapshot.document) {
    replaceChildren(treeNode, [placeholder(snapshot.clarification ? "Planning is waiting for your answers" : snapshot.job ? "The Plan is being generated" : "No Plan yet", snapshot.clarification ? "Continue above when you are ready." : snapshot.job ? "The durable Plan will appear here automatically." : "Start or retry planning from Pi.")]);
    return;
  }
  const visible = snapshot.annotations.filter((note) => stage === "grill" || note.author !== "grill");
  const projection = projectPlanAnnotations(markdown, snapshot.document, visible); const selected = new Set(selectedAnnotationIds);
  const surface = element("pre", { className: "plan-markdown", dataset: { commentSurface: stage }, tabIndex: 0, "aria-label": `${stage === "grill" ? "Grill review of" : "Plan"} Markdown revision ${snapshot.documentRevision ?? "current"}` }, annotatedNodes(markdown, projection.inline, onEdit, busy, selected, onToggleSelection));
  surface.planProjection = projection.fields; surface.planDocumentId = snapshot.document.id;
  const fallback = projection.fallback.length
    ? [element("div", { className: "root-annotation-badges", "aria-label": "Plan-level and unmatched comments" }, projection.fallback.map((note) => annotationBadge(note, onEdit, busy, true, selected, onToggleSelection)))]
    : [];
  replaceChildren(treeNode, [surface, ...fallback]);
}

export function projectPlanAnnotations(markdown, document, annotations) {
  const fields = projectDocumentFields(markdown, document); const inline = []; const fallback = [];
  for (const note of annotations) {
    if (note.status === "orphaned") { fallback.push(note); continue; }
    if (note.target.kind === "root") { fallback.push(note); continue; }
    const candidates = fields.filter((field) => field.elementId === note.target.elementId);
    if (note.target.kind === "range") {
      const field = candidates.find((candidate) => candidate.field === note.target.selector.field);
      const start = field ? field.start + note.target.selector.start : -1; const end = field ? field.start + note.target.selector.end : -1;
      const exact = start >= 0 && [...markdown].slice(start, end).join("") === note.target.selector.exact;
      if (exact) { inline.push({ ...note, target: { selector: { start, end } } }); continue; }
    }
    const anchor = candidates.find((candidate) => candidate.field === "body") ?? candidates.at(-1);
    if (anchor) inline.push({ ...note, target: { selector: { start: anchor.end, end: anchor.end } } }); else fallback.push(note);
  }
  return { fields, inline, fallback };
}

function projectDocumentFields(markdown, document) {
  const points = [...markdown]; const fields = []; let cursor = 0;
  const locate = (text) => {
    const needle = [...String(text)]; if (!needle.length) return { start: cursor, end: cursor };
    const matchesAt = (at) => needle.every((point, index) => points[at + index] === point);
    let start = -1; for (let at = cursor; at <= points.length - needle.length; at += 1) if (matchesAt(at)) { start = at; break; }
    if (start < 0) for (let at = 0; at <= points.length - needle.length; at += 1) if (matchesAt(at)) { start = at; break; }
    if (start < 0) return null; cursor = start + needle.length; return { start, end: cursor };
  };
  const visit = (entry) => {
    if (entry.title !== undefined) { const found = locate(entry.title); if (found) fields.push({ ...found, elementId: entry.id, field: "title" }); }
    const body = locate(entry.body); if (body) fields.push({ ...body, elementId: entry.id, field: "body" });
    for (const child of entry.children) visit(child);
  };
  visit(document.title); for (const entry of document.elements) visit(entry); return fields;
}

export function renderSpec(snapshot, target, onEdit, busy = false) {
  if (!snapshot?.markdown) { replaceChildren(target, [placeholder(snapshot?.job ? "The Spec is being generated" : "No Spec yet", snapshot?.job ? "The independent Spec snapshot will appear here automatically." : "Generate To Spec from the current Plan and Grill.")]); return; }
  const notes = snapshot.comments.filter((comment) => comment.status !== "orphaned").map((comment) => ({ ...comment, author: "user", target: { selector: comment.target } }));
  const pre = element("pre", { className: "spec-markdown", dataset: { commentSurface: "spec" }, tabIndex: 0, "aria-label": `Implementation Spec revision ${snapshot.specRevision}` }, annotatedNodes(snapshot.markdown, notes, onEdit, busy));
  const orphaned = snapshot.comments.filter((comment) => comment.status === "orphaned");
  const fallback = orphaned.length
    ? [element("div", { className: "root-annotation-badges", "aria-label": "Orphaned Spec comments" }, orphaned.map((comment) => annotationBadge({ ...comment, author: "user" }, onEdit, busy, true)))]
    : [];
  replaceChildren(target, [pre, ...fallback]);
}

export function inlineAnnotationSegments(text, notes) {
  const points = [...String(text)]; const boundaries = new Set([0, points.length]);
  for (const note of notes) { const selector = note.target.selector; boundaries.add(Math.max(0, Math.min(points.length, selector.start))); boundaries.add(Math.max(0, Math.min(points.length, selector.end))); }
  const sorted = [...boundaries].sort((a, b) => a - b); const segments = [];
  for (let index = 0; index < sorted.length - 1; index += 1) { const start = sorted[index]; const end = sorted[index + 1]; const active = notes.filter((note) => note.target.selector.start < end && note.target.selector.end > start); const badges = notes.filter((note) => note.target.selector.end === end && note.target.selector.start < end).sort((a, b) => a.id.localeCompare(b.id)); segments.push({ start, end, text: points.slice(start, end).join(""), notes: active, badges }); }
  return segments;
}
function annotatedNodes(text, notes, onEdit, busy, selected = new Set(), onToggleSelection = () => {}) {
  if (!notes.length) return [String(text)]; const nodes = []; const anchored = new Map();
  for (const note of notes.filter((value) => value.target.selector.start === value.target.selector.end)) anchored.set(note.target.selector.end, [...(anchored.get(note.target.selector.end) ?? []), note]);
  for (const note of anchored.get(0) ?? []) nodes.push(annotationBadge(note, onEdit, busy, false, selected, onToggleSelection));
  for (const segment of inlineAnnotationSegments(text, notes)) {
    if (segment.text) {
      const authors = new Set(segment.notes.map((note) => note.author ?? "user")); const classes = [authors.has("user") ? "your-comment-highlight" : "", authors.has("grill") ? "grill-critique-highlight" : ""].filter(Boolean).join(" ");
      nodes.push(classes ? element("mark", { className: classes }, [segment.text]) : segment.text);
    }
    for (const note of [...segment.badges, ...(anchored.get(segment.end) ?? [])]) nodes.push(annotationBadge(note, onEdit, busy, false, selected, onToggleSelection));
  }
  return nodes;
}
function annotationBadge(note, onEdit, busy, fallback, selectedIds = new Set(), onToggleSelection = () => {}) {
  const generated = note.author === "grill"; const selectable = generated && note.status === "open"; const selected = selectable && selectedIds.has(note.id); const provenance = generated ? "Grill critique" : "Your comment"; const status = note.locked ? `${note.status}, locked` : note.status;
  const selection = selectable ? ` ${selected ? "Selected" : "Not selected"} for Plan revision. Press Enter to ${selected ? "deselect" : "select"} and review.` : "";
  const label = `${provenance}: ${note.body}. Status: ${status}.${generated ? ` Generated text is read-only.${selection}` : " Press Enter to edit."}`;
  const badge = element("button", { type: "button", className: `annotation-badge author-${generated ? "grill" : "user"} status-${note.status}${selected ? " is-selected" : ""}${fallback ? " annotation-fallback" : ""}`, title: label, disabled: busy,
    ...(selectable ? { role: "checkbox", "aria-checked": String(selected) } : {}), dataset: { annotationId: note.id, focusKey: `annotation-badge-${note.id}`, preview: `${provenance} · ${note.body} · ${status}${selectable ? selected ? " · selected" : " · not selected" : ""}` }, "aria-label": label }, [element("span", { "aria-hidden": "true" }, [selectable ? selected ? "✓" : "○" : "•"])]);
  badge.addEventListener("click", () => { const anchor = badge.getBoundingClientRect(); if (selectable) onToggleSelection(note.id); onEdit(note, anchor); }); return badge;
}
function placeholder(title, body) { return element("div", { className: "plan-placeholder" }, [element("strong", {}, [title]), element("p", {}, [body])]); }

export function renderClarification(snapshot, target, draft, onDraft, busy = false) {
  const pending = snapshot.clarification; if (!pending) { replaceChildren(target, []); return; }
  replaceChildren(target, pending.questions.map((question, index) => {
    const selected = draft?.answers?.[question.id]; const choices = question.options.map((option) => {
      const input = element("input", { type: "radio", name: `clarification-${question.id}`, value: option.id, checked: selected?.kind === "option" && selected.optionId === option.id, disabled: busy, dataset: { focusKey: `clarification-${pending.id}-${question.id}-${option.id}` } });
      input.addEventListener("change", () => onDraft(question.id, { kind: "option", optionId: option.id })); return element("label", { className: "clarification-option" }, [input, element("span", {}, [option.label])]);
    });
    const customId = `clarification-custom-${index}`; const radio = element("input", { type: "radio", name: `clarification-${question.id}`, checked: selected?.kind === "custom", disabled: busy, dataset: { focusKey: `clarification-${pending.id}-${question.id}-custom` }, "aria-label": `Custom answer for ${question.prompt}` });
    const custom = element("textarea", { id: customId, rows: 2, maxLength: 4096, disabled: busy, value: selected?.kind === "custom" ? selected.text : "", placeholder: "Write a custom answer", dataset: { focusKey: `clarification-${pending.id}-${question.id}-custom-text` } });
    radio.addEventListener("change", () => onDraft(question.id, { kind: "custom", text: custom.value })); custom.addEventListener("focus", () => { radio.checked = true; onDraft(question.id, { kind: "custom", text: custom.value }); }); custom.addEventListener("input", () => onDraft(question.id, { kind: "custom", text: custom.value }));
    choices.push(element("div", { className: "clarification-custom" }, [radio, element("label", { htmlFor: customId }, ["Custom answer"]), custom]));
    return element("fieldset", { className: "clarification-question" }, [element("legend", {}, [`${index + 1}. ${question.prompt}`]), ...choices]);
  }));
}
