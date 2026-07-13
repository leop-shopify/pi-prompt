import { isAbsolute, join, relative, resolve } from "node:path";

/** Repository-owned Spec sidecar directory for one already-bounded Plan artifact. */
export function specSessionDirectory(planArtifactPath: string): string {
  if (!isAbsolute(planArtifactPath)) throw new Error("unsafe-plan-artifact-path");
  const plan = resolve(planArtifactPath);
  const directory = resolve(plan, "spec");
  const bounded = relative(plan, directory);
  if (!bounded || bounded.startsWith("..") || isAbsolute(bounded)) throw new Error("unsafe-spec-path");
  return directory;
}

/** Repository-owned canonical Spec projection. Writers must never write this path directly. */
export function specFilePath(planArtifactPath: string): string {
  return join(specSessionDirectory(planArtifactPath), "spec.md");
}

/** Transient writer draft; authenticated uploaded bytes remain the sole result authority. */
export function writerSpecResultFilePath(planArtifactPath: string): string {
  return join(specSessionDirectory(planArtifactPath), "spec-result.md");
}
