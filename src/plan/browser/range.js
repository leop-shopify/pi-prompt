function isBadge(node) { const value = node instanceof Element ? node : node.parentElement; return Boolean(value?.closest(".annotation-badge")); }
function canonicalLength(node) { if (isBadge(node)) return 0; if (node.nodeType === Node.TEXT_NODE) return [...node.data].length; return [...node.childNodes].reduce((sum, child) => sum + canonicalLength(child), 0); }
function canonicalText(root) { const chunks = []; const visit = (node) => { if (isBadge(node)) return; if (node.nodeType === Node.TEXT_NODE) chunks.push(node.data); else for (const child of node.childNodes) visit(child); }; visit(root); return chunks.join(""); }
function boundaryOffset(root, container, rawOffset) {
  const locate = (node, base) => {
    if (isBadge(node)) return null;
    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) return rawOffset >= 0 && rawOffset <= node.data.length ? base + [...node.data.slice(0, rawOffset)].length : null;
      if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > node.childNodes.length) return null;
      return base + [...node.childNodes].slice(0, rawOffset).reduce((sum, child) => sum + canonicalLength(child), 0);
    }
    let offset = base; for (const child of node.childNodes) { const found = locate(child, offset); if (found !== null) return found; offset += canonicalLength(child); } return null;
  };
  return locate(root, 0);
}
function graphemeBoundaries(text) { const boundaries = new Set([0, [...text].length]); if (typeof Intl.Segmenter !== "function") return boundaries; for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) boundaries.add([...text.slice(0, part.index)].length); return boundaries; }

export function selectionTarget(selection = window.getSelection(), stage = "plan") {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return { ok: false, message: `Select text inside the ${stage === "spec" ? "Spec" : "Plan"} first.` };
  const range = selection.getRangeAt(0);
  const closest = (node) => (node instanceof Element ? node : node.parentElement)?.closest("[data-comment-surface]");
  const startSurface = closest(range.startContainer); const endSurface = closest(range.endContainer);
  if (!startSurface || startSurface !== endSurface || startSurface.dataset.commentSurface !== stage) return { ok: false, message: "Comments must select text within the current stage only." };
  const text = canonicalText(startSurface); const start = boundaryOffset(startSurface, range.startContainer, range.startOffset); const end = boundaryOffset(startSurface, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return { ok: false, message: "The selected range could not be measured." };
  const boundaries = graphemeBoundaries(text); if (!boundaries.has(start) || !boundaries.has(end)) return { ok: false, message: "Select complete characters; the current selection splits a grapheme." };
  const points = [...text];
  if (stage === "spec") return { ok: true, target: { start, end }, exact: points.slice(start, end).join("") };
  const exact = points.slice(start, end).join(""); const fields = startSurface.planProjection ?? [];
  const field = fields.find((candidate) => start >= candidate.start && end <= candidate.end);
  if (field) {
    const fieldPoints = points.slice(field.start, field.end); const relativeStart = start - field.start; const relativeEnd = end - field.start;
    return { ok: true, target: { kind: "range", elementId: field.elementId, selector: { field: field.field, start: relativeStart, end: relativeEnd, exact, prefix: fieldPoints.slice(Math.max(0, relativeStart - 32), relativeStart).join(""), suffix: fieldPoints.slice(relativeEnd, relativeEnd + 32).join("") } } };
  }
  const nearest = fields.find((candidate) => start < candidate.end && end > candidate.start)
    ?? [...fields].sort((left, right) => Math.abs(left.start - start) - Math.abs(right.start - start))[0];
  if (nearest) return { ok: true, target: { kind: "element", elementId: nearest.elementId }, exact };
  if (startSurface.planDocumentId) return { ok: true, target: { kind: "root", elementId: startSurface.planDocumentId }, exact };
  return { ok: false, message: "That selection is outside the Plan." };
}
