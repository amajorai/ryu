import { describe, expect, test } from "bun:test";
import { ElementApi, type TElement, type Value } from "platejs";
import { plateValueSchema } from "./plate-value.ts";

describe("the native Plate value boundary", () => {
	test("retains typed future nodes, marks and native metadata by identity", () => {
		const metadata = new Map([["source", "native"]]);
		const value: Value = [
			{
				type: "future-block",
				metadata,
				children: [{ text: "preserved", bold: true, comment: "thread" }],
			},
		];
		expect(Object.is(plateValueSchema.parse(value), value)).toBe(true);
		expect(
			Object.is(plateValueSchema.parse(value)[0]?.metadata, metadata)
		).toBe(true);
	});

	test("repairs only untyped paths using the native default renderer", () => {
		const untouched = {
			type: "p",
			children: [{ text: "unchanged", italic: true }],
		};
		const leaf = { text: "legacy", bold: true };
		const legacy = {
			id: "legacy",
			children: [{ children: [leaf], annotation: "retained" }],
		};
		const parsed = plateValueSchema.parse([untouched, legacy]);
		expect(Object.is(parsed[0], untouched)).toBe(true);
		expect(parsed[1]?.type).toBe("");
		expect(parsed[1]?.id).toBe("legacy");
		expect(parsed[1]?.children[0]).toMatchObject({
			type: "",
			annotation: "retained",
		});
		const child = parsed[1]?.children[0];
		expect(ElementApi.isElement(child)).toBe(true);
		if (!ElementApi.isElement(child)) {
			throw new Error("Expected the repaired nested element");
		}
		expect(Object.is(child.children[0], leaf)).toBe(true);
		expect("type" in legacy).toBe(false);
	});

	test("rejects malformed descendants and text roots without truncating raw input", () => {
		for (const raw of [
			null,
			"legacy",
			[{ text: "root" }],
			[{ type: "p", children: [null] }],
			[{ type: "p", children: [{ text: 42 }] }],
			[{ type: "p", children: "invalid" }],
		]) {
			expect(plateValueSchema.safeParse(raw).success).toBe(false);
		}
	});

	test("rejects child cycles while retaining repeated valid subtrees", () => {
		const cyclic: TElement = { type: "p", children: [] };
		cyclic.children.push(cyclic);
		const value: Value = [cyclic];
		expect(plateValueSchema.safeParse(value).success).toBe(false);
		const repeated = { type: "future-block", children: [{ text: "same" }] };
		const shared: Value = [repeated, repeated];
		expect(Object.is(plateValueSchema.parse(shared), shared)).toBe(true);
	});

	test("accepts the native empty initial editor value", () => {
		const value: Value = [];
		expect(Object.is(plateValueSchema.parse(value), value)).toBe(true);
	});
});
