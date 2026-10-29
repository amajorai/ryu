import { describe, expect, it } from "bun:test";
import {
	parseStoredConversationCounts,
	parseStoredConversationIds,
} from "./conversation-flags-storage.ts";

describe("conversation flag storage boundary", () => {
	it("round-trips complete native string IDs and duplicate order", () => {
		const ids = new Set(["", " ", "constructor", "__proto__", "chat", "😀"]);
		expect([...parseStoredConversationIds(JSON.stringify([...ids]))]).toEqual([
			...ids,
		]);
		expect([...parseStoredConversationIds('["b","a","b"]')]).toEqual([
			"b",
			"a",
		]);
	});

	it("refuses malformed roots and omits nonstring cells without dropping valid IDs", () => {
		for (const stored of [null, "", "{", '"chat"', "null", "{}", "42"]) {
			expect(parseStoredConversationIds(stored).size).toBe(0);
		}
		expect([
			...parseStoredConversationIds('["chat",null,3,{},[],true,"", "other"]'),
		]).toEqual(["chat", "", "other"]);
	});

	it("round-trips native counts and retains last valid duplicates and negative zero", () => {
		const counts = new Map([
			["chat", 7],
			["constructor", Number.MAX_SAFE_INTEGER],
			["__proto__", 0],
		]);
		expect([
			...parseStoredConversationCounts(JSON.stringify([...counts])),
		]).toEqual([...counts]);
		const parsed = parseStoredConversationCounts(
			'[["chat",2],["chat",4],["chat",-1],["zero",-0]]'
		);
		expect([...parsed.keys()]).toEqual(["chat", "zero"]);
		expect(parsed.get("chat")).toBe(4);
		expect(Object.is(parsed.get("zero"), -0)).toBe(true);
	});

	it("omits invalid count rows while preserving valid rows", () => {
		const stored =
			'[["ok",1],["",2],["extra",1,2],["fraction",1.5],["negative",-1],["unsafe",9007199254740992],["infinite",1e400],["null",null],["text","2"],[3,4],null,{},["later",3]]';
		expect([...parseStoredConversationCounts(stored)]).toEqual([
			["ok", 1],
			["later", 3],
		]);
		for (const root of [null, "", "{", '"chat"', "null", "{}", "42"]) {
			expect(parseStoredConversationCounts(root).size).toBe(0);
		}
	});
});
