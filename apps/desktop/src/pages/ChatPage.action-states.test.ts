import { expect, test } from "bun:test";
import { reuseUnchangedActionStates } from "./ChatPage.helpers.ts";

const buckets = [{ count: 1, emoji: "👍", reactedByMe: true }];
const citations = [{ content: "Prefers tabs", id: "mem-1" }];

test("an unchanged action state keeps its previous object so the turn stays memoised", () => {
	const prior = {
		memoryCitations: citations,
		reactionBuckets: buckets,
		toggleValues: { "learning.feedback": "up" },
	};
	const next = reuseUnchangedActionStates(
		new Map([["m1", prior]]),
		new Map([
			[
				"m1",
				{
					memoryCitations: citations,
					reactionBuckets: buckets,
					toggleValues: { "learning.feedback": "up" },
				},
			],
		])
	);
	expect(next.get("m1")).toBe(prior);
});

test("a new reaction, citation list or rating produces a new action state", () => {
	const prior = {
		reactionBuckets: buckets,
		toggleValues: { "learning.feedback": "up" },
	};
	const previous = new Map([["m1", prior]]);
	const reacted = {
		reactionBuckets: [...buckets],
		toggleValues: prior.toggleValues,
	};
	expect(
		reuseUnchangedActionStates(previous, new Map([["m1", reacted]])).get("m1")
	).toBe(reacted);
	const rated = {
		reactionBuckets: buckets,
		toggleValues: { "learning.feedback": "down" },
	};
	expect(
		reuseUnchangedActionStates(previous, new Map([["m1", rated]])).get("m1")
	).toBe(rated);
	const cited = { ...prior, memoryCitations: citations };
	expect(
		reuseUnchangedActionStates(previous, new Map([["m1", cited]])).get("m1")
	).toBe(cited);
	const cleared = { reactionBuckets: buckets };
	expect(
		reuseUnchangedActionStates(previous, new Map([["m1", cleared]])).get("m1")
	).toBe(cleared);
});
