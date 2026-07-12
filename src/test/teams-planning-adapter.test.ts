import { describe, expect, it, vi } from "vitest";
import type { ToolCallEvent, ToolInfo, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  TeamsPlanningAdapter, detectTeamsPlanningCapability,
} from "../extension/teams-planning-adapter.js";

const sourceInfo = {
  path: "/packages/pi-extended-teams/extensions/index.ts",
  source: "../../Poetry/pi-extended-teams",
  scope: "user" as const,
  origin: "package" as const,
};
const parameters = {
  type: "object",
  required: ["prompt", "model_slot"],
  properties: {
    name: { type: "string" }, prompt: { type: "string" }, cwd: { type: "string" },
    metadata: { type: "object" }, model_slot: { type: "string", enum: ["writing-basic", "writing-hard"] },
  },
};
function tool(overrides: Partial<ToolInfo> = {}): ToolInfo {
  return { name: "spawn_agent", description: "spawn", parameters, sourceInfo, ...overrides } as ToolInfo;
}
function catalog(active = ["spawn_agent"], tools = [tool()]) {
  return { getActiveTools: () => active, getAllTools: () => tools };
}
function call(toolName: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: "tool_call", toolCallId: `${toolName}-call`, toolName, input } as ToolCallEvent;
}
function result(isError = false): ToolResultEvent {
  return { type: "tool_result", toolCallId: "spawn_agent-call", toolName: "spawn_agent", input: {}, content: [], isError, details: { name: "planner-private", session: "private-session" } } as ToolResultEvent;
}

