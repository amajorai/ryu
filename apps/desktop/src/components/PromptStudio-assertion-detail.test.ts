import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import { assertionDetailText } from "./PromptStudio-assertion-detail.ts";

const DE: Record<string, string> = {
	'Missing "{value}"': "„{value}“ fehlt",
	"Invalid regular expression /{pattern}/":
		"Ungültiger regulärer Ausdruck /{pattern}/",
	"Negated: {detail}": "Negiert: {detail}",
	"Similarity {score}; threshold {threshold}":
		"Ähnlichkeit {score}; Schwellenwert {threshold}",
};

const de: LiteralMessage = (source, values) =>
	formatMessage(DE[source] ?? source, values, "de");

const JA: Record<string, string> = {
	"Similarity inputs are limited to {limit} characters":
		"類似度の入力は {limit} 文字までです",
	"Matched /{pattern}/": "/{pattern}/ に一致",
};

const ja: LiteralMessage = (source, values) =>
	formatMessage(JA[source] ?? source, values, "ja");

const AR: Record<string, string> = {
	'Unexpectedly found "{value}"': 'تم العثور على "{value}" بشكل غير متوقع',
	"Negated: {detail}": "معكوس: {detail}",
};

const ar: LiteralMessage = (source, values) =>
	formatMessage(AR[source] ?? source, values, "ar");

const FSI = "\u2068";
const PDI = "\u2069";

const BASE = { kind: "contains", pass: false, score: 0 };

describe("assertionDetailText", () => {
	test("formats similarity with the German decimal comma", () => {
		expect(
			assertionDetailText(
				{
					...BASE,
					code: "similarity.score",
					detail: "similarity 0.857; threshold 0.800",
					kind: "levenshtein",
					values: { score: 0.857, threshold: 0.8 },
				},
				de,
				"de"
			)
		).toEqual({ message: "Ähnlichkeit 0,857; Schwellenwert 0,8" });
	});

	test("renders a coded value as a whole translated message", () => {
		expect(
			assertionDetailText(
				{
					...BASE,
					code: "contains.missing",
					detail: 'missing "Hallo"',
					values: { value: "Hallo" },
				},
				de,
				"de"
			)
		).toEqual({ message: "„Hallo“ fehlt" });
	});

	test("wraps a negated verdict and keeps compiler text raw", () => {
		expect(
			assertionDetailText(
				{
					...BASE,
					code: "regex.invalid",
					detail: "negated: invalid regex: unclosed group",
					kind: "regex",
					values: { error: "unclosed group", negated: true, pattern: "(" },
				},
				de,
				"de"
			)
		).toEqual({
			message: "Negiert: Ungültiger regulärer Ausdruck /(/",
			raw: "unclosed group",
		});
	});

	test("falls back to the English detail without a usable code", () => {
		const legacy = { ...BASE, detail: 'missing "x"' };
		expect(assertionDetailText(legacy, de, "de")).toEqual({
			message: 'missing "x"',
		});
		expect(
			assertionDetailText(
				{ ...legacy, code: "contains.missing", values: {} },
				de,
				"de"
			)
		).toEqual({ message: 'missing "x"' });
		expect(assertionDetailText({ ...BASE, detail: "" }, de, "de")).toBeNull();
	});

	test("renders Japanese without isolates and with ASCII grouping", () => {
		expect(
			assertionDetailText(
				{
					...BASE,
					code: "similarity.too_long",
					detail: "levenshtein inputs are limited to 2048 characters",
					kind: "levenshtein",
					values: { limit: 2048 },
				},
				ja,
				"ja"
			)
		).toEqual({ message: "類似度の入力は 2,048 文字までです" });
		expect(
			assertionDetailText(
				{
					...BASE,
					code: "regex.matched",
					detail: "matched /^ok/",
					kind: "regex",
					pass: true,
					score: 1,
					values: { pattern: "^ok" },
				},
				ja,
				"ja"
			)
		).toEqual({ message: "/^ok/ に一致" });
	});

	test("isolates a Latin value inside an Arabic negated message", () => {
		const result = assertionDetailText(
			{
				...BASE,
				code: "not_contains.found",
				detail: 'negated: unexpectedly found "error"',
				kind: "not_contains",
				pass: true,
				score: 1,
				values: { negated: true, value: "error" },
			},
			ar,
			"ar"
		);
		expect(result?.message.startsWith("معكوس: ")).toBe(true);
		expect(result?.message).toContain(`"${FSI}error${PDI}"`);
		expect(result?.message).toContain("بشكل غير متوقع");
		expect(result?.raw).toBeUndefined();
	});

	test("English renders the coded message, not the lowercase wire detail", () => {
		const en: LiteralMessage = (source, values) =>
			formatMessage(source, values, "en");
		expect(
			assertionDetailText(
				{
					...BASE,
					code: "similarity.score",
					detail: "similarity 0.857; threshold 0.800",
					kind: "levenshtein",
					values: { score: 0.857, threshold: 0.8 },
				},
				en,
				"en"
			)
		).toEqual({ message: "Similarity 0.857; threshold 0.8" });
	});
});
