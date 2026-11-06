import { describe, expect, test } from "bun:test";
import { defaultInputDir } from "./input-direction.ts";

describe("defaultInputDir", () => {
	test.each([
		["email"],
		["url"],
		["tel"],
		["password"],
		["URL"],
	])("type=%s is left to right", (type) => {
		expect(defaultInputDir({ type })).toBe("ltr");
	});

	test.each([
		["code"],
		["code-caption"],
		["verification-code"],
	])("variant=%s is left to right", (variant) => {
		expect(defaultInputDir({ variant })).toBe("ltr");
	});

	test("an LTR type wins over a prose variant", () => {
		expect(defaultInputDir({ type: "email", variant: "muted" })).toBe("ltr");
	});

	test.each([
		[{}],
		[{ type: "text" }],
		[{ type: "search" }],
		[{ type: "number" }],
		[{ variant: "default" }],
		[{ variant: "muted" }],
		[{ type: null, variant: null }],
	])("%o resolves by content", (input) => {
		expect(defaultInputDir(input)).toBe("auto");
	});
});
