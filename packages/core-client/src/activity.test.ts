import { expect, it } from "bun:test";
import {
	activityCreateReplySchema,
	activityItemSchema,
	activityItemsSchema,
	activityJsonValueSchema,
	activityListReplySchema,
	activityStreamFrameSchema,
} from "./activity.ts";

const item = {
	id: "activity",
	kind: "future-kind",
	source: "future-source",
	title: "Title",
	body: null,
	agent_id: null,
	session_id: null,
	level: "info",
	metadata: {},
	created_at: 1,
};
it("admits every native metadata JSON shape and retains complete original rows and arrays", () => {
	for (const metadata of [
		null,
		true,
		false,
		1,
		"text",
		[],
		[1, null],
		{},
		JSON.parse('{"__proto__":{"future":true}}'),
	]) {
		const row = { ...item, metadata, future: { nested: [false] } };
		const rows = [row];
		expect(Object.is(activityItemSchema.parse(row), row)).toBe(true);
		expect(Object.is(activityItemSchema.parse(row).metadata, metadata)).toBe(
			true
		);
		expect(Object.is(activityItemsSchema.parse(rows), rows)).toBe(true);
	}
});
it("rejects malformed required fields, invalid own prototype metadata and unsupported native values", () => {
	for (const field of [
		"id",
		"kind",
		"source",
		"title",
		"level",
		"created_at",
		"body",
		"agent_id",
		"session_id",
		"metadata",
	]) {
		expect(
			activityItemSchema.safeParse({ ...item, [field]: undefined }).success
		).toBe(false);
	}
	const sparse = [null];
	Reflect.deleteProperty(sparse, "0");
	for (const metadata of [
		undefined,
		Number.NaN,
		new Date(),
		() => true,
		{ bad: undefined },
		{ bad: 1n },
		sparse,
	]) {
		expect(activityJsonValueSchema.safeParse(metadata).success).toBe(false);
	}
	const invalid = JSON.parse('{"__proto__":null}');
	Object.defineProperty(invalid, "__proto__", {
		value: undefined,
		enumerable: true,
	});
	expect(activityJsonValueSchema.safeParse(invalid).success).toBe(false);
	expect(
		activityItemSchema.safeParse({ ...item, level: "error" }).success
	).toBe(false);
});
it("preserves native numeric overflow rather than modifying successful parsed transport", () => {
	const row = JSON.parse(
		JSON.stringify(item).replace('"metadata":{}', '"metadata":{"future":1e400}')
	);
	expect(Object.is(activityItemSchema.parse(row), row)).toBe(true);
	expect(activityItemSchema.parse(row).metadata).toEqual({
		future: Number.POSITIVE_INFINITY,
	});
});
it("validates both full SSE variants without changing serialized field order", () => {
	for (const frame of [
		{ type: "snapshot", items: [item] },
		{ type: "item", item },
	]) {
		const before = JSON.stringify(frame);
		expect(Object.is(activityStreamFrameSchema.parse(frame), frame)).toBe(true);
		expect(JSON.stringify(activityStreamFrameSchema.parse(frame))).toBe(before);
	}
	expect(
		activityStreamFrameSchema.safeParse({ type: "snapshot", items: [{}] })
			.success
	).toBe(false);
	expect(
		activityStreamFrameSchema.safeParse({ type: "unknown", item }).success
	).toBe(false);
});
it("retains established omitted/null envelope fallbacks and validates available records", () => {
	for (const reply of [
		{},
		{ items: null },
		{ items: [] },
		{ items: [item], error: "partial" },
	]) {
		expect(Object.is(activityListReplySchema.parse(reply), reply)).toBe(true);
	}
	expect(
		activityCreateReplySchema.parse({ item: null, error: "failure" })
	).toEqual({ item: null, error: "failure" });
	expect(activityCreateReplySchema.safeParse({ item: {} }).success).toBe(false);
});