describe("pi-extended-teams planning adapter", () => {
  it("detects only an active spawn_agent with the required schema and canonical package provenance", () => {
    expect(detectTeamsPlanningCapability(catalog(), "writing-basic")).toBe(true);
    expect(detectTeamsPlanningCapability(catalog(), "writing-hard")).toBe(true);
    expect(detectTeamsPlanningCapability(catalog([]))).toBe(false);
    expect(detectTeamsPlanningCapability(catalog(["spawn_agent"], [tool({ parameters: { type: "object", properties: { prompt: { type: "string" } } } as never })]))).toBe(false);
    expect(detectTeamsPlanningCapability(catalog(["spawn_agent"], [tool({ sourceInfo: { ...sourceInfo, source: "evil-extension", path: "/evil/index.ts" } })]))).toBe(false);
    expect(detectTeamsPlanningCapability(catalog(["spawn_agent"], [tool({ name: "other_spawn" })]))).toBe(false);
  });

  it("canonicalizes the first private writer without blocking any main-agent tool", () => {
    const phases: string[] = [];
    const adapter = new TeamsPlanningAdapter({
      primaryName: "planner-private", correlation: "correlation-private", cwd: "/repo", mission: "WRITE PLAN MISSION", modelSlot: "writing-basic",
      onPhase: (phase) => phases.push(phase), onReport: vi.fn(), onProgress: vi.fn(),
    });
    const first = call("spawn_agent", { prompt: "attacker", model_slot: "writing-hard", name: "public", cwd: "/tmp", metadata: { nonce: "leak" }, extra: true });
    expect(adapter.handleToolCall(first)).toBeUndefined();
    expect(first.input).toEqual({
      prompt: "WRITE PLAN MISSION", model_slot: "writing-basic", name: "planner-private", cwd: "/repo",
      metadata: { piPromptPlanning: { version: 1, correlation: "correlation-private" } },
    });
    expect(adapter.primaryCount).toBe(1);
    for (const name of ["spawn_agent", "spawn_swarm_agents", "read", "bash", "grep", "find", "ls", "web_search", "code_search", "edit", "write", "mystery_custom", "send_message", "pi_prompt_submit_plan"]) {
      expect(adapter.handleToolCall(call(name)), name).toBeUndefined();
    }
    adapter.handleToolResult(result());
    expect(adapter.primaryStatus).toBe("waiting");
    const message = call("send_message", { recipient: "another-agent", content: "Keep this untouched." });
    expect(adapter.handleToolCall(message)).toBeUndefined();
    expect(message.input).toEqual({ recipient: "another-agent", content: "Keep this untouched." });
    expect(phases).toEqual(["primary-starting", "primary-active", "waiting-report"]);
  });

  it("reports only sanitized resolved model metadata for the selected slot", () => {
    const models = vi.fn();
    const adapter = new TeamsPlanningAdapter({
      primaryName: "planner-private", correlation: "correlation-private", cwd: "/repo", mission: "mission", modelSlot: "writing-basic",
      onPhase: vi.fn(), onReport: vi.fn(), onProgress: vi.fn(), onModel: models,
    });
    adapter.handleToolCall(call("spawn_agent"));
    adapter.handleToolResult({ ...result(), details: { name: "planner-private", session: "private-session", modelSlot: "writing-basic", model: "openai/gpt-planner", thinking: "high", secret: "PRIVATE" } } as ToolResultEvent);
    expect(models).toHaveBeenCalledWith({ slot: "writing-basic", model: "openai/gpt-planner", thinking: "high" });
    expect(JSON.stringify(models.mock.calls)).not.toContain("PRIVATE");
  });

  it("accepts only fresh normalized progress for the exact primary and private team, then rejects stale and late events", () => {
    const progress = vi.fn();
    const adapter = new TeamsPlanningAdapter({
      primaryName: "planner-private", correlation: "correlation-private", cwd: "/repo", mission: "mission", modelSlot: "writing-basic",
      onPhase: vi.fn(), onReport: vi.fn(), onProgress: progress,
    });
    adapter.handleToolCall(call("spawn_agent")); adapter.handleToolResult(result());
    const fresh = Date.now() + 1_000;
    expect(adapter.handleProgress({ teamName: "wrong-team", name: "planner-private", status: "WRONG TEAM", updatedAt: fresh })).toBe(false);
    expect(adapter.handleProgress({ teamName: "private-session", name: "wrong", status: "WRONG AGENT", updatedAt: fresh })).toBe(false);
    expect(adapter.handleProgress({ teamName: "private-session", name: "planner-private", status: "STALE", updatedAt: 1 })).toBe(false);
    expect(adapter.handleProgress({ teamName: "private-session", name: "planner-private", status: `  ${"x".repeat(130)}\nignored  `, updatedAt: fresh })).toBe(true);
    expect(progress).toHaveBeenLastCalledWith("x".repeat(120), fresh);
    expect(adapter.handleProgress({ teamName: "private-session", name: "planner-private", status: "DUPLICATE", updatedAt: fresh })).toBe(false);
    adapter.close();
    expect(adapter.handleProgress({ teamName: "private-session", name: "planner-private", status: "LATE", updatedAt: fresh + 1 })).toBe(false);
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it("accepts only the expected successful report and closes observation against late events", () => {
    const reports: string[] = [];
    const adapter = new TeamsPlanningAdapter({
      primaryName: "planner-private", correlation: "correlation-private", cwd: "/repo", mission: "mission", modelSlot: "writing-hard",
      onPhase: vi.fn(), onReport: (report) => reports.push(report), onProgress: vi.fn(),
    });
    adapter.handleToolCall(call("spawn_agent")); adapter.handleToolResult(result());
    expect(adapter.handleReport({ teamName: "private-session", name: "wrong", ok: true, report: "WRONG" })).toBe(false);
    expect(adapter.handleReport({ teamName: "wrong-session", name: "planner-private", ok: true, report: "WRONG TEAM" })).toBe(false);
    expect(adapter.handleReport({ teamName: "private-session", name: "planner-private", ok: true, report: "EXTRA METADATA", metadata: { piPromptPlanning: { version: 1, correlation: "correlation-private", attemptId: "must-not-be-public" } } })).toBe(false);
    expect(adapter.handleReport({ teamName: "private-session", name: "planner-private", ok: true, report: "EXPECTED REPORT", metadata: { piPromptPlanning: { version: 1, correlation: "correlation-private" } } })).toBe(true);
    expect(adapter.handleReport({ teamName: "private-session", name: "planner-private", ok: true, report: "DUPLICATE" })).toBe(false);
    expect(reports).toEqual(["EXPECTED REPORT"]);
    expect(adapter.handleFollowUp({ role: "custom", customType: "pi-extended-teams-report", content: "WRONG", details: { name: "planner-private", teamName: "private-session" } })).toBe(false);
    expect(adapter.handleFollowUp({ role: "custom", customType: "pi-extended-teams-report", content: "EXPECTED REPORT", details: { name: "wrong", teamName: "private-session" } })).toBe(false);
    expect(adapter.handleFollowUp({ role: "custom", customType: "pi-extended-teams-report", content: "EXPECTED REPORT", details: { name: "planner-private", teamName: "private-session" } })).toBe(true);
    expect(adapter.handleFollowUp({ role: "custom", customType: "pi-extended-teams-report", content: "EXPECTED REPORT", details: { name: "planner-private", teamName: "private-session" } })).toBe(false);
    expect(adapter.prepareRetry("CORRECTION MISSION")).toBe(true);
    const retry = call("spawn_agent", { prompt: "wrong", model_slot: "writing-hard" });
    expect(adapter.handleToolCall(retry)).toBeUndefined();
    expect(retry.input).toMatchObject({ prompt: "CORRECTION MISSION", model_slot: "writing-hard", name: "planner-private" });
    expect(adapter.primaryCount).toBe(1);
    adapter.handleToolResult(result());
    expect(adapter.handleReport({ teamName: "private-session", name: "planner-private", ok: true, report: "SECOND REPORT", metadata: { piPromptPlanning: { version: 1, correlation: "wrong" } } })).toBe(false);
    expect(adapter.handleReport({ teamName: "private-session", name: "planner-private", ok: true, report: "SECOND REPORT", metadata: { piPromptPlanning: { version: 1, correlation: "correlation-private" } } })).toBe(true);
    expect(adapter.handleFollowUp({ role: "custom", customType: "pi-extended-teams-report", content: "SECOND REPORT", details: { name: "planner-private", teamName: "private-session" } })).toBe(true);
    adapter.close();
    expect(adapter.handleReport({ teamName: "private-session", name: "planner-private", ok: true, report: "LATE" })).toBe(false);
  });
});
