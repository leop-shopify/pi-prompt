import type { ValidationIssue, ValidationResult } from "./types.js";

export interface StrictJsonOptions {
  readonly maxBytes: number;
  readonly maxDepth: number;
}

/** Strictly parses one JSON object while rejecting duplicate decoded object keys. */
export function parseStrictJsonObject(
  raw: string,
  options: StrictJsonOptions,
): ValidationResult<Readonly<Record<string, unknown>>> {
  if (!validLimit(options.maxBytes) || !validLimit(options.maxDepth)) {
    return failure("invalid-options", "JSON parser limits must be positive safe integers.");
  }
  if (Buffer.byteLength(raw, "utf8") > options.maxBytes) {
    return failure("json-too-large", "JSON input exceeds the UTF-8 byte limit.");
  }
  if (raw.startsWith("\uFEFF")) return failure("json-bom", "JSON input must not begin with a BOM.");

  try {
    const scanner = new JsonScanner(raw, options.maxDepth);
    scanner.parseRootObject();
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed)) return failure("json-object-required", "JSON input must be an object.");
    return { ok: true, value: parsed };
  } catch (error: unknown) {
    if (error instanceof StrictJsonFailure) return failure(error.code, error.safeMessage);
    return failure("invalid-json", "JSON input is malformed.");
  }
}

class StrictJsonFailure extends Error {
  constructor(readonly code: string, readonly safeMessage: string) { super(code); }
}

class JsonScanner {
  #index = 0;
  constructor(private readonly raw: string, private readonly maxDepth: number) {}

  parseRootObject(): void {
    this.#whitespace();
    if (this.#peek() !== "{") this.#fail("json-object-required", "JSON input must be an object.");
    this.#object(1);
    this.#whitespace();
    if (this.#index !== this.raw.length) this.#fail("json-trailing-data", "JSON input contains trailing data.");
  }

  #value(depth: number): void {
    const token = this.#peek();
    if (token === "{") this.#object(depth);
    else if (token === "[") this.#array(depth);
    else if (token === "\"") { this.#string(); }
    else if (token === "t") this.#literal("true");
    else if (token === "f") this.#literal("false");
    else if (token === "n") this.#literal("null");
    else if (token === "-" || isDigit(token)) this.#number();
    else this.#fail("invalid-json", "JSON input is malformed.");
  }

  #object(depth: number): void {
    this.#depth(depth);
    this.#consume("{");
    this.#whitespace();
    const keys = new Set<string>();
    if (this.#peek() === "}") { this.#index += 1; return; }
    while (true) {
      if (this.#peek() !== "\"") this.#fail("invalid-json", "JSON input is malformed.");
      const key = this.#string();
      if (keys.has(key)) this.#fail("duplicate-key", "JSON objects must not contain duplicate decoded keys.");
      keys.add(key);
      this.#whitespace();
      this.#consume(":");
      this.#whitespace();
      this.#value(depth + 1);
      this.#whitespace();
      if (this.#peek() === "}") { this.#index += 1; return; }
      this.#consume(",");
      this.#whitespace();
    }
  }

  #array(depth: number): void {
    this.#depth(depth);
    this.#consume("[");
    this.#whitespace();
    if (this.#peek() === "]") { this.#index += 1; return; }
    while (true) {
      this.#value(depth + 1);
      this.#whitespace();
      if (this.#peek() === "]") { this.#index += 1; return; }
      this.#consume(",");
      this.#whitespace();
    }
  }

  #string(): string {
    const start = this.#index;
    this.#consume("\"");
    while (this.#index < this.raw.length) {
      const character = this.raw[this.#index];
      if (character === "\"") {
        this.#index += 1;
        const token = this.raw.slice(start, this.#index);
        try {
          const decoded: unknown = JSON.parse(token);
          if (typeof decoded === "string") return decoded;
        } catch { /* replaced by stable error below */ }
        this.#fail("invalid-json", "JSON input is malformed.");
      }
      if (character === "\\") {
        this.#index += 1;
        const escape = this.raw[this.#index];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.raw.slice(this.#index + 1, this.#index + 5))) {
            this.#fail("invalid-json", "JSON input is malformed.");
          }
          this.#index += 5;
          continue;
        }
        if (escape === "\"" || escape === "\\" || escape === "/" || escape === "b" || escape === "f" || escape === "n" || escape === "r" || escape === "t") {
          this.#index += 1;
          continue;
        }
        this.#fail("invalid-json", "JSON input is malformed.");
      }
      if (character === undefined || character.charCodeAt(0) <= 0x1f) this.#fail("invalid-json", "JSON input is malformed.");
      this.#index += 1;
    }
    this.#fail("invalid-json", "JSON input is malformed.");
  }

  #number(): void {
    if (this.#peek() === "-") this.#index += 1;
    if (this.#peek() === "0") this.#index += 1;
    else {
      if (!isOneToNine(this.#peek())) this.#fail("invalid-json", "JSON input is malformed.");
      while (isDigit(this.#peek())) this.#index += 1;
    }
    if (this.#peek() === ".") {
      this.#index += 1;
      if (!isDigit(this.#peek())) this.#fail("invalid-json", "JSON input is malformed.");
      while (isDigit(this.#peek())) this.#index += 1;
    }
    if (this.#peek() === "e" || this.#peek() === "E") {
      this.#index += 1;
      if (this.#peek() === "+" || this.#peek() === "-") this.#index += 1;
      if (!isDigit(this.#peek())) this.#fail("invalid-json", "JSON input is malformed.");
      while (isDigit(this.#peek())) this.#index += 1;
    }
  }

  #literal(literal: string): void {
    if (this.raw.slice(this.#index, this.#index + literal.length) !== literal) this.#fail("invalid-json", "JSON input is malformed.");
    this.#index += literal.length;
  }

  #depth(depth: number): void {
    if (depth > this.maxDepth) this.#fail("json-too-deep", "JSON nesting exceeds the depth limit.");
  }

  #consume(expected: string): void {
    if (this.#peek() !== expected) this.#fail("invalid-json", "JSON input is malformed.");
    this.#index += 1;
  }

  #whitespace(): void {
    while (this.#peek() === " " || this.#peek() === "\n" || this.#peek() === "\r" || this.#peek() === "\t") this.#index += 1;
  }

  #peek(): string | undefined { return this.raw[this.#index]; }
  #fail(code: string, message: string): never { throw new StrictJsonFailure(code, message); }
}

function validLimit(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function isDigit(value: string | undefined): boolean { return value !== undefined && value >= "0" && value <= "9"; }
function isOneToNine(value: string | undefined): boolean { return value !== undefined && value >= "1" && value <= "9"; }
function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function failure<T = never>(code: string, message: string): ValidationResult<T> {
  const issue: ValidationIssue = { path: "$", code, message };
  return { ok: false, issues: [issue] };
}
