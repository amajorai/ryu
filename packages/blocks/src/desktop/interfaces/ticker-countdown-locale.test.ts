// The Ticker countdown reads in the UI language: English keeps the compact
// "in 5m" board form, other locales use their narrow relative-time phrasing.

import { describe, expect, test } from "bun:test";
import { countdown } from "./ticker-model.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();

describe("ticker countdown", () => {
	test("English keeps the compact form, rounded down", () => {
		expect(countdown(at(5.9), NOW, "en")).toBe("in 5m");
		expect(countdown(at(3 * 60 + 59), NOW, "en-US")).toBe("in 3h");
		expect(countdown(at(2 * 24 * 60), NOW, "en")).toBe("in 2d");
		expect(countdown(at(0.5), NOW, "en")).toBe("now");
	});

	test("Japanese and Arabic read in their own language", () => {
		const ja = new Intl.RelativeTimeFormat("ja", {
			numeric: "always",
			style: "narrow",
		});
		const ar = new Intl.RelativeTimeFormat("ar", {
			numeric: "always",
			style: "narrow",
		});
		expect(countdown(at(5), NOW, "ja")).toBe(ja.format(5, "minute"));
		expect(countdown(at(3 * 60), NOW, "ja")).toBe(ja.format(3, "hour"));
		expect(countdown(at(2 * 24 * 60), NOW, "ar")).toBe(ar.format(2, "day"));
		expect(countdown(at(5), NOW, "ar")).not.toContain("in ");
		expect(countdown(at(0), NOW, "ja")).toBe(
			new Intl.RelativeTimeFormat("ja", {
				numeric: "auto",
				style: "narrow",
			}).format(0, "second")
		);
	});
});
