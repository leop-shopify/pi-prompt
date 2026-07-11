import { describe, expect, it } from "vitest";
import { parseStrictJsonObject } from "../plan/raw-json.js";

const options = { maxBytes: 1_024, maxDepth: 4 };

describe("parseStrictJsonObject", () => {
  it("accepts one strict JSON object", () => {
    expect(parseStrictJsonObject('{"a":[true,null,-1.2e3]}', options)).toEqual({ ok: true, value: { a: [true, null, -1200] } });
  });

  it.each([
    ['{"a":1,"a":2}', "duplicate-key"],
    ['{"a":1,"\\u0061":2}', "duplicate-key"],
    ['{"outer":{"x":1,"\\u0078":2}}', "duplicate-key"],
    ["```json\n{}\n```", "json-object-required"],
    ["prose {}", "json-object-required"],
    ["\uFEFF{}", "json-bom"],
    ['{} trailing', "json-trailing-data"],
    ['[]', "json-object-required"],
    ['null', "json-object-required"],
    ['{"x":01}', "invalid-json"],
    ['{"x":"\\q"}', "invalid-json"],
  ])("rejects %s safely", (raw, code) => {
    const result = parseStrictJsonObject(raw, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe(code);
  });

  it("enforces depth and UTF-8 bytes before parsing", () => {
    const depth = parseStrictJsonObject('{"a":{"b":{"c":{"d":{}}}}}', options);
    expect(depth.ok).toBe(false);
    if (!depth.ok) expect(depth.issues[0]?.code).toBe("json-too-deep");

    const oversize = parseStrictJsonObject(`{"x":"${"é".repeat(20)}"}`, { maxBytes: 20, maxDepth: 4 });
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) expect(oversize.issues[0]?.code).toBe("json-too-large");
  });

  it("never exposes native parser errors", () => {
    const result = parseStrictJsonObject('{"x":', options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.message).toBe("JSON input is malformed.");
      expect(JSON.stringify(result)).not.toContain("position");
    }
  });
});
