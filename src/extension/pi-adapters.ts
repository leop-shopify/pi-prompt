import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { captureSelectedSkills, reloadSavedSkills, type DiscoveredSkillReference } from "../plan/skills.js";
import type { LoadedPrivateSkills, PlanControllerSkillPort } from "../plan/controller.js";
import type { SkillReference, ValidationResult } from "../plan/types.js";
import { PLAN_LOCATOR_CUSTOM_TYPE, type AppendPlanBranchLocator } from "../plan/locator.js";

export function discoverSkills(pi: Pick<ExtensionAPI, "getCommands">): readonly DiscoveredSkillReference[] {
  const byName = new Map<string, DiscoveredSkillReference>();
  for (const command of pi.getCommands()) {
    const discovered = discoveredSkill(command);
    if (discovered && !byName.has(discovered.name)) byName.set(discovered.name, discovered);
  }
  return Object.freeze([...byName.values()].sort((left, right) => left.name.localeCompare(right.name)));
}

export async function captureSkills(
  pi: Pick<ExtensionAPI, "getCommands">, selectedNames: readonly string[],
): Promise<ValidationResult<LoadedPrivateSkills>> {
  return asLoaded(await captureSelectedSkills(selectedNames, discoverSkills(pi)));
}

export function createSkillPort(pi: Pick<ExtensionAPI, "getCommands">): PlanControllerSkillPort {
  return {
    async reload(references: readonly SkillReference[]): Promise<ValidationResult<LoadedPrivateSkills>> {
      return asLoaded(await reloadSavedSkills(references, discoverSkills(pi)));
    },
    async refresh(selectedNames: readonly string[], discovered: readonly unknown[]): Promise<ValidationResult<LoadedPrivateSkills>> {
      const safeDiscovery = discovered.every(isDiscoveredSkill) ? discovered : discoverSkills(pi);
      return asLoaded(await captureSelectedSkills(selectedNames, safeDiscovery as readonly DiscoveredSkillReference[]));
    },
  };
}

export function createAppendLocator(pi: Pick<ExtensionAPI, "appendEntry">): AppendPlanBranchLocator {
  return (locator) => pi.appendEntry(PLAN_LOCATOR_CUSTOM_TYPE, locator);
}

export function safeRuntimeId(): string { return randomUUID().replaceAll("-", ""); }
export function safeNonce(): string { return randomBytes(24).toString("base64url"); }

export function skillBlocks(loaded: LoadedPrivateSkills): readonly string[] {
  return Object.freeze(loaded.contexts.map((context, index) => {
    const reference = loaded.references[index];
    return [
      `<skill name="${escapeXml(context.name)}" baseDir="${escapeXml(reference?.baseDir ?? "")}">`,
      context.body.trim(),
      "</skill>",
    ].join("\n");
  }));
}

function discoveredSkill(command: SlashCommandInfo): DiscoveredSkillReference | undefined {
  if (command.source !== "skill" || !command.sourceInfo.path) return undefined;
  return {
    name: command.name.replace(/^skill:/, ""),
    path: command.sourceInfo.path,
    baseDir: command.sourceInfo.baseDir ?? dirname(command.sourceInfo.path),
  };
}

function asLoaded(result: Awaited<ReturnType<typeof captureSelectedSkills>>): ValidationResult<LoadedPrivateSkills> {
  if (!result.ok) return {
    ok: false,
    issues: result.issues.map((issue) => ({ path: "$.skills", code: issue.code, message: "Selected skill context is unavailable or changed." })),
  };
  return {
    ok: true,
    value: Object.freeze({
      references: result.references,
      contexts: Object.freeze(result.contexts.map((context) => Object.freeze({ name: context.name, body: context.body }))),
    }),
  };
}

function isDiscoveredSkill(value: unknown): value is DiscoveredSkillReference {
  return Boolean(value && typeof value === "object" && "name" in value && "path" in value && "baseDir" in value
    && typeof value.name === "string" && typeof value.path === "string" && typeof value.baseDir === "string");
}
function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
