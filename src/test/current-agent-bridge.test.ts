import { describe, expect, it, vi } from "vitest";
import type {
  AgentEndEvent, BeforeAgentStartEvent, ExtensionAPI, InputEvent, ToolCallEvent, ToolInfo, ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { CurrentAgentPlanBridge, PLAN_MARKER_PREFIX, type CurrentAgentActivityUpdate } from "../extension/current-agent-bridge.js";
import type { PlanGeneratorInput, WriterSubmissionInput } from "../plan/generator.js";
import type { PlanSession } from "../plan/types.js";
import { TEAMS_REPORT_CHANNEL } from "../extension/teams-planning-adapter.js";

const endpoint = "http://127.0.0.1:43210/api/v1/writer-results";
const taskBody = "Scope: src/a.ts\nTest first: Add a failing test.\nImplement: Make the change.\nVerify: Run the test.\nDone when: The test passes.";
const markdown = `# Plan\r\n\r\n## Execution\r\nNormal\r\n\r\n## Implementation Tasks\r\nTasks\r\n\r\n### Build\r\n${taskBody.replaceAll("\n", "\r\n")}\r\n`;
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
function submission(attemptId: string, kind: "plan" | "clarification", body: Buffer): WriterSubmissionInput {
  return { sessionId: "session", jobId: "job", operation: "initial", baseDocumentRevision: 0, attemptId, kind, body };
}
function harness(options: { teams?: boolean; idle?: boolean } = {}) {
  const handlers = new Map<string, Function>(); const reportHandlers = new Set<(payload: unknown) => void>();
  const activities: CurrentAgentActivityUpdate[] = []; let tool: any; let attempt = 0;
  const pi = {
    registerTool: vi.fn((value) => { tool = value; }), sendUserMessage: vi.fn(), sendMessage: vi.fn(), on: vi.fn((name, handler) => handlers.set(name, handler)),
    getActiveTools: vi.fn(() => options.teams ? ["spawn_agent"] : ["read", "bash"]), getAllTools: vi.fn(() => options.teams ? [spawnTool] : []),
    events: { emit: vi.fn((channel: string, payload: unknown) => { if (channel === TEAMS_REPORT_CHANNEL) for (const handler of [...reportHandlers]) handler(payload); }), on: vi.fn((channel: string, handler: (payload: unknown) => void) => { if (channel === TEAMS_REPORT_CHANNEL) reportHandlers.add(handler); return () => reportHandlers.delete(handler); }) },
  } as unknown as ExtensionAPI;
  const bridge = new CurrentAgentPlanBridge(pi, {
    nonceFactory: () => "nonce_1234567890_safe", primaryNameFactory: () => "planner-private123", correlationFactory: () => "correlation-private123",
    attemptFactory: () => `attempt_identity_${String(++attempt).padStart(4, "0")}`, planRoot: "/private/plans",
  });
  const generator = bridge.createGenerator(() => options.idle ?? true, (activity) => activities.push(activity));
  return { pi, generator, handlers, reportHandlers, activities, get tool() { return tool; } };
}
const before = (prompt: string): BeforeAgentStartEvent => ({ type: "before_agent_start", prompt, systemPrompt: "system", systemPromptOptions: {} as never });
const inputEvent = (text: string): InputEvent => ({ type: "input", text, source: "extension" });
const toolCall = (): ToolCallEvent => ({ type: "tool_call", toolCallId: "spawn-call", toolName: "spawn_agent", input: {} }) as ToolCallEvent;
const spawnResult = (): ToolResultEvent => ({ type: "tool_result", toolCallId: "spawn-call", toolName: "spawn_agent", input: {}, content: [], details: { name: "planner-private123", session: "private" }, isError: false }) as ToolResultEvent;
const endEvent = { type: "agent_end", messages: [] } as AgentEndEvent;

async function dispatched(teams: boolean) {
  const h = harness({ teams });
  expect(h.generator.configureWriterEndpoint(endpoint)).toMatchObject({ ok: true });
  const completion = h.generator.generate(input());
  expect(h.generator.dispatch("job")).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1));
  const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string;
  h.handlers.get("input")!(inputEvent(marker)); const started = h.handlers.get("before_agent_start")!(before(marker));
  let mission = started.message.content as string; let spawnInput: Record<string, unknown> | undefined;
  if (teams) {
    const call = toolCall(); h.handlers.get("tool_call")!(call); h.handlers.get("tool_result")!(spawnResult()); spawnInput = call.input; mission = String(spawnInput.prompt);
  }
  return { ...h, completion, marker, mission, spawnInput };
}
function correctionMission(h: Awaited<ReturnType<typeof dispatched>>): string {
  const message = vi.mocked(h.pi.sendMessage).mock.calls[0]![0] as Record<string, unknown>;
  h.handlers.get("message_start")!({ message: { role: "custom", ...message } });
  const call = toolCall(); h.handlers.get("tool_call")!(call); h.handlers.get("tool_result")!(spawnResult());
  return String((call.input as Record<string, unknown>).prompt);
}

