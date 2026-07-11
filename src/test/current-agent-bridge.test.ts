import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentEndEvent, BeforeAgentStartEvent, ExtensionAPI, InputEvent, ToolCallEvent, ToolInfo, ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { CurrentAgentPlanBridge, PLAN_MARKER_PREFIX, type CurrentAgentActivityUpdate } from "../extension/current-agent-bridge.js";
import type { PlanGeneratorInput } from "../plan/generator.js";
import type { PlanSession } from "../plan/types.js";
import { TEAMS_PROGRESS_CHANNEL, TEAMS_REPORT_CHANNEL } from "../extension/teams-planning-adapter.js";

const taskBody = "Scope: src/a.ts\nTest first: Add a failing test.\nImplement: Make the change.\nVerify: Run the test.\nDone when: The test passes.";
const initialResult = { kind: "plan", document: { title: { kind: "title", body: "Plan", children: [] }, elements: [
  { kind: "execution", body: "Normal", children: [] },
  { kind: "milestone", title: "Implementation Tasks", body: "Tasks", children: [{ kind: "step", title: "Build", body: taskBody, children: [] }] },
] } };
const sourceInfo = { path: "/packages/pi-extended-teams/extensions/index.ts", source: "npm:pi-extended-teams@2.0.0", scope: "user" as const, origin: "package" as const };
const spawnTool = { name: "spawn_agent", description: "spawn", sourceInfo, parameters: { type: "object", required: ["prompt", "model_slot"], properties: {
  prompt: { type: "string" }, model_slot: { type: "string", enum: ["writing-basic", "writing-hard"] }, name: { type: "string" }, cwd: { type: "string" }, metadata: { type: "object" },
} } } as ToolInfo;
function initialSession(): PlanSession {
  return { schemaVersion: 1, id: "session", stateVersion: 2, documentRevision: 0, status: "generating", source: { prompt: "Build it", cwd: "/repo", skills: [] }, execution: { kind: "normal" }, generation: { mode: "normal" }, document: null, annotations: [], generationJob: { jobId: "job", operation: "initial", baseDocumentRevision: 0, selectedAnnotationIds: [], startedAt: "2026-07-11T00:00:00.000Z" } };
}
function input(signal = new AbortController().signal): PlanGeneratorInput {
  const session = initialSession();
  return { session, jobId: "job", operation: "initial", selectedAnnotationIds: [], loadSkills: async () => ({ ok: true, value: [{ name: "private-skill", body: "PRIVATE SKILL BODY THAT MUST STAY PRIVATE" }] }), signal };
}
function revisionInput(signal = new AbortController().signal): PlanGeneratorInput {
  const session = {
    ...initialSession(), stateVersion: 4, documentRevision: 1, status: "revising" as const,
    document: { id: "document", title: { id: "title", kind: "title" as const, body: "Plan", children: [] }, elements: [{ id: "execution", kind: "execution" as const, body: "Normal", children: [] }] },
    annotations: [{ id: "note-1", target: { kind: "element" as const, elementId: "execution" }, targetSnapshot: { documentRevision: 1, target: { kind: "element" as const, elementId: "execution" }, elementKind: "execution" as const, text: "Normal" }, body: "Change only this", status: "open" as const, history: [], createdAgainstRevision: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }],
    generationJob: { jobId: "revision-job", operation: "revision" as const, baseDocumentRevision: 1, selectedAnnotationIds: ["note-1"], startedAt: "2026-07-11T00:00:00.000Z" },
  } as PlanSession;
  return { session, jobId: "revision-job", operation: "revision", selectedAnnotationIds: ["note-1"], loadSkills: async () => ({ ok: true, value: [] }), signal };
}
function harness(options: { teams?: boolean; idle?: boolean; clock?: () => Date } = {}) {
  const handlers = new Map<string, Function>();
  const reportHandlers = new Set<(payload: unknown) => void>();
  const progressHandlers = new Set<(payload: unknown) => void>();
  const activities: CurrentAgentActivityUpdate[] = [];
  let tool: any;
  const pi = {
    registerTool: vi.fn((value) => { tool = value; }), sendUserMessage: vi.fn(), sendMessage: vi.fn(),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
    getActiveTools: vi.fn(() => options.teams ? ["spawn_agent", "spawn_swarm_agents"] : ["read", "bash"]),
    getAllTools: vi.fn(() => options.teams ? [spawnTool] : []),
    events: {
      emit: vi.fn((channel: string, payload: unknown) => {
        const handlers = channel === TEAMS_REPORT_CHANNEL ? reportHandlers : channel === TEAMS_PROGRESS_CHANNEL ? progressHandlers : [];
        for (const handler of [...handlers]) handler(payload);
      }),
      on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        const handlers = channel === TEAMS_REPORT_CHANNEL ? reportHandlers : progressHandlers;
        handlers.add(handler);
        return () => handlers.delete(handler);
      }),
    },
  } as unknown as ExtensionAPI;
  const planRoot = mkdtempSync(join(tmpdir(), "pi-prompt-bridge-"));
  const bridge = new CurrentAgentPlanBridge(pi, {
    nonceFactory: () => "nonce_1234567890_safe", primaryNameFactory: () => "planner-private123", correlationFactory: () => "correlation-private123",
    loadLevel: async () => "# Level\nInspect repository evidence carefully.", clock: options.clock, planRoot,
  });
  const generator = bridge.createGenerator(() => options.idle ?? true, (activity) => activities.push(activity));
  return { pi, bridge, generator, handlers, activities, reportHandlers, progressHandlers, planRoot, get tool() { return tool; } };
}
const before = (prompt: string): BeforeAgentStartEvent => ({ type: "before_agent_start", prompt, systemPrompt: "system", systemPromptOptions: {} as never });
const inputEvent = (text: string, source: "interactive" | "extension" = "extension"): InputEvent => ({ type: "input", text, source });
const endEvent = { type: "agent_end", messages: [] } as AgentEndEvent;
const toolCall = (toolName: string, input: Record<string, unknown> = {}): ToolCallEvent => ({ type: "tool_call", toolCallId: `${toolName}-call`, toolName, input }) as ToolCallEvent;
const spawnResult = (name = "planner-private123", isError = false): ToolResultEvent => ({ type: "tool_result", toolCallId: "spawn_agent-call", toolName: "spawn_agent", input: {}, content: [], details: { name, session: "private" }, isError }) as ToolResultEvent;
function startInjected(h: ReturnType<typeof harness>, index: number) {
  const message = vi.mocked(h.pi.sendMessage).mock.calls[index]![0] as Record<string, unknown>;
  h.handlers.get("message_start")!({ type: "message_start", message: { role: "custom", ...message, timestamp: Date.now() } });
  return message.content as string;
}
async function dispatched(teams = false, idle = true, generationInput: PlanGeneratorInput = input()) {
  const h = harness({ teams, idle });
  const completion = h.generator.generate(generationInput);
  expect(h.generator.dispatch(generationInput.jobId)).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1));
  return { ...h, completion, marker: vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string };
}
function begin(h: Awaited<ReturnType<typeof dispatched>>, marker = h.marker) {
  h.handlers.get("input")!(inputEvent(marker));
  return h.handlers.get("before_agent_start")!(before(marker));
}
function savePlan(h: ReturnType<typeof harness>, markdown = `# Plan\n\n## Execution\nNormal\n\n## Implementation Tasks\nTasks\n\n### Build\n${taskBody}\n`) {
  const directory = join(h.planRoot, "session");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "plan.md"), markdown, { mode: 0o600 });
}
function spawnPrimary(h: Awaited<ReturnType<typeof dispatched>>) {
  const event = toolCall("spawn_agent", { prompt: "attacker", model_slot: "reading-hard", metadata: { nonce: "leak" } });
  expect(h.handlers.get("tool_call")!(event)).toBeUndefined();
  h.handlers.get("tool_result")!(spawnResult());
  return event.input;
}

