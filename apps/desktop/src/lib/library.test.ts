// Tests for the Library store's timestamp normaliser and path→ref mapping. The
// normaliser is load-bearing for Recents and cross-type sort: the data hooks
// report time in three different shapes (epoch ms numbers, ISO strings, and
// nullable/missing values), and sorting raw mixed values gives garbage.

import { describe, expect, it } from "bun:test";
import { normalizeTimestamp } from "@/src/lib/library.ts";

describe("normalizeTimestamp", () => {
	it("passes through epoch-millisecond numbers", () => {
		const ms = 1_700_000_000_000; // 2023-11-14, in ms
		expect(normalizeTimestamp(ms)).toBe(ms);
	});

	it("upconverts plausibly-seconds epochs to milliseconds", () => {
		const secs = 1_700_000_000; // same instant, in seconds
		expect(normalizeTimestamp(secs)).toBe(secs * 1000);
	});

	it("parses ISO strings to epoch ms", () => {
		expect(normalizeTimestamp("2023-11-14T22:13:20.000Z")).toBe(
			1_700_000_000_000
		);
	});

	it("falls back to 0 for null, undefined, empty, and unparseable", () => {
		expect(normalizeTimestamp(null)).toBe(0);
		expect(normalizeTimestamp(undefined)).toBe(0);
		expect(normalizeTimestamp("")).toBe(0);
		expect(normalizeTimestamp("not a date")).toBe(0);
	});
});

describe("cross-type recency sort", () => {
	// Interleave the three timestamp shapes the way the real hooks emit them:
	// a chat (epoch ms), a workflow (ISO string), and an agent (no time → 0).
	// Sorting by normalised value must order newest-first with the agent last,
	// regardless of the raw shapes.
	it("orders newest-first and sinks timeless items (agents) to the end", () => {
		const items = [
			{ id: "agent", raw: null as unknown }, // no updatedAt
			{ id: "chat", raw: 1_700_000_500_000 }, // newest, epoch ms
			{ id: "workflow", raw: "2023-11-14T22:13:20.000Z" }, // older, ISO
		];
		const ordered = [...items]
			.map((i) => ({ ...i, ts: normalizeTimestamp(i.raw) }))
			.sort((a, b) => b.ts - a.ts)
			.map((i) => i.id);
		expect(ordered).toEqual(["chat", "workflow", "agent"]);
	});
});
