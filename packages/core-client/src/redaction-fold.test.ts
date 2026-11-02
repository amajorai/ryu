// packages/core-client/src/redaction-fold.test.ts
//
// The folded view a redaction scanner runs beside the as-written text: every
// common evasion folds to plain ASCII, while plain ASCII is never changed.

import { describe, expect, test } from "bun:test";
import { foldRedactionText } from "./redaction-fold.ts";

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

	test("leaves ASCII alone and never composes an ASCII letter", () => {
		const ascii = "ERROR boot failed at 127.0.0.1:7980 (token=[REDACTED])";
		expect(foldRedactionText(ascii)).toBe(ascii);
		expect(foldRedactionText("é")).toBe("é");
	});

	test("is idempotent", () => {
		const once = foldRedactionText("ｓｋ‐ｐｒｏｊ​１２３");
		expect(once).toBe("sk-proj123");
		expect(foldRedactionText(once)).toBe(once);
	});
});
