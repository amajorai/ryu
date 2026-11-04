// packages/core-client/src/redaction-fold.test.ts
//
// The folded view a redaction scanner runs beside the as-written text: every
// common evasion folds to plain ASCII, while plain ASCII is never changed.

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { foldRedactionText, LOOK_ALIKE_KEYWORDS } from "./redaction-fold.ts";

const foldFixture = new URL(
	"../fixtures/portable-history-fold-v1.json",
	import.meta.url
);
const keywordFixture = new URL(
	"../fixtures/look-alike-keywords-v1.json",
	import.meta.url
);
const troubleshootRedaction = new URL(
	"./troubleshoot-redaction.ts",
	import.meta.url
);

const SECRET_KEY_NAMES = /const SECRET_KEY_NAMES =\s*"([^"]+)"/;
const REGEX_LITERAL_LINE = /^\s*\/(.+)\/[a-z]*,\s*$/;
const KEYED_PATTERN = /PRIVATE KEY|Bearer|Authorization/;
const ESCAPE = /\\./g;
const CHARACTER_CLASS = /\[[^\]]*\]/g;
const LOOKAROUND = /\(\?<?[!=][^)]*\)/g;
const FLAG_GROUP = /\(\?[a-z]+\)/g;
const WORD = /[A-Za-z]{2,}/g;

/** Every spelling of a credential name: each `[_-]?` written as `-` or left out. */
function spellings(name: string): string[] {
	const [first = "", ...rest] = name.split("[_-]?");
	let out = [first];
	for (const part of rest) {
		out = out.flatMap((spelling) => [
			`${spelling}${part}`,
			`${spelling}-${part}`,
		]);
	}
	return out;
}

/** Lowercased letter runs a regex source keys on: escapes, character
 * classes, lookarounds and flag groups dropped. */
function patternWords(source: string): string[] {
	const literal = source
		.replace(ESCAPE, " ")
		.replace(CHARACTER_CLASS, " ")
		.replace(LOOKAROUND, " ")
		.replace(FLAG_GROUP, " ");
	return Array.from(literal.matchAll(WORD), ([word]) => word.toLowerCase());
}

const listed = (word: string) => LOOK_ALIKE_KEYWORDS.has(word);

describe("foldRedactionText", () => {
	test("folds fullwidth letters, digits and punctuation to ASCII", () => {
		expect(foldRedactionText("ｊａｎｅ＠ｅｘａｍｐｌｅ．ｃｏｍ")).toBe(
			"jane@example.com"
		);
		expect(foldRedactionText("８．８．８．８")).toBe("8.8.8.8");
	});

	test("drops zero-width, bidi and TAG characters", () => {
		expect(foldRedactionText("gh​p_⁠abc﻿")).toBe("ghp_abc");
		expect(foldRedactionText("pass\u{e0020}word‮")).toBe("password");
	});

	test("folds look-alike dashes, spaces and non-ASCII digits", () => {
		expect(foldRedactionText("123‑456−789")).toBe("123-456-789");
		expect(foldRedactionText("a b　c")).toBe("a b c");
		expect(foldRedactionText("١٢٣ ४५")).toBe("123 45");
	});

	test("leaves ASCII alone and drops a mark stacked on an ASCII letter", () => {
		const ascii = "ERROR boot failed at 127.0.0.1:7980 (token=[REDACTED])";
		expect(foldRedactionText(ascii)).toBe(ascii);
		// Never composed into `é`: the mark is dropped, so `e` stays ASCII.
		expect(foldRedactionText("e\u0301")).toBe("e");
		expect(foldRedactionText("\u0438\u0306")).toBe("\u0438\u0306");
	});

	test("folds look-alike letters and the ideographic full stop in mixed tokens", () => {
		expect(foldRedactionText("ava@\u0435xample\u3002com")).toBe(
			"ava@example.com"
		);
		expect(foldRedactionText("\u043f\u0440\u0438\u0432\u0435\u0442")).toBe(
			"\u043f\u0440\u0438\u0432\u0435\u0442"
		);
	});

	test("folds an all-look-alike address or credential key", () => {
		expect(
			foldRedactionText(
				"\u0430\u0441\u0435@\u0435\u0445\u0430\u0441\u0435\u3002\u0441\u043e"
			)
		).toBe("ace@exace.co");
		expect(foldRedactionText("\u0410\u0420\u0406_\u041a\u0415\u03a5")).toBe(
			"API_KEY"
		);
	});

	test("folds a credential name or PEM label spelled wholly in look-alikes", () => {
		expect(
			foldRedactionText(
				"\u03a4\u039f\u039a\u0395\u039d = v \u0412\u0430\u0455\u0456\u0441"
			)
		).toBe("TOKEN = v Basic");
		expect(foldRedactionText("\u039a\u0395\u03a5-----")).toBe("KEY-----");
		// A look-alike word that is not a credential name keeps its script.
		expect(foldRedactionText("\u0430\u0441\u0435:")).toBe(
			"\u0430\u0441\u0435:"
		);
	});

	test("leaves Russian prose without PII unchanged", () => {
		const prose = "Вот пример: кто-то сказал «ура».";
		expect(foldRedactionText(prose)).toBe(prose);
	});

	test("matches the shared Core and public-share fold fixture", async () => {
		const rows = z
			.array(
				z.object({ note: z.string(), input: z.string(), folded: z.string() })
			)
			.parse(await Bun.file(foldFixture).json());
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect({ note: row.note, folded: foldRedactionText(row.input) }).toEqual({
				note: row.note,
				folded: row.folded,
			});
		}
	});

	test("lists every credential name and PEM label the troubleshoot patterns key on", async () => {
		const source = await Bun.file(troubleshootRedaction).text();
		const names = SECRET_KEY_NAMES.exec(source)?.[1] ?? "";
		expect(names).toContain("password");
		const uncovered = names
			.split("|")
			.flatMap(spellings)
			.filter((spelling) => !spelling.split("-").some(listed));
		// The PEM armor and the Bearer, Basic and `Authorization: Token` rules.
		const keyed = source
			.split("\n")
			.map((line) => REGEX_LITERAL_LINE.exec(line)?.[1] ?? "")
			.filter((pattern) => KEYED_PATTERN.test(pattern));
		expect(keyed).toHaveLength(3);
		for (const pattern of keyed) {
			uncovered.push(...patternWords(pattern).filter((word) => !listed(word)));
		}
		expect(uncovered).toEqual([]);
	});

	test("lists the same look-alike keywords as Core and the public share", async () => {
		const fixture = z
			.object({ keywords: z.array(z.string()) })
			.parse(await Bun.file(keywordFixture).json());
		expect([...LOOK_ALIKE_KEYWORDS]).toEqual(fixture.keywords);
	});

	test("is idempotent", () => {
		const once = foldRedactionText("ｓｋ‐ｐｒｏｊ​１２３");
		expect(once).toBe("sk-proj123");
		expect(foldRedactionText(once)).toBe(once);
	});
});
