import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EXECUTION_LEADERSHIP_BOOTSTRAP, normalizeExecutionInput } from "../plan/classification.js";
import type { ExecutionKind, ValidationResult } from "../plan/types.js";

export interface DirectSendInput {
  readonly text: string;
  readonly execution: ExecutionKind;
  readonly skillBlocks?: readonly string[];
}

export interface DirectSendPort {
  readonly sendUserMessage: ExtensionAPI["sendUserMessage"];
  readonly setEditorText: ExtensionContext["ui"]["setEditorText"];
  readonly isIdle: ExtensionContext["isIdle"];
  readonly notify?: ExtensionContext["ui"]["notify"];
}

export function buildDirectSendMessage(input: DirectSendInput): ValidationResult<string> {
  const normalized = normalizeExecutionInput(input.text, input.execution);
  if (!normalized.ok) return normalized;
  const prompt = normalized.value.promptText.trim();
  const skillBlocks = (input.skillBlocks ?? []).map((block) => block.trim()).filter(Boolean);
  const blocks = normalized.value.execution.kind === "create-goal"
    ? [EXECUTION_LEADERSHIP_BOOTSTRAP, ...skillBlocks]
    : skillBlocks;
  const slash = normalized.value.execution.kind === "normal" ? splitLeadingSlashCommand(prompt) : null;
  const promptBody = slash?.rest ?? prompt;
  const body = blocks.length === 0 ? promptBody : [blocks.join("\n\n"), "", "User prompt:", promptBody].join("\n");
  const message = normalized.value.execution.kind !== "normal"
    ? `/${normalized.value.execution.kind} ${stripControlledPrefixes(body)}`
    : slash ? `${slash.command} ${body}`.trimEnd() : body;
  return { ok: true, value: message.trimEnd() };
}

/** Direct send is invoked by No plan's primary action or the explicit send-without-plan action. */
export function dispatchDirectSend(port: DirectSendPort, input: DirectSendInput): ValidationResult<"sent" | "staged"> {
  const built = buildDirectSendMessage(input);
  if (!built.ok) return built;
  const message = built.value;
  if (message.trimStart().startsWith("/") || input.execution.kind !== "normal") {
    port.setEditorText(message);
    port.notify?.("Slash-leading prompt staged in the input. Press Enter to run it.", "warning");
    return { ok: true, value: "staged" };
  }
  if (port.isIdle()) port.sendUserMessage(message);
  else {
    port.sendUserMessage(message, { deliverAs: "followUp" });
    port.notify?.("Agent is busy — prompt queued as follow-up", "info");
  }
  return { ok: true, value: "sent" };
}

function splitLeadingSlashCommand(value: string): { readonly command: string; readonly rest: string } | null {
  const match = value.match(/^\s*(\/\S+)(?=$|\s)/);
  if (!match) return null;
  return { command: match[1]!, rest: value.slice(match[0].length).trimStart() };
}

function stripControlledPrefixes(value: string): string {
  let output = value;
  while (true) {
    const match = output.match(/^\s*\/(?:goal|loop|create-goal)(?=$|\s)/);
    if (!match) return output.trimStart();
    output = output.slice(match[0].length);
  }
}
