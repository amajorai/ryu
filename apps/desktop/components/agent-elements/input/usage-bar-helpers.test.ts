import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { formatReset } from "./usage-bar-helpers.tsx";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

const NOW = Date.parse("2026-11-14T12:00:00Z");

describe("formatReset", () => {
	test("an upcoming reset reuses the dashboard's catalogued sentence", () => {
		const reset = formatReset("2026-11-14T15:00:00Z", tl, NOW);
		expect(reset.startsWith("[Resets in {duration}]")).toBe(true);
		expect(reset).toContain("3");
	});

	test("a reset already due reads as soon", () => {
		expect(formatReset("2026-11-14T11:00:00Z", tl, NOW)).toBe("[Resets soon]");
	});

	test("an unknown reset shows nothing", () => {
		expect(formatReset(null, tl, NOW)).toBe("");
		expect(formatReset("not a date", tl, NOW)).toBe("");
	});
});
