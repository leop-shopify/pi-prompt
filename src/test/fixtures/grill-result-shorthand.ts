export const LIVE_GRILL_ANNOTATION_KEYS = ["scope", "evidence", "rollback", "ownership"] as const;

export function liveGrillResultFixture(
  basedOnDocumentRevision: number,
  elementId: string,
  field: "title" | "body",
) {
  const ranges = [[0, 1], [1, 2], [2, 3], [3, 5]] as const;
  const bodies = [
    "Clarify the scope.",
    "Require evidence.",
    "Define rollback.",
    "Assign ownership.",
  ] as const;
  return {
    kind: "grill" as const,
    basedOnDocumentRevision,
    annotations: Object.fromEntries(LIVE_GRILL_ANNOTATION_KEYS.map((key, index) => [key, {
      target: { kind: "range" as const, elementId, field, start: ranges[index]![0], end: ranges[index]![1] },
      body: bodies[index]!,
    }])),
    decisionTree: {
      nodes: [{
        id: "decision-root",
        question: "Is this plan ready?",
        annotationKeys: [...LIVE_GRILL_ANNOTATION_KEYS],
        options: [
          { id: "proceed", label: "Proceed", decision: "Proceed with the plan." },
          { id: "revise", label: "Revise", decision: "Revise the plan first." },
        ],
      }],
    },
  };
}
