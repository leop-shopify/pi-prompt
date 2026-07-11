import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isSafePlanSessionId } from "./locator.js";

export const MAX_PLAN_FILE_BYTES = 512 * 1024;

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

export async function readPlanFile(rootDir: string, sessionId: string): Promise<string> {
  const path = planFilePath(rootDir, sessionId);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_PLAN_FILE_BYTES) throw new Error("invalid-plan-file");
  const text = await readFile(path, "utf8");
  const normalized = text.replace(/\r\n?/gu, "\n").normalize("NFC").trim();
  if (!normalized) throw new Error("empty-plan-file");
  return `${normalized}\n`;
}
