import { describe, expect, test } from "bun:test";
import {
	parseProofJson as parseWebJson,
	parseProofJsonRecord as parseWebRecord,
} from "../../web/e2e/fixture-json.ts";
import { parseProofJson, parseProofJsonRecord } from "./fixture-json.ts";

for (const [surface, parseJson, parseRecord] of [
	["desktop", parseProofJson, parseProofJsonRecord],
	["web", parseWebJson, parseWebRecord],
] as const) {
	describe(`${surface} fixture JSON boundary`, () => {
		test("preserves invalid domain fields for negative application tests", () => {
			const payload = {
				value: 42,
				enabled: "wrong",
				scopes: null,
				unknown: ["kept"],
			};
			expect(parseJson(JSON.stringify(payload))).toEqual(payload);
			expect(parseRecord(JSON.stringify(payload))).toEqual(payload);
			expect(parseJson("null")).toBeNull();
			expect(parseJson('["wrong-domain-type"]')).toEqual(["wrong-domain-type"]);
		});

		test("retains hostile field names without changing object prototypes", () => {
			const raw = '{"__proto__":{"polluted":true},"constructor":"kept"}';
			const record = parseRecord(raw);
			expect(Object.hasOwn(record, "__proto__")).toBe(true);
			expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
			expect(JSON.stringify(parseJson(raw))).toBe(raw);
		});

		test("rejects malformed JSON and non-records at record-only boundaries", () => {
			expect(() => parseJson("{")).toThrow();
			expect(() => parseRecord("[]")).toThrow();
			expect(() => parseRecord("null")).toThrow();
			expect(() => parseRecord('"object expected"')).toThrow();
		});
	});
}
