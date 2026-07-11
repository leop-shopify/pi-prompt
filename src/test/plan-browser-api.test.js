import { describe, expect, it, vi } from "vitest";
import { clearCapability, readCapability } from "../plan/browser/api.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const location = (hash = "") => ({ hash, pathname: "/", search: "" });

describe("browser review capability", () => {
  it("survives refresh in the same port-scoped session storage", () => {
    const capability = "a".repeat(43);
    const session = storage();
    const history = { replaceState: vi.fn() };

    expect(readCapability(location(`#capability=${capability}`), history, session)).toBe(capability);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(readCapability(location(), history, session)).toBe(capability);
  });

  it("does not cross into another port origin and clears when review ends", () => {
    const capability = "b".repeat(43);
    const firstPort = storage();
    const otherPort = storage();
    const history = { replaceState: vi.fn() };

    expect(readCapability(location(`#capability=${capability}`), history, firstPort)).toBe(capability);
    expect(readCapability(location(), history, otherPort)).toBeNull();
    clearCapability(firstPort);
    expect(readCapability(location(), history, firstPort)).toBeNull();
  });

  it("rejects malformed stored capabilities", () => {
    const session = storage();
    session.setItem("pi-prompt-review-capability", "not-a-capability");
    expect(readCapability(location(), { replaceState: vi.fn() }, session)).toBeNull();
  });
});
