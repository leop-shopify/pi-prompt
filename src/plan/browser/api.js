const ORIGIN_HEADER = "X-Pi-Prompt-Origin";
const CAPABILITY_STORAGE_KEY = "pi-prompt-review-capability";
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function readCapability(locationObject = window.location, historyObject = window.history, storageObject = window.sessionStorage) {
  const match = /^#capability=([A-Za-z0-9_-]{43})$/.exec(locationObject.hash);
  historyObject.replaceState(null, "", `${locationObject.pathname}${locationObject.search}`);
  if (match) {
    try { storageObject.setItem(CAPABILITY_STORAGE_KEY, match[1]); } catch { /* retain the fragment capability in memory */ }
    return match[1];
  }
  try { const stored = storageObject.getItem(CAPABILITY_STORAGE_KEY); return typeof stored === "string" && CAPABILITY_PATTERN.test(stored) ? stored : null; }
  catch { return null; }
}
export function clearCapability(storageObject = window.sessionStorage) { try { storageObject.removeItem(CAPABILITY_STORAGE_KEY); } catch { /* server invalidation remains authoritative */ } }

export function createPlanApi(capability, fetchImpl = window.fetch.bind(window)) {
  let planEtag = null; let specEtag = null;
  const headers = (kind, mutation = false) => ({
    Authorization: `Bearer ${capability}`, [ORIGIN_HEADER]: window.location.origin,
    ...(mutation ? { "Content-Type": "application/json", "If-Match": kind === "spec" ? specEtag : planEtag } : {}),
  });
  const request = async (path, kind, options = {}, allowMissing = false) => {
    const response = await fetchImpl(path, { cache: "no-store", ...options });
    if (allowMissing && response.status === 404) return { response, data: null };
    if (response.status === 204) return { response, data: null };
    const data = await response.json().catch(() => ({ error: { code: "invalid-response", message: "Pi returned an invalid response." } }));
    if (!response.ok) {
      const error = new Error(data?.error?.message ?? "The request failed."); error.code = data?.error?.code ?? "request-failed"; error.status = response.status; error.snapshot = data?.snapshot; error.kind = kind; throw error;
    }
    return { response, data };
  };
  return Object.freeze({
    async snapshot() { return (await request("/api/v1/snapshot", "plan", { headers: headers("plan") })).data.snapshot; },
    async plan() {
      const response = await fetchImpl("/api/v1/plan", { cache: "no-store", headers: headers("plan") });
      if (!response.ok) return null;
      const etag = response.headers.get("etag");
      return { markdown: await decodeExactUtf8(response), etag, stateVersion: parseResourceStateEtag(etag, "plan") };
    },
    async pollEvents(after, signal) { return (await request(`/api/v1/events?after=${after}`, "plan", { headers: headers("plan"), signal })).data; },
    async mutate(path, method, body) { return (await request(path, "plan", { method, headers: headers("plan", true), body: JSON.stringify(body) })).data; },
    setVersion(version) { planEtag = `\"pi-plan-state-${version}\"`; },
    async specSnapshot() { const result = await request("/api/v1/spec/snapshot", "spec", { headers: headers("spec") }, true); return result.data?.snapshot ?? null; },
    async specMarkdown() { const response = await fetchImpl("/api/v1/spec/markdown", { cache: "no-store", headers: headers("spec") }); if (response.status === 404) return null; if (!response.ok) { const error = new Error("The Spec Markdown could not be loaded."); error.kind = "spec"; throw error; } return decodeExactUtf8(response); },
    async pollSpecEvents(after, signal) { return (await request(`/api/v1/spec/events?after=${after}`, "spec", { headers: headers("spec"), signal })).data; },
    async specMutate(path, method, body) { return (await request(path, "spec", { method, headers: headers("spec", true), body: JSON.stringify(body) })).data; },
    setSpecVersion(version) { specEtag = `\"pi-spec-state-${version}\"`; },
  });
}
async function decodeExactUtf8(response) { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer()); }
function parseResourceStateEtag(value, kind) {
  const match = (kind === "plan" ? /^"pi-plan-state-(0|[1-9]\d*)"$/ : /^"pi-spec-state-(0|[1-9]\d*)"$/).exec(value ?? "");
  if (!match) return null;
  const version = Number(match[1]); return Number.isSafeInteger(version) ? version : null;
}
export function requestId() { const bytes = new Uint8Array(18); crypto.getRandomValues(bytes); return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(""); }
