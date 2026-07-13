import { describe, expect, it, vi } from "vitest";
import type {
  AgentEndEvent, BeforeAgentStartEvent, ExtensionAPI, InputEvent, ToolCallEvent, ToolInfo, ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { CurrentAgentPlanBridge, type CurrentAgentActivityUpdate } from "../extension/current-agent-bridge.js";
import type { PlanGeneratorInput, WriterSubmissionInput } from "../plan/generator.js";
import { PLAN_LIMITS } from "../plan/schema.js";
import type { PlanSession } from "../plan/types.js";
import { TEAMS_REPORT_CHANNEL } from "../extension/teams-planning-adapter.js";
import type { SpecGeneratorInput, SpecWriterSubmission } from "../spec/generator.js";
import { captured as capturedSpec } from "./spec-fixtures.js";
import { liveGrillResultFixture } from "./fixtures/grill-result-shorthand.js";

const endpoint = "http://127.0.0.1:43210/api/v1/writer-results";
const taskBody = "Scope: src/a.ts\nTest first: Add a failing test.\nImplement: Make the change.\nVerify: Run the test.\nDone when: The test passes.";
const markdown = `# Plan\r\n\r\n## Execution\r\nNormal\r\n\r\n## Implementation Tasks\r\nTasks\r\n\r\n### Build\r\n${taskBody.replaceAll("\n", "\r\n")}\r\n`;
const sourceInfo = { path: "/packages/pi-extended-teams/extensions/index.ts", source: "npm:pi-extended-teams@2.0.0", scope: "user" as const, origin: "package" as const };
const spawnTool = { name: "spawn_agent", description: "spawn", sourceInfo, parameters: { type: "object", required: ["prompt", "model_slot"], properties: {
  prompt: { type: "string" }, model_slot: { type: "string", enum: ["writing-basic", "writing-hard"] }, name: { type: "string" }, cwd: { type: "string" }, metadata: { type: "object" },
} } } as ToolInfo;

function initialSession(prompt = "Build it", id = "session", jobId = "job"): PlanSession {
  return { schemaVersion: 1, id, stateVersion: 2, documentRevision: 0, status: "generating", source: { prompt, cwd: "/repo", skills: [] }, execution: { kind: "normal" }, generation: { mode: "normal" }, document: null, annotations: [], generationJob: { jobId, operation: "initial", baseDocumentRevision: 0, selectedAnnotationIds: [], startedAt: "2026-07-11T00:00:00.000Z" } };
}
function input(prompt = "Build it", signal = new AbortController().signal, id = "session", jobId = "job"): PlanGeneratorInput {
  const session = initialSession(prompt, id, jobId);
  return { session, jobId, operation: "initial", selectedAnnotationIds: [], loadSkills: async () => ({ ok: true, value: [{ name: "private-skill", body: "PRIVATE SKILL BODY THAT MUST STAY PRIVATE" }] }), signal };
}
function submission(attemptId: string, kind: "plan" | "clarification" | "grill", body: Buffer): WriterSubmissionInput {
  return { sessionId: "session", jobId: "job", operation: "initial", baseDocumentRevision: 0, attemptId, kind, body };
}
function revisionInput(signal = new AbortController().signal): PlanGeneratorInput {
  const document = { id: "document", title: { id: "title", kind: "title" as const, body: "Existing plan", children: [] }, elements: [{ id: "execution", kind: "execution" as const, body: "Normal", children: [] }, { id: "step", kind: "step" as const, body: "Old contents", children: [] }] };
  const session: PlanSession = { schemaVersion: 1, id: "session", stateVersion: 4, documentRevision: 1, status: "revising", source: { prompt: "Original\nrequest unchanged", cwd: "/repo", skills: [{ name: "private-skill", path: "/private/skills/private-skill/SKILL.md", baseDir: "/private/skills/private-skill", sha256: "a".repeat(64) }] }, execution: { kind: "normal" }, generation: { mode: "normal" }, document, annotations: [], generationJob: { jobId: "revision-job", operation: "revision", baseDocumentRevision: 1, selectedAnnotationIds: [], instruction: "Replace it freely", startedAt: "2026-07-11T00:00:00.000Z" } };
  return { session, jobId: "revision-job", operation: "revision", selectedAnnotationIds: [], instruction: "Replace it freely", loadSkills: async () => ({ ok: true, value: [{ name: "private-skill", body: "PRIVATE SKILL BODY THAT MUST STAY PRIVATE" }] }), signal };
}
function revisionSubmission(attemptId: string, body: Buffer, overrides: Partial<WriterSubmissionInput> = {}): WriterSubmissionInput {
  return { sessionId: "session", jobId: "revision-job", operation: "revision", baseDocumentRevision: 1, attemptId, kind: "plan", body, ...overrides };
}
function grillInput(signal = new AbortController().signal): PlanGeneratorInput {
  const document = { id: "markdown-document-1", title: { id: "markdown-title-1", kind: "title" as const, body: "Plan", children: [] }, elements: [{ id: "markdown-chunk-1-0", kind: "execution" as const, body: "Normal 😀", children: [{ id: "markdown-chunk-1-1", kind: "step" as const, body: "Build", children: [] }] }] };
  const session: PlanSession = { schemaVersion: 1, id: "session", stateVersion: 4, documentRevision: 1, status: "grilling", source: { prompt: "PRIVATE SOURCE PROMPT THAT MUST STAY PRIVATE", cwd: "/repo", skills: [] }, execution: { kind: "normal" }, generation: { mode: "normal" }, document, annotations: [], generationJob: { jobId: "job", operation: "grill", baseDocumentRevision: 1, selectedAnnotationIds: [], startedAt: "2026-07-11T00:00:00.000Z" } };
  return { session, jobId: "job", operation: "grill", selectedAnnotationIds: [], loadSkills: async () => ({ ok: true, value: [{ name: "private-skill", body: "PRIVATE SKILL BODY THAT MUST STAY PRIVATE" }] }), signal };
}
function initialSpecInput(signal = new AbortController().signal): SpecGeneratorInput {
  const source = capturedSpec();
  const session = { schemaVersion: 1 as const, planSessionId: "plan-session", stateVersion: 2, specRevision: 0, status: "generating" as const, source: source.reference, markdown: null, comments: [], generationJob: { jobId: "spec-job", operation: "initial" as const, baseSpecRevision: 0, selectedCommentIds: [], source: source.reference, startedAt: "2026-07-12T00:00:00.000Z" } };
  return { session, source, jobId: "spec-job", operation: "initial", selectedCommentIds: [], signal };
}
function specSubmission(body: Buffer): SpecWriterSubmission {
  return { planSessionId: "plan-session", jobId: "spec-job", operation: "initial", baseSpecRevision: 0, attemptId: "attempt_identity_0001", kind: "spec", body };
}
function harness(options: { teams?: boolean; idle?: boolean; attemptFactory?: () => string } = {}) {
  const handlers = new Map<string, Function>(); const reportHandlers = new Set<(payload: unknown) => void>();
  const activities: CurrentAgentActivityUpdate[] = []; let tool: any; let attempt = 0; let nonce = 0;
  const pi = {
    registerTool: vi.fn((value) => { tool = value; }), sendUserMessage: vi.fn(), sendMessage: vi.fn(), on: vi.fn((name, handler) => handlers.set(name, handler)),
    getActiveTools: vi.fn(() => options.teams ? ["spawn_agent"] : ["read", "bash"]), getAllTools: vi.fn(() => options.teams ? [spawnTool] : []),
    events: { emit: vi.fn((channel: string, payload: unknown) => { if (channel === TEAMS_REPORT_CHANNEL) for (const handler of [...reportHandlers]) handler(payload); }), on: vi.fn((channel: string, handler: (payload: unknown) => void) => { if (channel === TEAMS_REPORT_CHANNEL) reportHandlers.add(handler); return () => reportHandlers.delete(handler); }) },
  } as unknown as ExtensionAPI;
  const bridge = new CurrentAgentPlanBridge(pi, {
    nonceFactory: () => ++nonce === 1 ? "nonce_1234567890_safe" : `nonce_1234567890_${String(nonce).padStart(4, "0")}`, primaryNameFactory: () => "planner-private123", correlationFactory: () => "correlation-private123",
    attemptFactory: options.attemptFactory ?? (() => `attempt_identity_${String(++attempt).padStart(4, "0")}`), planRoot: "/private/plans",
  });
  const generator = bridge.createGenerator(() => options.idle ?? true, (activity) => activities.push(activity));
  return { pi, bridge, generator, handlers, reportHandlers, activities, get tool() { return tool; } };
}
const before = (prompt: string): BeforeAgentStartEvent => ({ type: "before_agent_start", prompt, systemPrompt: "system", systemPromptOptions: {} as never });
const inputEvent = (text: string): InputEvent => ({ type: "input", text, source: "extension" });
const toolCall = (): ToolCallEvent => ({ type: "tool_call", toolCallId: "spawn-call", toolName: "spawn_agent", input: {} }) as ToolCallEvent;
const spawnResult = (): ToolResultEvent => ({ type: "tool_result", toolCallId: "spawn-call", toolName: "spawn_agent", input: {}, content: [], details: { name: "planner-private123", session: "private" }, isError: false }) as ToolResultEvent;
const endEvent = { type: "agent_end", messages: [] } as AgentEndEvent;

async function dispatched(teams: boolean, prompt = "Build it") {
  const h = harness({ teams });
  expect(h.generator.configureWriterEndpoint(endpoint)).toMatchObject({ ok: true });
  const completion = h.generator.generate(input(prompt));
  expect(h.generator.dispatch("job")).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1));
  const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string;
  h.handlers.get("input")!(inputEvent(marker)); const started = h.handlers.get("before_agent_start")!(before(marker));
  const agentContext = started.message.content as string;
  let mission = agentContext; let spawnInput: Record<string, unknown> | undefined;
  if (teams) {
    const call = toolCall(); h.handlers.get("tool_call")!(call); h.handlers.get("tool_result")!(spawnResult()); spawnInput = call.input; mission = String(spawnInput.prompt);
  }
  return { ...h, completion, marker, agentContext, mission, spawnInput };
}
async function dispatchedSpec() {
  const h = harness(); const generator = h.bridge.createSpecGenerator(() => true);
  expect(generator.configureWriterEndpoint(endpoint)).toMatchObject({ ok: true });
  const completion = generator.generate(initialSpecInput()); expect(generator.dispatch("spec-job")).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledOnce());
  const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string;
  h.handlers.get("input")!(inputEvent(marker)); const mission = h.handlers.get("before_agent_start")!(before(marker)).message.content as string;
  return { ...h, generator, completion, marker, mission };
}
function correctionMission(h: Awaited<ReturnType<typeof dispatched>>): string {
  const message = vi.mocked(h.pi.sendMessage).mock.calls[0]![0] as Record<string, unknown>;
  h.handlers.get("message_start")!({ message: { role: "custom", ...message } });
  const call = toolCall(); h.handlers.get("tool_call")!(call); h.handlers.get("tool_result")!(spawnResult());
  return String((call.input as Record<string, unknown>).prompt);
}

