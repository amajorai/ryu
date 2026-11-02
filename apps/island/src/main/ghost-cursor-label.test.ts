import { describe, expect, it } from "bun:test";
import { messageIdForLiteral } from "@ryu/i18n/lite";
import { loadOfficialLiteralCatalog } from "@ryu/i18n/official-catalog";
import {
	GHOST_CLICK_TARGET_COPY,
	GHOST_INTENT_COPY,
} from "../renderer/lib/ghost-intent-copy.ts";
import {
	createGhostCursorTranslator,
	ENGLISH_GHOST_CURSOR_TRANSLATOR,
	ghostCursorLocaleChoice,
} from "./ghost-cursor-label.ts";

const JA_CATALOG = {
	[GHOST_CLICK_TARGET_COPY]: "「{target}」をクリック",
	[GHOST_INTENT_COPY.typing]: "入力中",
};

describe("ghost cursor label", () => {
	it('renders kind "click" with target "Save" in Japanese', () => {
		const ja = createGhostCursorTranslator("ja", JA_CATALOG);
		expect(
			ja.label({ intent: "Click “Save”", kind: "click", target: "Save" })
		).toBe("「Save」をクリック");
		expect(ja.label({ intent: "Typing", kind: "typing" })).toBe("入力中");
		expect(ja.direction).toBe("ltr");
	});

	it("keeps the target verbatim, even when it looks like ICU", () => {
		const ja = createGhostCursorTranslator("ja", JA_CATALOG);
		expect(ja.label({ intent: "", kind: "click", target: "{count}" })).toBe(
			"「{count}」をクリック"
		);
	});

	it("falls back to English for untranslated kinds and to prose without a kind", () => {
		const ja = createGhostCursorTranslator("ja", JA_CATALOG);
		expect(ja.label({ intent: "Scrolling", kind: "scrolling" })).toBe(
			"Scrolling"
		);
		expect(ja.label({ intent: "Press “OK”" })).toBe("Press “OK”");
		expect(ENGLISH_GHOST_CURSOR_TRANSLATOR.label({ intent: "" })).toBe(
			"Working"
		);
		expect(
			ENGLISH_GHOST_CURSOR_TRANSLATOR.label({ intent: "", kind: "click" })
		).toBe("Click");
	});

	it("prefers the selected pack's messages and sets RTL for Arabic", () => {
		const ar = createGhostCursorTranslator("ar", null, {
			messages: { [messageIdForLiteral(GHOST_INTENT_COPY.holding)]: "يضغط" },
		});
		expect(ar.direction).toBe("rtl");
		expect(ar.label({ intent: "Holding", kind: "holding" })).toBe("يضغط");
	});

	it("follows a fixed choice, else the OS languages", () => {
		expect(
			ghostCursorLocaleChoice({ mode: "fixed", packId: null }, [], ["ja"])
				.locale
		).toBe("en");
		expect(
			ghostCursorLocaleChoice(
				{ mode: "fixed", packId: "official/de" },
				[],
				["ja"]
			).locale
		).toBe("de");
		expect(ghostCursorLocaleChoice(null, [], ["nl-NL", "ja-JP"]).locale).toBe(
			"ja-JP"
		);
		expect(
			ghostCursorLocaleChoice({ mode: "auto", packId: null }, [], ["nl"]).locale
		).toBe("en");
	});

	it("labels kinds from the shipped ja, de and ar catalogs", async () => {
		const cases = [
			["ja", "ltr"],
			["de", "ltr"],
			["ar", "rtl"],
		] as const;
		for (const [locale, direction] of cases) {
			const catalog = await loadOfficialLiteralCatalog(locale);
			const translator = createGhostCursorTranslator(locale, catalog);
			expect(translator.direction).toBe(direction);
			for (const kind of ["click", "working", "done"] as const) {
				const english = GHOST_INTENT_COPY[kind];
				const label = translator.label({ intent: english, kind });
				expect(label).toBe(catalog?.[english] ?? english);
				expect(label).not.toBe(english);
			}
		}
	});
});
