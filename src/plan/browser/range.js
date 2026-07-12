function isAnnotationBadge(node) {
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest(".annotation-badge"));
}
function canonicalLength(node) {
  if (isAnnotationBadge(node)) return 0;
  if (node.nodeType === Node.TEXT_NODE) return [...node.data].length;
  return [...node.childNodes].reduce((total, child) => total + canonicalLength(child), 0);
}
function canonicalText(root) {
  const chunks = []; const visit = (node) => {
    if (isAnnotationBadge(node)) return;
    if (node.nodeType === Node.TEXT_NODE) { chunks.push(node.data); return; }
    for (const child of node.childNodes) visit(child);
  };
  visit(root); return chunks.join("");
}
function boundaryOffset(root, container, rawOffset) {
  const locate = (node, base) => {
    if (isAnnotationBadge(node)) return null;
    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) return rawOffset >= 0 && rawOffset <= node.data.length ? base + [...node.data.slice(0, rawOffset)].length : null;
      if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > node.childNodes.length) return null;
      return base + [...node.childNodes].slice(0, rawOffset).reduce((total, child) => total + canonicalLength(child), 0);
    }
    let offset = base;
    for (const child of node.childNodes) {
      const found = locate(child, offset); if (found !== null) return found;
      offset += canonicalLength(child);
    }
    return null;
  };
  return locate(root, 0);
}
function offsetsWithin(root, range) {
  return { start: boundaryOffset(root, range.startContainer, range.startOffset), end: boundaryOffset(root, range.endContainer, range.endOffset) };
}
function closestField(node) {
  return (node instanceof Element ? node : node.parentElement)?.closest("[data-plan-field]");
}
function graphemeBoundaries(text) {
  const boundaries = new Set([0, [...text].length]);
  if (typeof Intl.Segmenter !== "function") return boundaries;
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) boundaries.add([...text.slice(0, part.index)].length);
  return boundaries;
}
export function selectionTarget(selection = window.getSelection()) {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return { ok: false, message: "Select text inside one plan field first." };
  const range = selection.getRangeAt(0);
  const startField = closestField(range.startContainer);
  const endField = closestField(range.endContainer);
  if (!startField || startField !== endField) return { ok: false, message: "Comments can select text within one title or body field only." };
  const owner = startField.closest("[data-plan-element-id]");
  if (!owner) return { ok: false, message: "That selection is outside the plan." };
  const text = canonicalText(startField);
  const { start, end } = offsetsWithin(startField, range);
  if (start === null || end === null || end <= start) return { ok: false, message: "The selected range could not be measured." };
  const boundaries = graphemeBoundaries(text);
  if (!boundaries.has(start) || !boundaries.has(end)) return { ok: false, message: "Select complete characters; the current selection splits a grapheme." };
  const points = [...text];
  return { ok: true, target: { kind: "range", elementId: owner.dataset.planElementId, selector: { field: startField.dataset.planField, start, end, exact: points.slice(start, end).join(""), prefix: points.slice(Math.max(0, start - 32), start).join(""), suffix: points.slice(end, end + 32).join("") } } };
}