describe("current-agent authenticated writer handoff", () => {
  it("uses the shared authenticated endpoint for exact correlated Spec Markdown without Plan-schema or issue-tracker output", async () => {
    const h = harness(); const generator = h.bridge.createSpecGenerator(() => true); expect(generator.configureWriterEndpoint(endpoint)).toMatchObject({ ok: true }); const source = capturedSpec();
    const session = { schemaVersion: 1 as const, planSessionId: "plan-session", stateVersion: 2, specRevision: 0, status: "generating" as const, source: source.reference, markdown: null, comments: [], generationJob: { jobId: "spec-job", operation: "initial" as const, baseSpecRevision: 0, selectedCommentIds: [], source: source.reference, startedAt: "2026-07-12T00:00:00.000Z" } };
    const input: SpecGeneratorInput = { session, source, jobId: "spec-job", operation: "initial", selectedCommentIds: [], signal: new AbortController().signal }; const completion = generator.generate(input); expect(generator.dispatch("spec-job")).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledOnce()); const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string; expect(marker).toBe("pi-prompt Spec creation in progress"); h.handlers.get("input")!(inputEvent(marker)); const started = h.handlers.get("before_agent_start")!(before(marker)); const mission = started.message.content as string;
    expect(mission).toContain("X-Pi-Prompt-Result: spec"); expect(mission).toContain("grill.json#/decisionTree"); expect(mission).toContain("Do not use the Plan storage schema"); expect(mission).toContain("do not create issue-tracker artifacts");
    expect(mission).toContain("transient writer draft /tmp/pi-prompt-plans/plan-session/spec/spec-result.md");
    expect(mission).toContain("never write the repository-owned canonical Spec /tmp/pi-prompt-plans/plan-session/spec/spec.md");
    expect(mission).toContain("--data-binary '@/tmp/pi-prompt-plans/plan-session/spec/spec-result.md'");
    expect(mission).not.toContain("--data-binary '@/tmp/pi-prompt-plans/plan-session/spec/spec.md'");
    expect(mission).toContain("fix the transient draft, and retry the same upload during this turn");
    expect(mission).toContain("gate remains active until a submission is accepted or this turn ends");
    const body = Buffer.from("\uFEFF# Exact Spec\r\n\r\n## API\r\nShip 😀.\r\n", "utf8");
    expect(await generator.submitWriterResult({ planSessionId: "plan-session", jobId: "spec-job", operation: "initial", baseSpecRevision: 0, attemptId: "attempt_identity_0001", kind: "spec", body })).toMatchObject({ ok: true });
    h.handlers.get("agent_end")!(endEvent);
    const persisted = await completion; expect(persisted).toMatchObject({ ok: true });
    if (persisted.ok) expect(Buffer.from(persisted.markdown, "utf8")).toEqual(body);
    expect(h.pi.sendUserMessage).toHaveBeenCalledOnce(); expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps an invalid Spec upload pending and accepts corrected bytes from the same attempt", async () => {
    const h = await dispatchedSpec(); let settled = false; void h.completion.then(() => { settled = true; });
    await expect(h.generator.submitWriterResult(specSubmission(Buffer.from("## Missing H1\n")))).resolves.toMatchObject({ ok: false, error: { code: "missing-h1", message: "Spec Markdown must contain an H1 heading." } });
    await Promise.resolve(); expect(settled).toBe(false);
    await expect(h.generator.submitWriterResult(specSubmission(Buffer.from("# Corrected Spec\n")))).resolves.toMatchObject({ ok: true });
    h.handlers.get("agent_end")!(endEvent);
    await expect(h.completion).resolves.toMatchObject({ ok: true, markdown: "# Corrected Spec\n" });
    expect(h.pi.sendUserMessage).toHaveBeenCalledOnce(); expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("settles an ended invalid Spec turn with its latest safe error and one extension follow-up", async () => {
    const h = await dispatchedSpec();
    await expect(h.generator.submitWriterResult(specSubmission(Buffer.from([0xc3, 0x28])))).resolves.toMatchObject({ ok: false, error: { code: "invalid-utf8" } });
    await expect(h.generator.submitWriterResult(specSubmission(Buffer.from("## Missing H1\n")))).resolves.toMatchObject({ ok: false, error: { code: "missing-h1" } });
    h.handlers.get("agent_end")!(endEvent); h.handlers.get("agent_end")!(endEvent);
    await expect(h.completion).resolves.toMatchObject({ ok: false, error: { code: "missing-h1", message: "Spec Markdown must contain an H1 heading." } });
    expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(2);
    const [message, options] = vi.mocked(h.pi.sendUserMessage).mock.calls[1]!;
    expect(options).toEqual({ deliverAs: "followUp" });
    expect(message).toContain("Stage: Spec"); expect(message).toContain("Plan session ID: plan-session"); expect(message).toContain("Operation: initial");
    expect(message).toContain("Error code: missing-h1"); expect(message).toContain("Error message: Spec Markdown must contain an H1 heading.");
    expect(message).toContain("Transient draft path: /tmp/pi-prompt-plans/plan-session/spec/spec-result.md");
    expect(message).toContain("The submission was not accepted. The current agent may inspect and fix the transient draft, then retry from the browser.");
    expect(message).not.toContain(endpoint); expect(message).not.toContain("attempt_identity"); expect(message).not.toContain("Authorization");
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps canonical Spec ownership interruption-safe while a revision uses only the transient draft", async () => {
    const h = harness(); const generator = h.bridge.createSpecGenerator(() => true); generator.configureWriterEndpoint(endpoint); const source = capturedSpec();
    const session = { schemaVersion: 1 as const, planSessionId: "plan-session", stateVersion: 4, specRevision: 1, status: "revising" as const, source: source.reference, markdown: "# Existing Spec\n", comments: [], generationJob: { jobId: "spec-revision-job", operation: "revision" as const, baseSpecRevision: 1, selectedCommentIds: [], source: source.reference, startedAt: "2026-07-12T00:00:00.000Z" } };
    const specInput: SpecGeneratorInput = { session, source, jobId: "spec-revision-job", operation: "revision", selectedCommentIds: [], signal: new AbortController().signal };
    const completion = generator.generate(specInput); generator.dispatch("spec-revision-job");
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledOnce()); const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string; expect(marker).toBe("pi-prompt Spec revision in progress");
    h.handlers.get("input")!(inputEvent(marker)); const mission = h.handlers.get("before_agent_start")!(before(marker)).message.content as string;
    expect(mission).toContain("Existing Spec input: /tmp/pi-prompt-plans/plan-session/spec/spec.md");
    expect(mission).toContain("transient writer draft /tmp/pi-prompt-plans/plan-session/spec/spec-result.md");
    expect(mission).toContain("--data-binary '@/tmp/pi-prompt-plans/plan-session/spec/spec-result.md'");
    h.handlers.get("agent_end")!(endEvent);
    await expect(completion).resolves.toMatchObject({ ok: false, error: { code: "missing-spec-submission" } });
    expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(2);
    const [followUp, options] = vi.mocked(h.pi.sendUserMessage).mock.calls[1]!;
    expect(options).toEqual({ deliverAs: "followUp" }); expect(followUp).toContain("Operation: revision");
    expect(followUp).toContain("Error code: missing-spec-submission"); expect(followUp).toContain("Transient draft path: /tmp/pi-prompt-plans/plan-session/spec/spec-result.md");
    expect(session.markdown).toBe("# Existing Spec\n");
    await expect(generator.submitWriterResult({ planSessionId: "plan-session", jobId: "spec-revision-job", operation: "revision", baseSpecRevision: 1, attemptId: "attempt_identity_0001", kind: "spec", body: Buffer.from("# Late Spec\n") })).resolves.toMatchObject({ ok: false, error: { code: "writer-attempt-rejected" } });
  });

  it("does not emit a failure follow-up when an active Spec gate is shut down", async () => {
    const h = await dispatchedSpec(); await h.generator.close(); h.handlers.get("agent_end")!(endEvent);
    await expect(h.completion).resolves.toMatchObject({ ok: false, error: { code: "generation-cancelled" } });
    expect(h.pi.sendUserMessage).toHaveBeenCalledOnce(); expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("makes a safe pre-agent Spec terminal failure visible as an extension follow-up", async () => {
    const h = harness({ attemptFactory: () => "unsafe" }); const generator = h.bridge.createSpecGenerator(() => true);
    const result = await generator.generate(initialSpecInput());
    expect(result).toMatchObject({ ok: false, error: { code: "attempt-identity-unavailable" } });
    expect(h.pi.sendUserMessage).toHaveBeenCalledOnce();
    const [message, options] = vi.mocked(h.pi.sendUserMessage).mock.calls[0]!;
    expect(options).toEqual({ deliverAs: "followUp" }); expect(message).toContain("Stage: Spec");
    expect(message).toContain("Error code: attempt-identity-unavailable"); expect(message).toContain("Plan session ID: plan-session");
  });

  it("does not recursively hand off when sending the Spec dispatch message fails", async () => {
    const h = harness(); const generator = h.bridge.createSpecGenerator(() => true); generator.configureWriterEndpoint(endpoint);
    vi.mocked(h.pi.sendUserMessage).mockImplementation(() => { throw new Error("send failed"); });
    const completion = generator.generate(initialSpecInput()); expect(generator.dispatch("spec-job")).toMatchObject({ ok: true });
    await expect(completion).resolves.toMatchObject({ ok: false, error: { code: "dispatch-failed" } });
    expect(h.pi.sendUserMessage).toHaveBeenCalledOnce(); expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("gives Grill writers a public anchor map and accepts a mission-derived target", async () => {
    const h = harness(); h.generator.configureWriterEndpoint(endpoint); const completion = h.generator.generate(grillInput()); h.generator.dispatch("job");
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1)); const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string;
    expect(marker).toBe("pi-prompt plan Grill critique in progress"); h.handlers.get("input")!(inputEvent(marker)); const started = h.handlers.get("before_agent_start")!(before(marker)); const mission = started.message.content as string;
    expect(mission).toContain("grill-result.json"); expect(mission).toContain("X-Pi-Prompt-Result: grill"); expect(mission).toContain("Unicode code points"); expect(mission).toContain('{"kind":"range","elementId":"anchor-id","field":"body","start":0,"end":4}'); expect(mission).toContain("Do not copy quoted exact/prefix/suffix"); expect(mission).not.toContain("PRIVATE SOURCE PROMPT"); expect(mission).not.toContain("PRIVATE SKILL BODY");
    const anchorJson = mission.match(/Canonical public anchor map \(the complete current document projection, including revision chunks\):\n([^\n]+)/)?.[1];
    expect(anchorJson).toBeDefined(); const anchorMap = JSON.parse(anchorJson!) as {
      documentRevision: number;
      anchors: Array<{ target: { kind: string; elementId: string }; fields?: { body: { exact: string } } }>;
    };
    const publicAnchor = anchorMap.anchors.find((anchor) => anchor.target.kind === "element" && anchor.fields?.body.exact === "Build");
    expect(anchorMap.documentRevision).toBe(1); expect(anchorMap.anchors.some((anchor) => anchor.fields?.body.exact === "Normal 😀")).toBe(true); expect(publicAnchor).toBeDefined();
    const result = liveGrillResultFixture(anchorMap.documentRevision, publicAnchor!.target.elementId, "body");
    expect(await h.generator.submitWriterResult({ sessionId: "session", jobId: "job", operation: "grill", baseDocumentRevision: 1, attemptId: "attempt_identity_0001", kind: "grill", body: Buffer.from(JSON.stringify(result)) })).toMatchObject({ ok: true });
    const accepted = await completion;
    expect(accepted).toMatchObject({ ok: true, outcome: { kind: "grill", decisionTree: { rootNodeId: "decision-root" } } });
    if (accepted.ok && accepted.outcome.kind === "grill") {
      expect(Object.keys(accepted.outcome.annotations)).toHaveLength(4);
      expect(accepted.outcome.annotations.scope?.target).toEqual({ kind: "range", elementId: publicAnchor!.target.elementId, field: "body", start: 0, end: 1 });
    }
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("settles exhausted invalid Grill submissions with their specific validation error", async () => {
    const h = harness(); h.generator.configureWriterEndpoint(endpoint); const completion = h.generator.generate(grillInput()); h.generator.dispatch("job");
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledOnce()); const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string;
    h.handlers.get("input")!(inputEvent(marker)); h.handlers.get("before_agent_start")!(before(marker));
    const invalid = Buffer.from("{}");
    await expect(h.generator.submitWriterResult({ sessionId: "session", jobId: "job", operation: "grill", baseDocumentRevision: 1, attemptId: "attempt_identity_0001", kind: "grill", body: invalid })).resolves.toMatchObject({ ok: false, error: { code: "invalid-grill" } });
    await expect(h.generator.submitWriterResult({ sessionId: "session", jobId: "job", operation: "grill", baseDocumentRevision: 1, attemptId: "attempt_identity_0002", kind: "grill", body: invalid })).resolves.toMatchObject({ ok: false, error: { code: "invalid-grill" } });
    await expect(completion).resolves.toMatchObject({ ok: false, error: { code: "invalid-grill" } });
  });

  it("fails dispatch safely until the loopback writer endpoint is configured", async () => {
    const h = harness(); const completion = h.generator.generate(input());
    expect(h.generator.dispatch("job")).toMatchObject({ ok: false, error: { code: "writer-endpoint-unavailable" } });
    expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
    await h.generator.close(); await expect(completion).resolves.toMatchObject({ ok: false, error: { code: "generation-cancelled" } });
  });

  it.each([false, true])("gives delegated=%s writers only the private HTTP upload credential and keeps the browser capability absent", async (teams) => {
    const h = await dispatched(teams);
    expect(h.marker).toBe("pi-prompt plan creation in progress\nserver initialized...\nid: session\n\nprompt: Build it");
    expect(h.agentContext).toContain("Plan session ID: session"); expect(h.agentContext).toContain("Operation: initial");
    expect(h.agentContext).toContain("Original prompt: Build it");
    expect(h.agentContext).toContain(teams ? "A dedicated planner agent is starting to build this plan." : "The current agent is starting to build this plan directly.");
    if (teams) expect(h.agentContext).not.toContain("PRIVATE SKILL BODY");
    expect(h.mission).toContain(endpoint); expect(h.mission).toContain("Authorization: Bearer attempt_identity_0001");
    expect(h.mission).toContain("--data-binary '@/private/plans/session/plan.md'");
    expect(h.mission).toContain("X-Pi-Prompt-Result: clarification");
    expect(h.mission).not.toContain("capability="); expect(h.mission).not.toContain("Submission nonce:");
    expect(h.mission).not.toContain("writer-result.json");
    if (teams) expect(JSON.stringify(h.spawnInput?.metadata)).not.toContain("attempt_identity");
    await h.generator.close(); await h.completion;
  });

  it("shows the full original prompt unchanged on the first initial dispatch only", async () => {
    const prompt = `Cook\n${"😀".repeat(100)}`;
    const h = await dispatched(false, prompt);
    expect(h.marker).toBe(`pi-prompt plan creation in progress\nserver initialized...\nid: session\n\nprompt: ${prompt}`);
    expect(h.marker).not.toContain("nonce_1234567890_safe");
    await h.generator.close(); await h.completion;
  });

  it("keeps retries for the same session concise while a new session gets one verbose marker", async () => {
    const h = harness(); h.generator.configureWriterEndpoint(endpoint);
    const first = h.generator.generate(input("First prompt")); h.generator.dispatch("job");
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0]).toContain("server initialized...\nid: session\n\nprompt: First prompt");
    await h.generator.close(); await first;

    const retry = h.bridge.createGenerator(() => true); retry.configureWriterEndpoint(endpoint);
    const retryCompletion = retry.generate(input("First prompt")); retry.dispatch("job");
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(h.pi.sendUserMessage).mock.calls[1]![0]).toBe("pi-prompt plan creation in progress");
    await retry.close(); await retryCompletion;

    const next = h.bridge.createGenerator(() => true); next.configureWriterEndpoint(endpoint);
    const nextCompletion = next.generate(input("Second prompt", new AbortController().signal, "session-2", "job-2")); next.dispatch("job-2");
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(3));
    expect(vi.mocked(h.pi.sendUserMessage).mock.calls[2]![0]).toBe("pi-prompt plan creation in progress\nserver initialized...\nid: session-2\n\nprompt: Second prompt");
    await next.close(); await nextCompletion;
  });

  it("rolls back the verbose-session claim when marker delivery throws", async () => {
    const h = harness(); vi.mocked(h.pi.sendUserMessage).mockImplementationOnce(() => { throw new Error("send failed"); });
    h.generator.configureWriterEndpoint(endpoint); const failedCompletion = h.generator.generate(input("Retry me")); h.generator.dispatch("job");
    await expect(failedCompletion).resolves.toMatchObject({ ok: false, error: { code: "dispatch-failed" } });

    const retry = h.bridge.createGenerator(() => true); retry.configureWriterEndpoint(endpoint);
    const completion = retry.generate(input("Retry me")); retry.dispatch("job");
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(h.pi.sendUserMessage).mock.calls[1]![0]).toBe("pi-prompt plan creation in progress\nserver initialized...\nid: session\n\nprompt: Retry me");
    await retry.close(); await completion;
  });

  it("accepts arbitrary correlated revision bytes as the exact revision-markdown outcome", async () => {
    const h = harness(); h.generator.configureWriterEndpoint(endpoint); const completion = h.generator.generate(revisionInput()); h.generator.dispatch("revision-job");
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledOnce());
    const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string; expect(marker).toBe("pi-prompt plan revision in progress");
    h.handlers.get("input")!(inputEvent(marker)); const started = h.handlers.get("before_agent_start")!(before(marker)); const mission = started.message.content as string;
    expect(mission).toContain("complete replacement plan as UTF-8 Markdown"); expect(mission).toContain("X-Pi-Prompt-Result: plan");
    expect(mission).not.toContain("Implementation Tasks"); expect(mission).not.toContain("questions.json"); expect(mission).not.toContain("validation feedback");

    const prefix = "\uFEFFnot a schema plan\r\ncafe\u0301 remains decomposed\r\n😀\u0000";
    const body = Buffer.from(prefix + "x".repeat(PLAN_LIMITS.committedMarkdownBytes - Buffer.byteLength(prefix, "utf8")), "utf8");
    expect(body.byteLength).toBe(PLAN_LIMITS.committedMarkdownBytes);
    await expect(h.generator.submitWriterResult(revisionSubmission("attempt_identity_0001", body, { sessionId: "stale" }))).resolves.toMatchObject({ ok: false, error: { code: "writer-attempt-rejected" } });
    await expect(h.generator.submitWriterResult(revisionSubmission("attempt_identity_0001", body, { jobId: "stale-job" }))).resolves.toMatchObject({ ok: false, error: { code: "writer-attempt-rejected" } });
    await expect(h.generator.submitWriterResult(revisionSubmission("wrong_attempt_identity", body))).resolves.toMatchObject({ ok: false, error: { code: "writer-attempt-rejected" } });
    await expect(h.generator.submitWriterResult(revisionSubmission("attempt_identity_0001", body, { baseDocumentRevision: 0 }))).resolves.toMatchObject({ ok: false, error: { code: "writer-attempt-rejected" } });
    await expect(h.generator.submitWriterResult(revisionSubmission("attempt_identity_0001", body))).resolves.toMatchObject({ ok: true });
    const persisted = await completion; expect(persisted).toMatchObject({ ok: true, outcome: { kind: "revision-markdown" } });
    if (persisted.ok && persisted.outcome.kind === "revision-markdown") expect(Buffer.from(persisted.outcome.markdown, "utf8")).toEqual(body);
    expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["loaded skill body", "PRIVATE SKILL BODY THAT MUST STAY PRIVATE"],
    ["selected skill path", "/private/skills/private-skill/SKILL.md"],
    ["selected skill baseDir", "/private/skills/private-skill"],
  ])("rejects revision exposure of the literal %s before bridge success", async (_label, exposed) => {
    const h = harness(); h.generator.configureWriterEndpoint(endpoint); const completion = h.generator.generate(revisionInput()); h.generator.dispatch("revision-job");
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledOnce()); const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string;
    h.handlers.get("input")!(inputEvent(marker)); h.handlers.get("before_agent_start")!(before(marker));
    await expect(h.generator.submitWriterResult(revisionSubmission("attempt_identity_0001", Buffer.from(`ordinary prefix\r\n${exposed}\r\n`, "utf8")))).resolves.toMatchObject({ ok: false, error: { code: "private-output-exposure" } });
    await expect(completion).resolves.toMatchObject({ ok: false, error: { code: "private-output-exposure" } });
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects invalid revision UTF-8 directly without correction", async () => {
    const h = harness(); h.generator.configureWriterEndpoint(endpoint); const completion = h.generator.generate(revisionInput()); h.generator.dispatch("revision-job");
    await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledOnce()); const marker = vi.mocked(h.pi.sendUserMessage).mock.calls[0]![0] as string;
    h.handlers.get("input")!(inputEvent(marker)); h.handlers.get("before_agent_start")!(before(marker));
    await expect(h.generator.submitWriterResult(revisionSubmission("attempt_identity_0001", Buffer.from([0xc3, 0x28])))).resolves.toMatchObject({ ok: false, error: { code: "invalid-utf8" } });
    await expect(completion).resolves.toMatchObject({ ok: false, error: { code: "invalid-utf8" } });
    expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1); expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("preserves initial Plan BOM bytes through the outcome while duplicate or late attempts remain non-authoritative", async () => {
    const h = await dispatched(true); const uploaded = Buffer.from(`\uFEFF${markdown}`, "utf8"); const committedMarkdown = uploaded.toString("utf8");
    await expect(h.generator.submitWriterResult(submission("attempt_identity_0001", "plan", uploaded))).resolves.toMatchObject({ ok: true });
    const completed = await h.completion;
    expect(completed).toMatchObject({ ok: true, outcome: { kind: "plan", markdown: committedMarkdown } });
    if (completed.ok && completed.outcome.kind === "plan") expect(Buffer.from(completed.outcome.markdown!, "utf8")).toEqual(uploaded);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await expect(h.generator.submitWriterResult(submission("attempt_identity_0001", "plan", uploaded))).resolves.toMatchObject({ ok: false, error: { code: "writer-attempt-rejected" } });
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
    expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
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
    expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
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
    expect(marker).toBe("pi-prompt plan correction in progress");
    h.handlers.get("input")!(inputEvent(marker)); const correction = h.handlers.get("before_agent_start")!(before(marker)).message.content as string;
    expect(correction).toContain("Authorization: Bearer attempt_identity_0002");
    await h.generator.submitWriterResult(submission("attempt_identity_0002", "plan", Buffer.from(markdown)));
    await expect(h.completion).resolves.toMatchObject({ ok: true });
  });
});
