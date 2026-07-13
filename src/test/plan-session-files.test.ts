import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  annotationsFilePath, clarificationsFilePath, grillFilePath, planFilePath, planSessionDirectory, writerGrillFilePath, writerQuestionsFilePath,
} from "../plan/session-files.js";

describe("plan session projection paths", () => {
  it("derives only bounded session-local projection and writer draft paths", () => {
    const root = "/tmp/pi-prompt-plans"; const directory = join(root, "session-safe");
    expect(planSessionDirectory(root, "session-safe")).toBe(directory);
    expect(planFilePath(root, "session-safe")).toBe(join(directory, "plan.md"));
    expect(annotationsFilePath(root, "session-safe")).toBe(join(directory, "annotations.json"));
    expect(clarificationsFilePath(root, "session-safe")).toBe(join(directory, "clarifications.json"));
    expect(grillFilePath(root, "session-safe")).toBe(join(directory, "grill.json"));
    expect(writerQuestionsFilePath(root, "session-safe")).toBe(join(directory, "questions.json"));
    expect(writerGrillFilePath(root, "session-safe")).toBe(join(directory, "grill-result.json"));
  });

  it.each(["../escape", "a/b", "", ".", ".."])("rejects unsafe session ID %j", (sessionId) => {
    expect(() => planSessionDirectory("/tmp/pi-prompt-plans", sessionId)).toThrow();
  });
});
