import { expect, test } from "bun:test";
import {
	indexMessagesById,
	reuseUnchangedReadReceipts,
} from "./ChatPage.helpers.ts";

const reader = { avatar: "a.png", id: "u1", name: "Ada" };

test("an unchanged receipt keeps its previous object so the turn stays memoised", () => {
	const previous = new Map([["m1", { delivered: true, readers: [reader] }]]);
	const next = reuseUnchangedReadReceipts(
		previous,
		new Map([["m1", { delivered: true, readers: [{ ...reader }] }]])
	);
	expect(next.get("m1")).toBe(previous.get("m1"));
});

test("a new reader produces a new receipt object", () => {
	const previous = new Map([["m1", { delivered: true, readers: [reader] }]]);
	const fresh = {
		delivered: true,
		readers: [reader, { id: "u2", name: "Grace" }],
	};
	const next = reuseUnchangedReadReceipts(previous, new Map([["m1", fresh]]));
	expect(next.get("m1")).toBe(fresh);
});

test("indexing messages by id finds each message and keeps the first duplicate", () => {
	const first = { id: "m1", role: "user" };
	const index = indexMessagesById([
		first,
		{ id: "m2", role: "assistant" },
		{ id: "m1", role: "assistant" },
	]);
	expect(index.get("m1")).toBe(first);
	expect(index.get("m2")?.role).toBe("assistant");
	expect(index.get("missing")).toBeUndefined();
	expect(index.size).toBe(2);
});
