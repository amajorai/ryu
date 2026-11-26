import { expect, test } from "bun:test";
import type { OAuthAccountPoolPolicy } from "@/src/lib/api/pi-config.ts";
import {
	applyOrder,
	MAX_PRIORITY,
	moveBy,
	moveOnto,
	orderByPriority,
	reorderChangesStrategy,
	strategyThatFollowsOrder,
} from "./credential-order.ts";

const rule = (priority: number, enabled = true) => ({ enabled, priority });

test("rows are sorted by saved priority and ties keep the incoming order", () => {
	expect(orderByPriority(["a", "b", "c"], {})).toEqual(["a", "b", "c"]);
	expect(
		orderByPriority(["a", "b", "c"], { a: rule(2), b: rule(0), c: rule(1) })
	).toEqual(["b", "c", "a"]);
	// "c" has no rule, so it shares priority 0 with "a" and stays behind it.
	expect(orderByPriority(["a", "b", "c"], { b: rule(5), a: rule(0) })).toEqual([
		"a",
		"c",
		"b",
	]);
	// Rules for accounts that are not listed do not add rows.
	expect(orderByPriority(["a"], { gone: rule(0) })).toEqual(["a"]);
});

test("move up and down change one place and stop at the ends", () => {
	const order = ["a", "b", "c"];
	expect(moveBy(order, "b", -1)).toEqual(["b", "a", "c"]);
	expect(moveBy(order, "b", 1)).toEqual(["a", "c", "b"]);
	expect(moveBy(order, "a", -1)).toEqual(order);
	expect(moveBy(order, "c", 1)).toEqual(order);
	expect(moveBy(order, "missing", 1)).toEqual(order);
	// The input is never changed in place.
	expect(order).toEqual(["a", "b", "c"]);
});

test("a dropped row lands next to its target on the side it came from", () => {
	const order = ["a", "b", "c", "d"];
	expect(moveOnto(order, "a", "c")).toEqual(["b", "c", "a", "d"]);
	expect(moveOnto(order, "d", "b")).toEqual(["a", "d", "b", "c"]);
	expect(moveOnto(order, "b", "b")).toEqual(order);
	expect(moveOnto(order, "missing", "b")).toEqual(order);
	expect(moveOnto(order, "b", "missing")).toEqual(order);
});

test("a new order under manual moves to a strategy that follows it", () => {
	expect(
		strategyThatFollowsOrder("manual", ["manual", "round_robin", "fill_first"])
	).toBe("fill_first");
	expect(strategyThatFollowsOrder("manual", ["manual", "round_robin"])).toBe(
		"round_robin"
	);
	expect(strategyThatFollowsOrder("manual", ["manual"])).toBe("manual");
	expect(
		strategyThatFollowsOrder("quota_first", ["manual", "fill_first"])
	).toBe("quota_first");
	expect(reorderChangesStrategy("manual", ["manual", "fill_first"])).toBe(true);
	expect(reorderChangesStrategy("round_robin", ["manual", "fill_first"])).toBe(
		false
	);
});

test("the order is written as priorities and nothing else is lost", () => {
	const policy: OAuthAccountPoolPolicy = {
		strategy: "round_robin",
		drainThresholdPercent: 70,
		accounts: {
			a: { enabled: false, priority: 9, drainThresholdPercent: 40 },
			unlisted: { enabled: true, priority: 3 },
		},
	};
	const next = applyOrder(policy, ["b", "a"], ["manual", "round_robin"]);
	expect(next).toEqual({
		strategy: "round_robin",
		drainThresholdPercent: 70,
		accounts: {
			a: { enabled: false, priority: 1, drainThresholdPercent: 40 },
			b: { enabled: true, priority: 0 },
			unlisted: { enabled: true, priority: 3 },
		},
	});
	// The policy that came in is not changed.
	expect(policy.accounts.a?.priority).toBe(9);
	expect(orderByPriority(["a", "b"], next.accounts)).toEqual(["b", "a"]);
});

test("the saved order reads back the same after a round trip through JSON", () => {
	const start: OAuthAccountPoolPolicy = {
		strategy: "manual",
		drainThresholdPercent: 80,
		accounts: {},
	};
	const saved = JSON.stringify(
		applyOrder(start, ["c", "a", "b"], ["manual", "fill_first"])
	);
	const restored: OAuthAccountPoolPolicy = JSON.parse(saved);
	expect(restored.strategy).toBe("fill_first");
	expect(orderByPriority(["a", "b", "c"], restored.accounts)).toEqual([
		"c",
		"a",
		"b",
	]);
});

test("positions past the highest priority Core accepts share that priority", () => {
	const ids = Array.from(
		{ length: MAX_PRIORITY + 3 },
		(_, index) => `k${index}`
	);
	const next = applyOrder(
		{ strategy: "fill_first", drainThresholdPercent: 80, accounts: {} },
		ids,
		["fill_first"]
	);
	expect(next.accounts.k100?.priority).toBe(MAX_PRIORITY);
	expect(next.accounts.k102?.priority).toBe(MAX_PRIORITY);
	// Ties keep the incoming order, so the list still reads back in order.
	expect(orderByPriority(ids, next.accounts)).toEqual(ids);
});