describe("current-agent planning bridge", () => {
  it.each([[true, undefined], [false, { deliverAs: "followUp" }]] as const)("uses direct fallback only when teams are unavailable and dispatches with idle=%s", async (idle, delivery) => {
    const h = await dispatched(false, idle);
    expect(h.marker).toBe(`${PLAN_MARKER_PREFIX}nonce_1234567890_safe:dispatch:1]]`);
    expect(vi.mocked(h.pi.sendUserMessage).mock.calls[0]).toEqual(delivery ? [h.marker, delivery] : [h.marker]);
    const injected = begin(h);
    expect(injected.message.content).toContain("Submission nonce: nonce_1234567890_safe");
    expect(injected.message.content).toContain("Original request:\nBuild it");
    expect(h.activities[0]).toMatchObject({ phase: "direct-fallback", adapter: "direct", primaryCount: 0, primaryStatus: "direct" });
    expect(h.handlers.get("tool_call")!(toolCall("read"))).toBeUndefined();
    await h.generator.close(); await h.completion;
  });

  it("requires exact extension marker correlation", async () => {
    const h = await dispatched();
    expect(h.handlers.get("before_agent_start")!(before(h.marker))).toBeUndefined();
    h.handlers.get("input")!(inputEvent(h.marker, "interactive"));
    expect(h.handlers.get("before_agent_start")!(before(h.marker))).toBeUndefined();
    h.handlers.get("input")!(inputEvent(`${h.marker}x`));
    expect(h.handlers.get("before_agent_start")!(before(h.marker))).toBeUndefined();
    expect(begin(h).message.content).toContain("Submission nonce");
    await h.generator.close(); await h.completion;
  });

  it("uses the selected writer slot without blocking any main-agent tool", async () => {
    const h = await dispatched(true);
    const orchestration = begin(h).message.content;
    expect(orchestration).toContain("orchestration-only");
    expect(orchestration).not.toContain("PRIVATE SKILL BODY");
    for (const name of ["read", "bash", "grep", "find", "ls", "web_search", "code_search", "edit", "write", "spawn_swarm_agents", "mystery_custom"]) {
      expect(h.handlers.get("tool_call")!(toolCall(name)), name).toBeUndefined();
    }
    const canonical = spawnPrimary(h) as Record<string, any>;
    expect(canonical).toMatchObject({ name: "planner-private123", cwd: "/repo", model_slot: "writing-basic" });
    expect(canonical.prompt).toContain("one plan writer");
    expect(canonical.prompt).toContain("Original request:\nBuild it");
    expect(canonical.prompt).toContain("PRIVATE SKILL BODY THAT MUST STAY PRIVATE");
    expect(canonical.prompt).toContain("modify any file except the exact plan.md path");
    expect(canonical.prompt).toContain("helpers and swarms are unsupported");
    expect(JSON.stringify(canonical.metadata)).not.toContain("nonce_1234567890_safe");
    expect(JSON.stringify(canonical.metadata)).not.toContain("PRIVATE SKILL");
    expect(h.handlers.get("tool_call")!(toolCall("spawn_agent"))).toBeUndefined();
    const message = toolCall("send_message", { recipient: "another-agent", content: "Keep this untouched." });
    expect(h.handlers.get("tool_call")!(message)).toBeUndefined();
    expect(message.input).toEqual({ recipient: "another-agent", content: "Keep this untouched." });
    await h.generator.close(); await h.completion;
  });

  it("gives revision writers only the plan path, notes, and preserve-in-place instructions", async () => {
    const h = await dispatched(true, true, revisionInput());
    begin(h);
    const canonical = spawnPrimary(h) as Record<string, unknown>;
    const mission = String(canonical.prompt);
    expect(mission).toContain("revising the existing plan, not creating a new plan");
    expect(mission).toContain(`${h.planRoot}/session/plan.md`);
    expect(mission).toContain(`${h.planRoot}/session/annotations.json`);
    expect(mission).toContain("Change only this");
    expect(mission).toContain("Preserve every unmentioned section");
    expect(mission).not.toContain("Original request:");
    await h.generator.close(); await h.completion;
  });

  it("materializes plan.md as soon as the writer saves it without waiting for a report", async () => {
    const h = await dispatched(true); begin(h); spawnPrimary(h);
    h.handlers.get("agent_end")!(endEvent);
    expect(await Promise.race([h.completion.then(() => "settled"), Promise.resolve("pending")])).toBe("pending");
    const progressAt = Date.now() + 1_000;
    h.pi.events.emit(TEAMS_PROGRESS_CHANNEL, { teamName: "wrong", name: "planner-private123", status: "WRONG TEAM", updatedAt: progressAt });
    h.pi.events.emit(TEAMS_PROGRESS_CHANNEL, { teamName: "private", name: "wrong", status: "WRONG AGENT", updatedAt: progressAt });
    h.pi.events.emit(TEAMS_PROGRESS_CHANNEL, { teamName: "private", name: "planner-private123", status: "STALE", updatedAt: 1 });
    h.pi.events.emit(TEAMS_PROGRESS_CHANNEL, { teamName: "private", name: "planner-private123", status: "  Reviewing\n focused   tests  ", updatedAt: progressAt, model: "PRIVATE MODEL", prompt: "PRIVATE PROMPT", nonce: "PRIVATE NONCE" });
    expect(h.activities.at(-1)).toMatchObject({ phase: "waiting-report", progress: { summary: "Reviewing focused tests", updatedAt: new Date(progressAt).toISOString() } });
    expect(JSON.stringify(h.activities.at(-1))).not.toContain("PRIVATE");
    h.pi.events.emit(TEAMS_REPORT_CHANNEL, { name: "wrong", ok: true, report: "WRONG REPORT" });
    savePlan(h);
    await expect(h.completion).resolves.toEqual({ ok: true, outcome: initialResult });
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(0);
    expect(h.activities.map((value) => value.phase)).toEqual(expect.arrayContaining(["capability-detected", "primary-starting", "primary-active", "waiting-report", "completed"]));
  });

  it("starts one private correction directly and stops instead of looping when it is still invalid", async () => {
    const h = await dispatched(true); begin(h); spawnPrimary(h); h.handlers.get("agent_end")!(endEvent);
    const firstInvalid = "Submitted the complete plan to the lead.";
    h.pi.events.emit(TEAMS_REPORT_CHANNEL, { name: "planner-private123", ok: true, report: firstInvalid });
    expect(h.activities.at(-1)?.phase).toBe("recovering");
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(startInjected(h, 0)).toContain("saved Markdown plan");
    const retry = toolCall("spawn_agent");
    expect(h.handlers.get("tool_call")!(retry)).toBeUndefined();
    expect(String((retry.input as Record<string, unknown>).prompt)).toContain("writer must report exactly");
    expect(String((retry.input as Record<string, unknown>).prompt)).toContain("plan.md");
    h.handlers.get("tool_result")!(spawnResult()); h.handlers.get("agent_end")!(endEvent);

    savePlan(h, "# Wrong\n\n## Implementation Tasks\nTasks\n\n### Build\nScope: src/a.ts\nTest first: Add test\nImplement: Build\nVerify: Test\nDone when: Done\n");
    h.pi.events.emit(TEAMS_REPORT_CHANNEL, { name: "planner-private123", ok: true, report: "plan saved" });
    await expect(h.completion).resolves.toMatchObject({ ok: false, error: { code: "invalid-plan-file" } });
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("returns actionable validation feedback to a direct planner and permits correction in the same run", async () => {
    const h = await dispatched(false); begin(h);
    const invalid = await h.tool.execute("bad", { nonce: "nonce_1234567890_safe", result: { kind: "plan", document: { title: "Wrong", elements: [] } } });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("$.document.title");
    expect((await h.tool.execute("good", { nonce: "nonce_1234567890_safe", result: initialResult })).isError).toBeUndefined();
    await expect(h.completion).resolves.toMatchObject({ ok: true });
  });

  it("preserves direct missing-submission behavior without treating unrelated queued agent_end as correlated", async () => {
    const h = await dispatched(); h.handlers.get("input")!(inputEvent(h.marker));
    h.handlers.get("agent_end")!(endEvent);
    expect(await Promise.race([h.completion.then(() => "settled"), Promise.resolve("pending")])).toBe("pending");
    h.handlers.get("before_agent_start")!(before(h.marker)); h.handlers.get("agent_end")!(endEvent);
    await expect(h.completion).resolves.toMatchObject({ ok: false, error: { code: "missing-plan-submission" } });
  });

  it("close rejects late reports and submissions and removes report observation", async () => {
    const controller = new AbortController(); const h = harness({ teams: true }); const completion = h.generator.generate(input(controller.signal));
    h.generator.dispatch("job"); await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1));
    const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string;
    h.handlers.get("input")!(inputEvent(marker)); h.handlers.get("before_agent_start")!(before(marker)); spawnPrimary({ ...h, completion, marker } as never);
    expect(h.reportHandlers.size).toBe(1);
    expect(h.progressHandlers.size).toBe(1);
    controller.abort();
    await expect(completion).resolves.toMatchObject({ ok: false, error: { code: "generation-cancelled" } });
    expect(h.reportHandlers.size).toBe(0);
    expect(h.progressHandlers.size).toBe(0);
    h.pi.events.emit(TEAMS_REPORT_CHANNEL, { name: "planner-private123", ok: true, report: "LATE" });
    expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect((await h.tool.execute("late", { nonce: "nonce_1234567890_safe", result: initialResult })).isError).toBe(true);
  });
});
