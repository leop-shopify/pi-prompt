import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface DirectSendInput {
  readonly text: string;
}

export interface DirectSendPort {
  readonly sendUserMessage: ExtensionAPI["sendUserMessage"];
  readonly setEditorText: ExtensionContext["ui"]["setEditorText"];
  readonly isIdle: ExtensionContext["isIdle"];
  readonly notify?: ExtensionContext["ui"]["notify"];
}

export function buildDirectSendMessage(input: DirectSendInput): string {
  return input.text.trimEnd();
}

/** Direct send is invoked by No plan's primary action or the explicit send-without-plan action. */
export function dispatchDirectSend(port: DirectSendPort, input: DirectSendInput): "sent" | "staged" {
  const message = buildDirectSendMessage(input);
  if (message.trimStart().startsWith("/")) {
    port.setEditorText(message);
    port.notify?.("Slash-leading prompt staged in the input. Press Enter to run it.", "warning");
    return "staged";
  }
  if (port.isIdle()) port.sendUserMessage(message);
  else {
    port.sendUserMessage(message, { deliverAs: "followUp" });
    port.notify?.("Agent is busy — prompt queued as follow-up", "info");
  }
  return "sent";
}
