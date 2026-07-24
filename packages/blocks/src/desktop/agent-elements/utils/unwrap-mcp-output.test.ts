import { describe, expect, it } from "bun:test";
import { unwrapMcpOutput } from "./unwrap-mcp-output.ts";

describe("unwrapMcpOutput", () => {
	it("returns falsy values unchanged", () => {
		expect(unwrapMcpOutput(null)).toBeNull();
		expect(unwrapMcpOutput(undefined)).toBeUndefined();
		expect(unwrapMcpOutput("")).toBe("");
		expect(unwrapMcpOutput(0)).toBe(0);
	});

	it("joins text blocks in an array and parses embedded JSON", () => {
		const out = unwrapMcpOutput([
			{ type: "text", text: '{"a":' },
			{ type: "text", text: "1}" },
		]);
		expect(out).toEqual({ a: 1 });
	});

	it("returns the joined string when array text is not JSON", () => {
		const out = unwrapMcpOutput([
			{ type: "text", text: "hello " },
			{ type: "text", text: "world" },
		]);
		expect(out).toBe("hello world");
	});

	it("returns the original array when it carries no text blocks", () => {
		const arr = [{ type: "image", data: "x" }];
		expect(unwrapMcpOutput(arr)).toBe(arr);
	});

	it("unwraps a single text block, parsing JSON when present", () => {
		expect(unwrapMcpOutput({ type: "text", text: '{"ok":true}' })).toEqual({
			ok: true,
		});
		expect(unwrapMcpOutput({ type: "text", text: "just text" })).toBe(
			"just text"
		);
	});

	it("parses a JSON string, or returns the raw string on parse failure", () => {
		expect(unwrapMcpOutput('[1,2,3]')).toEqual([1, 2, 3]);
		expect(unwrapMcpOutput("not json")).toBe("not json");
	});

	it("returns plain objects untouched", () => {
		const obj = { foo: "bar" };
		expect(unwrapMcpOutput(obj)).toBe(obj);
	});
});
