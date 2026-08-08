import { describe, expect, it, vi } from "vitest";
import { buildDirectSendMessage, dispatchDirectSend } from "../prompt-editor/direct-send.js";

describe("direct send", () => {
  it("preserves slash-leading input exactly and stages it", () => {
    const source = "/goal /loop Build it";
    const setEditorText = vi.fn();
    const sendUserMessage = vi.fn();
    expect(buildDirectSendMessage({ text: source })).toBe(source);
    expect(dispatchDirectSend({ setEditorText, sendUserMessage, isIdle: () => true }, { text: source })).toBe("staged");
    expect(setEditorText).toHaveBeenCalledWith(source);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("uses public sendUserMessage for an idle plain message", () => {
    const sendUserMessage = vi.fn();
    const setEditorText = vi.fn();
    expect(dispatchDirectSend({ sendUserMessage, setEditorText, isIdle: () => true }, { text: "Plain request" })).toBe("sent");
    expect(sendUserMessage).toHaveBeenCalledWith("Plain request");
    expect(setEditorText).not.toHaveBeenCalled();
  });

  it("queues a plain message as followUp while busy", () => {
    const sendUserMessage = vi.fn();
    expect(dispatchDirectSend({ sendUserMessage, setEditorText: vi.fn(), isIdle: () => false }, { text: "Plain request" })).toBe("sent");
    expect(sendUserMessage).toHaveBeenCalledWith("Plain request", { deliverAs: "followUp" });
  });

  it("trims trailing whitespace without rewriting prompt content", () => {
    expect(buildDirectSendMessage({ text: "  /custom-command Fix it  \n" })).toBe("  /custom-command Fix it");
  });
});
