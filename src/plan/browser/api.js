const ORIGIN_HEADER = "X-Pi-Prompt-Origin";
const CAPABILITY_STORAGE_KEY = "pi-prompt-review-capability";
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function readCapability(locationObject = window.location, historyObject = window.history, storageObject = window.sessionStorage) {
  const match = /^#capability=([A-Za-z0-9_-]{43})$/.exec(locationObject.hash);
  historyObject.replaceState(null, "", `${locationObject.pathname}${locationObject.search}`);
  if (match) {
    try { storageObject.setItem(CAPABILITY_STORAGE_KEY, match[1]); } catch { /* keep the fragment capability in memory for this page */ }
    return match[1];
  }
  try {
    const stored = storageObject.getItem(CAPABILITY_STORAGE_KEY);
    return typeof stored === "string" && CAPABILITY_PATTERN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function clearCapability(storageObject = window.sessionStorage) {
  try { storageObject.removeItem(CAPABILITY_STORAGE_KEY); } catch { /* the server still invalidates the closed review */ }
}

export function createPlanApi(capability, fetchImpl = window.fetch.bind(window)) {
  let etag = null;
  const headers = (mutation = false) => ({
    Authorization: `Bearer ${capability}`,
    [ORIGIN_HEADER]: window.location.origin,
    ...(mutation ? { "Content-Type": "application/json", "If-Match": etag } : {}),
  });
  const request = async (path, options = {}) => {
    const response = await fetchImpl(path, { cache: "no-store", ...options });
    if (response.status === 204) return { response, data: null };
    const data = await response.json().catch(() => ({ error: { code: "invalid-response", message: "Pi returned an invalid response." } }));
    if (!response.ok) {
      const error = new Error(data?.error?.message ?? "The request failed.");
      error.code = data?.error?.code ?? "request-failed";
      error.status = response.status;
      error.snapshot = data?.snapshot;
      throw error;
    }
    const next = response.headers.get("etag");
    if (next) etag = next;
    return { response, data };
  };
  return Object.freeze({
    async snapshot() { const result = await request("/api/v1/snapshot", { headers: headers() }); return result.data.snapshot; },
    async plan() {
      const response = await fetchImpl("/api/v1/plan", { cache: "no-store", headers: headers() });
      if (!response.ok) return null;
      return response.text();
    },
    async pollEvents(after, signal) { const result = await request(`/api/v1/events?after=${after}`, { headers: headers(), signal }); return result.data; },
    async mutate(path, method, body) { const result = await request(path, { method, headers: headers(true), body: JSON.stringify(body) }); return result.data; },
    setVersion(stateVersion) { etag = `\"pi-plan-state-${stateVersion}\"`; },
  });
}

export function requestId() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