describe("current-agent authenticated writer handoff", () => {
  it("fails dispatch safely until the loopback writer endpoint is configured", async () => {
    const h = harness(); const completion = h.generator.generate(input());
    expect(h.generator.dispatch("job")).toMatchObject({ ok: false, error: { code: "writer-endpoint-unavailable" } });
    expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
    await h.generator.close(); await expect(completion).resolves.toMatchObject({ ok: false, error: { code: "generation-cancelled" } });
  });

  it.each([false, true])("gives delegated=%s writers only the private HTTP upload credential and keeps the browser capability absent", async (teams) => {
    const h = await dispatched(teams);
    expect(h.marker).toBe(`${PLAN_MARKER_PREFIX}nonce_1234567890_safe:dispatch:1]]`);
    expect(h.mission).toContain(endpoint); expect(h.mission).toContain("Authorization: Bearer attempt_identity_0001");
    expect(h.mission).toContain("--data-binary '@/private/plans/session/plan.md'");
    expect(h.mission).toContain("X-Pi-Prompt-Result: clarification");
    expect(h.mission).not.toContain("capability="); expect(h.mission).not.toContain("Submission nonce:");
    expect(h.mission).not.toContain("writer-result.json");
    if (teams) expect(JSON.stringify(h.spawnInput?.metadata)).not.toContain("attempt_identity");
    await h.generator.close(); await h.completion;
  });

  it("accepts exact plan bytes without any report and makes duplicate or late attempts non-authoritative", async () => {
    const h = await dispatched(true);
    await expect(h.generator.submitWriterResult(submission("attempt_identity_0001", "plan", Buffer.from(markdown, "utf8")))).resolves.toMatchObject({ ok: true });
    await expect(h.completion).resolves.toMatchObject({ ok: true, outcome: { kind: "plan", markdown } });
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await expect(h.generator.submitWriterResult(submission("attempt_identity_0001", "plan", Buffer.from(markdown)))).resolves.toMatchObject({ ok: false, error: { code: "writer-attempt-rejected" } });
  });

  it("accepts a strict clarification upload and rejects malformed or private clarification content", async () => {
    const accepted = await dispatched(true);
    const questions = Buffer.from(JSON.stringify({ questions: [{ id: "question-1", prompt: "Which target?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }));
    await expect(accepted.generator.submitWriterResult(submission("attempt_identity_0001", "clarification", questions))).resolves.toMatchObject({ ok: true });
    await expect(accepted.completion).resolves.toMatchObject({ ok: true, outcome: { kind: "clarification", questions: [{ id: "question-1" }] } });

    const malformed = await dispatched(true);
    await expect(malformed.generator.submitWriterResult(submission("attempt_identity_0001", "clarification", Buffer.from('{"questions":[],"extra":true}')))).resolves.toMatchObject({ ok: false, error: { code: "invalid-clarification" } });
    await expect(malformed.completion).resolves.toMatchObject({ ok: false, error: { code: "invalid-writer-result" } });

    const privateSubmission = await dispatched(true);
    const privateBody = Buffer.from(JSON.stringify({ questions: [{ id: "question-2", prompt: "PRIVATE SKILL BODY THAT MUST STAY PRIVATE", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }));
    await expect(privateSubmission.generator.submitWriterResult(submission("attempt_identity_0001", "clarification", privateBody))).resolves.toMatchObject({ ok: false, error: { code: "private-output-exposure" } });
    await expect(privateSubmission.completion).resolves.toMatchObject({ ok: false, error: { code: "invalid-writer-result" } });
  });

  it("rotates one correction bearer, rejects the old token, and settles only correction bytes", async () => {
    const h = await dispatched(true);
    const invalid = Buffer.from("# Wrong\n\n## Implementation Tasks\nTasks\n");
    await expect(h.generator.submitWriterResult(submission("attempt_identity_0001", "plan", invalid))).resolves.toMatchObject({ ok: false, error: { code: "invalid-plan-file" } });
    await expect(h.generator.submitWriterResult(submission("attempt_identity_0001", "plan", Buffer.from(markdown)))).resolves.toMatchObject({ ok: false, error: { code: "writer-attempt-rejected" } });
    h.handlers.get("agent_end")!(endEvent);
    h.pi.events.emit(TEAMS_REPORT_CHANNEL, { teamName: "private", name: "planner-private123", ok: true, report: "cleanup only" });
    await vi.waitFor(() => expect(h.pi.sendMessage).toHaveBeenCalledTimes(1));
    const mission = correctionMission(h);
    expect(mission).toContain("Authorization: Bearer attempt_identity_0002"); expect(mission).not.toContain("attempt_identity_0001");
    await expect(h.generator.submitWriterResult(submission("attempt_identity_0002", "plan", Buffer.from(markdown)))).resolves.toMatchObject({ ok: true });
    await expect(h.completion).resolves.toMatchObject({ ok: true, outcome: { markdown } });
  });

  it("queues correction when the cleanup report arrives before the parent agent_end", async () => {
    const h = await dispatched(true);
    const invalid = Buffer.from("# Wrong\n\n## Implementation Tasks\nTasks\n");
    await expect(h.generator.submitWriterResult(submission("attempt_identity_0001", "plan", invalid))).resolves.toMatchObject({ ok: false, error: { code: "invalid-plan-file" } });
    h.pi.events.emit(TEAMS_REPORT_CHANNEL, { teamName: "private", name: "planner-private123", ok: true, report: "cleanup before parent end" });
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    h.handlers.get("agent_end")!(endEvent);
    await vi.waitFor(() => expect(h.pi.sendMessage).toHaveBeenCalledTimes(1));
    const mission = correctionMission(h);
    expect(mission).toContain("Authorization: Bearer attempt_identity_0002");
    expect(mission).not.toContain("attempt_identity_0001");
    await expect(h.generator.submitWriterResult(submission("attempt_identity_0002", "plan", Buffer.from(markdown)))).resolves.toMatchObject({ ok: true });
    await expect(h.completion).resolves.toMatchObject({ ok: true, outcome: { markdown } });
  });

  it("starts a direct correction turn after an invalid upload and never trusts the legacy tool", async () => {
    const h = await dispatched(false);
    expect(await h.tool.execute("legacy", { nonce: "nonce_1234567890_safe", result: "plan saved" })).toMatchObject({ isError: true, details: { code: "http-submission-required" } });
    await h.generator.submitWriterResult(submission("attempt_identity_0001", "plan", Buffer.from("# Wrong")));
    h.handlers.get("agent_end")!(endEvent);
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(2));
    const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[1]![0] as string;
    h.handlers.get("input")!(inputEvent(marker)); const correction = h.handlers.get("before_agent_start")!(before(marker)).message.content as string;
    expect(correction).toContain("Authorization: Bearer attempt_identity_0002");
    await h.generator.submitWriterResult(submission("attempt_identity_0002", "plan", Buffer.from(markdown)));
    await expect(h.completion).resolves.toMatchObject({ ok: true });
  });
});
