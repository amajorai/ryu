// packages/core-client/src/redaction-fold.test.ts
//
// The folded view a redaction scanner runs beside the as-written text: every
// common evasion folds to plain ASCII, while plain ASCII is never changed.

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { foldRedactionText } from "./redaction-fold.ts";

const foldFixture = new URL(
	"../fixtures/portable-history-fold-v1.json",
	import.meta.url
);

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

	test("is idempotent", () => {
		const once = foldRedactionText("ｓｋ‐ｐｒｏｊ​１２３");
		expect(once).toBe("sk-proj123");
		expect(foldRedactionText(once)).toBe(once);
	});
});
