import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { formatMessage } from "./format.ts";

// The schema `formatMessage` used to parse values with. The runtime check is
// hand-written so the formatter (on every `t()` call) needs no schema library;
// this keeps the two in agreement on what they accept and what they produce.
const zodMessageValues = z.record(
	z.string(),
	z.union([z.json(), z.date(), z.bigint(), z.undefined()])
);

class Point {
	x = 1;
}

const nullPrototype = Object.assign(Object.create(null), { a: "plain" });
const withSymbol = { a: "x", [Symbol("s")]: "y" };
const withHidden = Object.defineProperty({ a: "x" }, "hidden", {
	enumerable: false,
	value: () => "function",
});
const withProtoKey = JSON.parse('{"a":"x","__proto__":{"polluted":true}}');
const inherited = Object.create({ a: "inherited" });
const sparse: number[] = [1];
sparse[2] = 3;

const CASES: [string, unknown][] = [
	["empty", {}],
	["strings", { a: "x", b: "y" }],
	["numbers", { a: 1, b: -0, c: 1.5 }],
	["NaN", { a: Number.NaN }],
	["Infinity", { a: Number.POSITIVE_INFINITY }],
	["booleans and null", { a: true, b: null }],
	["undefined", { a: undefined }],
	["bigint", { a: 10n }],
	["date", { a: new Date(0) }],
	["invalid date", { a: new Date(Number.NaN) }],
	["array", { a: [1, "two", [3]] }],
	["array with undefined", { a: [1, undefined] }],
	["sparse array", { a: sparse }],
	["array with date", { a: [new Date(0)] }],
	["nested record", { a: { b: { c: 1 } } }],
	["nested undefined", { a: { b: undefined } }],
	["nested bigint", { a: { b: 1n } }],
	["class instance", { a: new Point() }],
	["map", { a: new Map() }],
	["function", { a: () => "x" }],
	["symbol value", { a: Symbol("x") }],
	["null prototype value", { a: nullPrototype }],
	["symbol key", withSymbol],
	["non-enumerable function", withHidden],
	["__proto__ key", withProtoKey],
	["inherited only", inherited],
	["top-level null prototype", nullPrototype],
	["top-level array", ["a"]],
	["top-level null", null],
	["top-level string", "x"],
	["top-level date", new Date(0)],
	["top-level class", new Point()],
];

function formatted(values: unknown): string | Error {
	try {
		return formatMessage("{a}|{b}|{c}", values);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

describe("message values", () => {
	for (const [name, values] of CASES) {
		test(`accepts and formats ${name} as the schema did`, () => {
			const parsed = zodMessageValues.safeParse(values);
			const output = formatted(values);
			expect(output instanceof Error).toBe(!parsed.success);
			if (parsed.success) {
				expect(output).toBe(
					["a", "b", "c"]
						.map((key) => {
							const value = parsed.data[key];
							return value === null || value === undefined ? "" : String(value);
						})
						.join("|")
				);
			}
		});
	}

	test("formats a copy, so a null-prototype record still stringifies", () => {
		expect(formatMessage("{a}", { a: nullPrototype })).toBe("[object Object]");
	});
});
