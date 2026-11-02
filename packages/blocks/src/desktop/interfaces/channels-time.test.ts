import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import { clockTime, dayLabel, lastReplyPhrase } from "./channels-time.ts";

const tl: LiteralMessage = (source, values) => formatMessage(source, values);
const NOW = new Date(2026, 9, 14, 15, 0).getTime();
const LAST_WEEK = new Date(2026, 9, 6, 10, 42).toISOString();
const LAST_MONTH = new Date(2026, 8, 2, 9, 5).toISOString();

describe("channels timestamps", () => {
	test("English keeps the team-chat ordinal style", () => {
		expect(clockTime(LAST_WEEK, "en")).toBe("10:42 AM");
		expect(dayLabel(LAST_WEEK, NOW, "en")).toBe("Tuesday, October 6th");
		expect(lastReplyPhrase(LAST_MONTH, tl, NOW, "en")).toBe("Sep 2nd");
		expect(
			lastReplyPhrase(new Date(2026, 9, 11).toISOString(), tl, NOW, "en")
		).toBe("3 days ago");
	});

	test("German and Japanese use their own date formats", () => {
		expect(clockTime(LAST_WEEK, "de")).toBe("10:42");
		expect(dayLabel(LAST_WEEK, NOW, "de")).toBe("Dienstag, 6. Oktober");
		expect(dayLabel(LAST_WEEK, NOW, "ja")).toBe("10月6日火曜日");
		expect(lastReplyPhrase(LAST_MONTH, tl, NOW, "de")).toBe("2. Sept.");
	});

	test("Arabic formats in its own script, never English", () => {
		const label = dayLabel(LAST_WEEK, NOW, "ar");
		expect(label).not.toMatch(/[A-Za-z]/u);
		expect(label).toContain("أكتوبر");
		expect(clockTime(LAST_WEEK, "ar")).not.toMatch(/AM|PM/u);
	});
});
