import { describe, expect, it } from "bun:test";
import {
	normalizeAssistantToolParts,
	normalizeToolPart,
} from "./tool-part-normalizer.ts";

describe("normalizeToolPart", () => {
	it("returns non-record values unchanged", () => {
		expect(normalizeToolPart("x")).toBe("x");
		expect(normalizeToolPart(null)).toBeNull();
		expect(normalizeToolPart(42)).toBe(42);
	});

	it("passes through parts whose type is not a tool part", () => {
		const part = { type: "text", input: '{"a":1}' };
		expect(normalizeToolPart(part)).toBe(part);
	});

	it("parses JSON-string input/output/result on a tool part", () => {
		const part = {
			type: "tool-Bash",
			input: '{"command":"ls"}',
			output: '{"stdout":"a"}',
			result: '[1,2]',
		};
		const normalized = normalizeToolPart(part) as Record<string, unknown>;
		expect(normalized).not.toBe(part);
		expect(normalized.input).toEqual({ command: "ls" });
		expect(normalized.output).toEqual({ stdout: "a" });
		expect(normalized.result).toEqual([1, 2]);
	});

	it("returns the same reference when nothing needs parsing", () => {
		const part = { type: "tool-Bash", input: { command: "ls" }, output: 5 };
		expect(normalizeToolPart(part)).toBe(part);
	});

	it("leaves a non-JSON string field as-is", () => {
		const part = { type: "tool-Bash", input: "plain text" };
		expect(normalizeToolPart(part)).toBe(part);
	});

	it("does not treat a JSON scalar string as structured", () => {
		// parseStructuredJson only upgrades objects/arrays, not bare scalars.
		const part = { type: "tool-Bash", input: "42" };
		expect(normalizeToolPart(part)).toBe(part);
	});

	it("only rewrites the fields that actually changed", () => {
		const part = {
			type: "tool-Bash",
			input: '{"a":1}',
			output: { already: "object" },
		};
		const normalized = normalizeToolPart(part) as Record<string, unknown>;
		expect(normalized.input).toEqual({ a: 1 });
		// unchanged field keeps its identity
		expect(normalized.output).toBe(part.output);
	});
});

describe("normalizeAssistantToolParts", () => {
	it("returns the same array when no part changed", () => {
		const parts = [{ type: "text" }, { type: "tool-Bash", input: { a: 1 } }];
		expect(normalizeAssistantToolParts(parts)).toBe(parts);
	});

	it("returns a new array when at least one part changed", () => {
		const parts = [{ type: "tool-Bash", input: '{"a":1}' }];
		const out = normalizeAssistantToolParts(parts);
		expect(out).not.toBe(parts);
		expect((out[0] as { input: unknown }).input).toEqual({ a: 1 });
	});
});
