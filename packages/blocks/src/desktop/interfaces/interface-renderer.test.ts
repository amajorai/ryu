import { describe, expect, test } from "bun:test";
import {
	compactAge,
	formatNameList,
	fullTimestamp,
	relativeAge,
	threadStatusLabel,
} from "./interface-renderer.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const FIVE_MIN = new Date(NOW - 5 * 60_000).toISOString();
const THREE_DAYS = new Date(NOW - 3 * 86_400_000).toISOString();

describe("interface time and list helpers", () => {
	test("compact ages keep the English list badges", () => {
		expect(compactAge(new Date(NOW - 10_000).toISOString(), NOW, "en")).toBe(
			"now"
		);
		expect(compactAge(FIVE_MIN, NOW, "en")).toBe("5m");
		expect(compactAge(THREE_DAYS, NOW, "en")).toBe("3d");
		expect(compactAge("not a date", NOW, "en")).toBe("");
	});

	test("compact ages use each locale's narrow units", () => {
		expect(compactAge(FIVE_MIN, NOW, "ja")).toBe("5分");
		expect(compactAge(FIVE_MIN, NOW, "de")).not.toContain("m ");
		expect(compactAge(FIVE_MIN, NOW, "de")).toMatch(/^5\s?Min/u);
	});

	test("relative ages read as whole phrases, never English inside another language", () => {
		expect(relativeAge(FIVE_MIN, NOW, "en")).toBe("5m ago");
		expect(relativeAge(new Date(NOW + 60_000).toISOString(), NOW, "en")).toBe(
			"now"
		);
		expect(relativeAge(FIVE_MIN, NOW, "ja")).toBe("5分前");
		expect(relativeAge(THREE_DAYS, NOW, "de")).toBe("vor 3 Tagen");
	});

	test("name lists and timestamps follow the locale", () => {
		expect(formatNameList(["Ada", "Grace"], "en")).toBe("Ada and Grace");
		expect(formatNameList(["Ada", "Grace"], "de")).toBe("Ada und Grace");
		expect(fullTimestamp(FIVE_MIN, "de")).not.toMatch(/AM|PM/u);
		expect(fullTimestamp("nope", "en")).toBe("");
	});

	test("status labels format in English before a provider mounts", () => {
		expect(threadStatusLabel("attention")).toBe("Needs attention");
		expect(threadStatusLabel("your-turn")).toBe("Your turn");
	});
});
