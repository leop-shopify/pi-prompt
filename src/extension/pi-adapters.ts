import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes, randomUUID } from "node:crypto";
import { PLAN_LOCATOR_CUSTOM_TYPE, type AppendPlanBranchLocator } from "../plan/locator.js";

export function createAppendLocator(pi: Pick<ExtensionAPI, "appendEntry">): AppendPlanBranchLocator {
  return (locator) => pi.appendEntry(PLAN_LOCATOR_CUSTOM_TYPE, locator);
}

export function safeRuntimeId(): string { return randomUUID().replaceAll("-", ""); }
export function safeNonce(): string { return randomBytes(24).toString("base64url"); }
