import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Draft {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

interface DraftsFile {
  version: 1;
  drafts: Draft[];
}

const MAX_DRAFTS = 50;
export const PLAN_DRAFT_TAG = "(plan-draft)";
const PLAN_DRAFT_ID_PREFIX = "plan-";

function draftsPath(): string {
  return join(getAgentDir(), "extensions", "pi-prompt-drafts.json");
}

async function readDraftsFile(): Promise<DraftsFile> {
  try {
    const raw = await readFile(draftsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DraftsFile>;
    if (!parsed || !Array.isArray(parsed.drafts)) return { version: 1, drafts: [] };
    return { version: 1, drafts: parsed.drafts };
  } catch {
    return { version: 1, drafts: [] };
  }
}

async function writeDraftsFile(file: DraftsFile): Promise<void> {
  const path = draftsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2), "utf8");
}

export async function listDrafts(): Promise<Draft[]> {
  const file = await readDraftsFile();
  return [...file.drafts].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveDraft(text: string, existingId?: string): Promise<Draft> {
  const file = await readDraftsFile();
  const now = Date.now();

  if (existingId) {
    const found = file.drafts.find((d) => d.id === existingId);
    if (found) {
      found.text = text;
      found.updatedAt = now;
      await writeDraftsFile(file);
      return found;
    }
  }

  const draft: Draft = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    createdAt: now,
    updatedAt: now,
  };
  file.drafts.unshift(draft);
  file.drafts = retainedDrafts(file.drafts);
  await writeDraftsFile(file);
  return draft;
}

export async function deleteDraft(id: string): Promise<void> {
  const file = await readDraftsFile();
  file.drafts = file.drafts.filter((d) => d.id !== id);
  await writeDraftsFile(file);
}

export async function savePlanDraft(sessionId: string, prompt: string): Promise<Draft> {
  const file = await readDraftsFile();
  const id = planDraftId(sessionId);
  const now = Date.now();
  const text = `${PLAN_DRAFT_TAG} ${prompt}`;
  const found = file.drafts.find((draft) => draft.id === id);
  if (found) {
    found.text = text;
    found.updatedAt = now;
    await writeDraftsFile(file);
    return found;
  }
  const draft = { id, text, createdAt: now, updatedAt: now };
  file.drafts.unshift(draft);
  file.drafts = retainedDrafts(file.drafts);
  await writeDraftsFile(file);
  return draft;
}

export function deletePlanDraft(sessionId: string): Promise<void> {
  return deleteDraft(planDraftId(sessionId));
}

function planDraftId(sessionId: string): string {
  return `${PLAN_DRAFT_ID_PREFIX}${sessionId}`;
}

function retainedDrafts(drafts: Draft[]): Draft[] {
  const planDrafts = drafts.filter((draft) => draft.id.startsWith(PLAN_DRAFT_ID_PREFIX));
  const ordinaryDrafts = drafts.filter((draft) => !draft.id.startsWith(PLAN_DRAFT_ID_PREFIX)).slice(0, MAX_DRAFTS);
  return [...planDrafts, ...ordinaryDrafts].sort((left, right) => right.updatedAt - left.updatedAt);
}

/** Build a one-line preview label from a draft's text for list display. */
export function draftPreview(draft: Draft): string {
  const firstLine = draft.text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  const preview = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  return preview.length > 0 ? preview : "(empty draft)";
}
