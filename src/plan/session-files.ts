import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isSafePlanSessionId } from "./locator.js";

/** Writer HTTP body limits. These files are ergonomic local drafts only and are never trusted as submissions. */
export const MAX_PLAN_FILE_BYTES = 512 * 1024;
export const MAX_WRITER_RESULT_BYTES = 64 * 1024;
export const MAX_GRILL_RESULT_BYTES = 256 * 1024;

export function defaultPlanRoot(): string {
  return join(homedir(), ".pi", "agent", "pi-prompt", "plans");
}

export function planSessionDirectory(rootDir: string, sessionId: string): string {
  if (!isSafePlanSessionId(sessionId)) throw new Error("unsafe-session-id");
  const root = resolve(rootDir);
  const directory = resolve(root, sessionId);
  const bounded = relative(root, directory);
  if (!bounded || bounded.startsWith("..") || isAbsolute(bounded)) throw new Error("unsafe-session-path");
  return directory;
}

export function planFilePath(rootDir: string, sessionId: string): string {
  return join(planSessionDirectory(rootDir, sessionId), "plan.md");
}

export function annotationsFilePath(rootDir: string, sessionId: string): string {
  return join(planSessionDirectory(rootDir, sessionId), "annotations.json");
}

export function clarificationsFilePath(rootDir: string, sessionId: string): string {
  return join(planSessionDirectory(rootDir, sessionId), "clarifications.json");
}

export function grillFilePath(rootDir: string, sessionId: string): string {
  return join(planSessionDirectory(rootDir, sessionId), "grill.json");
}

/** Local writer draft path; canonical clarification state is repository-owned clarifications.json. */
export function writerQuestionsFilePath(rootDir: string, sessionId: string): string {
  return join(planSessionDirectory(rootDir, sessionId), "questions.json");
}

/** Local writer draft path; canonical Adversarial Review state is repository-owned grill.json. */
export function writerGrillFilePath(rootDir: string, sessionId: string): string {
  return join(planSessionDirectory(rootDir, sessionId), "grill-result.json");
}
