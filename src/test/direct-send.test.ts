import { describe, expect, it, vi } from "vitest";
import { buildDirectSendMessage, dispatchDirectSend } from "../prompt-editor/direct-send.js";

const skill = "<skill name=\"test-expert\">private instructions</skill>";

describe("direct send", () => {
  it("keeps the controlled command first, then skill blocks, with exactly one prefix", () => {
    expect(buildDirectSendMessage({ text: "/goal /goal Build it", execution: { kind: "normal" }, skillBlocks: [skill] })).toEqual({
      ok: true,
      value: ["/goal " + skill, "", "User prompt:", "Build it"].join("\n"),
    });
  });

  it("keeps an arbitrary slash command first and stages it", () => {
    const setEditorText = vi.fn();
    const sendUserMessage = vi.fn();
    const result = dispatchDirectSend({ setEditorText, sendUserMessage, isIdle: () => true }, {
      text: "/skill:review Fix it", execution: { kind: "normal" }, skillBlocks: [skill],
    });
    expect(result).toEqual({ ok: true, value: "staged" });
    expect(setEditorText).toHaveBeenCalledWith(["/skill:review " + skill, "", "User prompt:", "Fix it"].join("\n"));
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("uses public sendUserMessage for an idle plain message", () => {
    const sendUserMessage = vi.fn();
    const setEditorText = vi.fn();
    expect(dispatchDirectSend({ sendUserMessage, setEditorText, isIdle: () => true }, {
      text: "Plain request", execution: { kind: "normal" },
    })).toEqual({ ok: true, value: "sent" });
    expect(sendUserMessage).toHaveBeenCalledWith("Plain request");
    expect(setEditorText).not.toHaveBeenCalled();
  });

  it("queues a plain message as followUp while busy", () => {
    const sendUserMessage = vi.fn();
    dispatchDirectSend({ sendUserMessage, setEditorText: vi.fn(), isIdle: () => false }, {
      text: "Plain request", execution: { kind: "normal" },
    });
    expect(sendUserMessage).toHaveBeenCalledWith("Plain request", { deliverAs: "followUp" });
  });

  it("stages goal and loop without dispatching or using a private TUI handleInput", () => {
    for (const kind of ["goal", "loop"] as const) {
      const sendUserMessage = vi.fn();
      const setEditorText = vi.fn();
      dispatchDirectSend({ sendUserMessage, setEditorText, isIdle: () => true }, {
        text: `/${kind} Build it`, execution: { kind }, skillBlocks: [skill],
      });
      const staged = setEditorText.mock.calls[0]?.[0] as string;
      expect(staged.startsWith(`/${kind} `)).toBe(true);
      expect(staged.match(new RegExp(`/${kind}`, "g"))).toHaveLength(1);
      expect(staged.indexOf(skill)).toBeGreaterThan(0);
      expect(sendUserMessage).not.toHaveBeenCalled();
    }
  });

  it("deduplicates controlled prefixes while preserving non-token slash commands", () => {
    expect(buildDirectSendMessage({ text: "/goal /goal Build", execution: { kind: "normal" } })).toEqual({ ok: true, value: "/goal Build" });
    expect(buildDirectSendMessage({ text: "/create-goal Build", execution: { kind: "normal" } })).toEqual({ ok: true, value: "/create-goal Build" });
    expect(buildDirectSendMessage({ text: "/create-goalie Build", execution: { kind: "normal" } })).toEqual({ ok: true, value: "/create-goalie Build" });
  });

  it("rejects conflicting controlled prefixes", () => {
    expect(buildDirectSendMessage({ text: "/loop Build", execution: { kind: "goal" } })).toMatchObject({ ok: false });
    expect(buildDirectSendMessage({ text: "/goal /loop Build", execution: { kind: "normal" } })).toMatchObject({ ok: false });
  });
});
