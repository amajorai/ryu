import { expect, test } from "bun:test";
import { reuseUnchangedReadReceipts } from "./ChatPage.helpers.ts";

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
