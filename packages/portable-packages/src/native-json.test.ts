import { expect, it } from "bun:test";
import { nativeJsonSchema } from "./native-json.ts";

it("preserves native JSON identity, overflow and literal own keys", () => {
	const value = JSON.parse(
		'{"__proto__":{"safe":true},"nested":[1e400,-1e400,null,true,"text"]}'
	);
	const decoded = nativeJsonSchema.parse(value);
	expect(decoded).toBe(value);
	expect(JSON.stringify(decoded)).toBe(
		'{"__proto__":{"safe":true},"nested":[null,null,null,true,"text"]}'
	);
	expect(Object.hasOwn(new Object(decoded), "__proto__")).toBe(true);
});
it("accepts repeated references but rejects cycles and non-JSON leaves", () => {
	const shared = { value: 1 };
	const repeated = [shared, shared];
	expect(nativeJsonSchema.parse(repeated)).toBe(repeated);
	const cycle: object[] = [];
	cycle.push(cycle);
	expect(nativeJsonSchema.safeParse(cycle).success).toBe(false);
	for (const value of [
		undefined,
		Number.NaN,
		1n,
		Symbol("value"),
		() => null,
		{ value: undefined },
		[undefined],
	]) {
		expect(nativeJsonSchema.safeParse(value).success).toBe(false);
	}
});
it("accepts deeply nested values supported by native JSON without adding a depth cap", () => {
	const encoded = `${"[".repeat(9998)}null${"]".repeat(9998)}`;
	const value = JSON.parse(encoded);
	expect(JSON.stringify(value)).toBe(encoded);
	expect(nativeJsonSchema.parse(value)).toBe(value);
});

it("retains the existing native object admission for empty exotic containers", () => {
	for (const value of [new Date(), new Map()]) {
		expect(Object.is(nativeJsonSchema.parse(value), value)).toBe(true);
	}
});
