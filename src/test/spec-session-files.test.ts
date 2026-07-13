import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { specFilePath, specSessionDirectory, writerSpecResultFilePath } from "../spec/session-files.js";

describe("Spec sidecar paths", () => {
  it("keeps the transient writer result distinct from the repository-owned canonical Spec", () => {
    const planArtifact = "/tmp/pi-prompt-plans/session-safe";
    const directory = join(planArtifact, "spec");
    expect(specSessionDirectory(planArtifact)).toBe(directory);
    expect(specFilePath(planArtifact)).toBe(join(directory, "spec.md"));
    expect(writerSpecResultFilePath(planArtifact)).toBe(join(directory, "spec-result.md"));
    expect(writerSpecResultFilePath(planArtifact)).not.toBe(specFilePath(planArtifact));
  });

  it.each(["relative/session", "", ".", ".."])('rejects non-absolute Plan artifact path %j', (planArtifact) => {
    expect(() => specSessionDirectory(planArtifact)).toThrow("unsafe-plan-artifact-path");
  });
});
