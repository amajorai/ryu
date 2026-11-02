import { expect, test } from "bun:test";
import {
	COUNTDOWN_EXPIRED,
	formatCountdown,
	formatDurationSpan,
} from "./expiry.ts";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

test("English keeps the compact countdown form", () => {
	expect(formatCountdown(at(23), NOW, "en")).toBe("23m");
	expect(formatCountdown(at(4 * 60), NOW, "en")).toBe("4h");
	expect(formatCountdown(at((12 * 24 + 18) * 60), NOW, "en")).toBe("12d 18h");
	expect(formatCountdown(at(-1), NOW, "en")).toBe(COUNTDOWN_EXPIRED);
	expect(formatCountdown("not a date", NOW, "en")).toBe("");
});

test("Japanese countdowns use Japanese units with no unit gap", () => {
	expect(formatCountdown(at(23), NOW, "ja")).toBe("23分");
	expect(formatCountdown(at(4 * 60), NOW, "ja")).toBe("4時間");
	const days = formatCountdown(at((2 * 24 + 4) * 60), NOW, "ja");
	expect(days).toBe("2日 4時間");
	expect(days).not.toMatch(/[dhm]\b/u);
});

test("Arabic countdowns use the locale's own digits and units", () => {
	const text = formatDurationSpan(
		[
			[2, "day"],
			[4, "hour"],
		],
		"ar"
	);
	expect(text).not.toMatch(/[a-z]/u);
	expect(text).toContain(new Intl.NumberFormat("ar").format(4));
});
