import { PLAN_LIMITS } from "./schema.js";
import type { PlanDocument, PlanElement } from "./types.js";

/**
 * Builds a deliberately non-authoritative compatibility document for consumers that
 * still require the legacy PlanDocument shape. The committed Markdown remains the
 * sole content authority; this total projection only chunks exact code points so
 * browser selections and Adversarial Review findings can refer back to the displayed bytes.
 */
export function projectMarkdownPlan(markdown: string, revision: number): PlanDocument {
  const chunks = chunkCodePoints(markdown, PLAN_LIMITS.bodyCodePoints);
  const suffix = String(revision);
  const children: PlanElement[] = chunks.slice(1).map((body, index) => ({
    id: `markdown-projection-chunk-v1-${suffix}-${index + 1}`,
    kind: "step",
    body,
    children: [],
  }));
  return {
    id: `markdown-projection-v1-${suffix}`,
    title: { id: `markdown-projection-title-v1-${suffix}`, kind: "title", body: "", children: [] },
    elements: [{
      id: `markdown-projection-chunk-v1-${suffix}-0`,
      kind: "execution",
      body: chunks[0] ?? "",
      children,
    }],
  };
}

function chunkCodePoints(value: string, size: number): string[] {
  const points = [...value];
  if (points.length === 0) return [];
  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += size) chunks.push(points.slice(index, index + size).join(""));
  return chunks;
}
