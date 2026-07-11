import { createHash } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureSelectedSkills, reloadSavedSkills, type DiscoveredSkillReference } from "../plan/skills.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function setup(bytes: Uint8Array = Buffer.from("# Cafe\u0301\r\n", "utf8")): Promise<{ root: string; skill: DiscoveredSkillReference; bytes: Uint8Array }> {
  const root = await mkdtemp(join(tmpdir(), "plan-skills-")); roots.push(root); const path = join(root, "SKILL.md"); await writeFile(path, bytes);
  return { root, skill: { name: "example", path, baseDir: root }, bytes };
}

describe("skill capture and reload", () => {
  it("hashes raw Unicode bytes and reloads the exact unnormalized body", async () => {
    const { skill, bytes } = await setup(); const captured = await captureSelectedSkills(["example"], [skill]);
    expect(captured.ok).toBe(true); if (!captured.ok) return;
    expect(captured.references[0]?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(captured.contexts[0]?.name).toBe("example"); expect(captured.contexts[0]?.body).toBe("# Cafe\u0301\r\n");
    const reloaded = await reloadSavedSkills(captured.references, [skill]); expect(reloaded.ok).toBe(true);
    if (reloaded.ok) { expect(reloaded.references).toEqual(captured.references); expect(reloaded.contexts[0]?.body).toBe(captured.contexts[0]?.body); }
    expect(JSON.stringify(captured.references)).not.toContain("Cafe"); expect(JSON.stringify(captured.contexts)).not.toContain("Cafe");
  });

  it("fails closed without partial bodies for missing, changed, unreadable and digest mismatch cases", async () => {
    const { root, skill } = await setup(); const captured = await captureSelectedSkills(["example"], [skill]); if (!captured.ok) return;
    expect(await reloadSavedSkills(captured.references, [])).toMatchObject({ ok: false, issues: [{ code: "skill-missing" }] });
    expect(await reloadSavedSkills(captured.references, [{ ...skill, baseDir: `${root}-changed` }])).toMatchObject({ ok: false, issues: [{ code: "skill-changed" }] });
    await writeFile(skill.path, "changed"); expect(await reloadSavedSkills(captured.references, [skill])).toMatchObject({ ok: false, issues: [{ code: "skill-digest-mismatch" }] });
    await unlink(skill.path); expect(await reloadSavedSkills(captured.references, [skill])).toMatchObject({ ok: false, issues: [{ code: "skill-unreadable" }] });
  });

  it("rejects malformed UTF-8, duplicate selections and ambiguous discovery", async () => {
    const { skill } = await setup(Uint8Array.from([0xc3, 0x28]));
    expect(await captureSelectedSkills(["example"], [skill])).toMatchObject({ ok: false, issues: [{ code: "skill-invalid-utf8" }] });
    expect(await captureSelectedSkills(["example", "example"], [skill])).toMatchObject({ ok: false, issues: [{ code: "duplicate-selection" }] });
    expect(await captureSelectedSkills(["example"], [skill, { ...skill, path: `${skill.path}-other` }])).toMatchObject({ ok: false, issues: [{ code: "duplicate-discovery" }] });
  });
});
