import { describe, expect, test } from "bun:test";
import { formatList } from "./format-list.ts";

describe("formatList", () => {
	test("joins English with a final conjunction", () => {
		expect(formatList(["a", "b", "c"], "conjunction", "en")).toBe(
			"a, b, and c"
		);
		expect(formatList(["a", "b"], "disjunction", "en")).toBe("a or b");
		expect(formatList(["only"], "conjunction", "en")).toBe("only");
		expect(formatList([], "conjunction", "en")).toBe("");
	});

	test("uses the Japanese list separator", () => {
		expect(formatList(["モデル", "地域", "権限"], "conjunction", "ja")).toBe(
			"モデル、地域、権限"
		);
	});

	test("uses German punctuation and conjunction", () => {
		expect(
			formatList(["Modelle", "Regionen", "Rechte"], "conjunction", "de")
		).toBe("Modelle, Regionen und Rechte");
		expect(formatList(["A", "B"], "disjunction", "de")).toBe("A oder B");
	});

	test("falls back to English for an unusable tag", () => {
		expect(formatList(["a", "b"], "conjunction", "not a locale")).toBe(
			"a and b"
		);
	});

	test("defaults to the active locale, English before a provider mounts", () => {
		expect(formatList(["a", "b"])).toBe("a and b");
	});
});
