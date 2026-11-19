import { describe, expect, test } from "bun:test";
import {
	canonicalJson,
	entryHash,
	isJsonObject,
	sameEntry,
} from "./agentConnect-types.ts";

describe("agent entry comparison", () => {
	test("key order never changes equality or the recorded hash", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
			'{"a":{"c":3,"d":2},"b":1}'
		);
		expect(sameEntry({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(entryHash({ a: 1, b: 2 })).toBe(entryHash({ b: 2, a: 1 }));
		expect(isJsonObject([])).toBe(false);
	});
});
