import { expect, test } from "bun:test";
import { parseHostArguments } from "./host-json.ts";

test("host arguments preserve HTTP JSON omission and null semantics", () => {
	expect(
		parseHostArguments({
			prompt: "hello",
			optional: undefined,
			nested: { value: null },
			list: [undefined, 2],
		})
	).toEqual({ prompt: "hello", nested: { value: null }, list: [null, 2] });
	expect(parseHostArguments(undefined)).toBeUndefined();
	expect(parseHostArguments({ value: Number.POSITIVE_INFINITY })).toEqual({
		value: null,
	});
});

test("host arguments reject unserializable values before privileged dispatch", () => {
	expect(() => parseHostArguments({ value: BigInt(1) })).toThrow();
});
