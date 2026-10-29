import { afterEach, describe, expect, test } from "bun:test";
import { I18nRuntime } from "./core.ts";
import {
	collapseLiteralWhitespace,
	indexLiteralCatalog,
	type LiteralCatalog,
	messageIdForLiteral,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";

const GERMAN: LiteralCatalog = {
	"Save draft": "Entwurf speichern",
	"Save draft.": "Entwurf speichern.",
	"{count} drafts": "{count} Entwürfe",
	"Use {name} here": "Verwende {name} hier",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
});

function germanRuntime(): I18nRuntime {
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("de") ? GERMAN : null
	);
	return new I18nRuntime([], { initialLocale: "de", initialPackId: null });
}

describe("literal ids", () => {
	test("fold whitespace the way JSX and the extractor do", () => {
		expect(
			collapseLiteralWhitespace(
				`  Save\n\t draft${String.fromCodePoint(0xa0)} `
			)
		).toBe("Save draft");
		expect(messageIdForLiteral("Save\n   draft")).toBe(
			messageIdForLiteral("Save draft")
		);
		expect(messageIdForLiteral("  Cancel  ")).toBe("common.cancel");
	});

	test("keep punctuation variants apart in an indexed catalog", () => {
		const index = indexLiteralCatalog(GERMAN);
		expect(index.get(messageIdForLiteral("Save draft"))).toBe(
			"Entwurf speichern"
		);
		expect(index.get(messageIdForLiteral("Save draft."))).toBe(
			"Entwurf speichern."
		);
	});
});

describe("translate with a fallback", () => {
	test("reaches the literal catalog through a keyed call's fallback", () => {
		const runtime = germanRuntime();
		expect(runtime.translate("app.drafts.save", {}, "Save draft")).toBe(
			"Entwurf speichern"
		);
		expect(
			runtime.translate("app.drafts.count", { count: 2 }, "{count} drafts")
		).toBe("2 Entwürfe");
	});

	test("reaches a named message through an exact English fallback", () => {
		const runtime = new I18nRuntime([], {
			initialLocale: "es",
			initialPackId: null,
		});
		expect(runtime.translate("app.dialog.cancel", {}, "Cancel")).toBe(
			runtime.translate("common.cancel")
		);
		expect(runtime.translate("app.dialog.cancel", {}, "Cancel")).not.toBe(
			"Cancel"
		);
	});

	test("rejects a fallback translation whose placeholders differ", () => {
		registerLiteralCatalogLoader(() => ({ "Hello {name}": "Hallo {other}" }));
		const runtime = new I18nRuntime([], {
			initialLocale: "de",
			initialPackId: null,
		});
		expect(
			runtime.translate("app.hello", { name: "Ari" }, "Hello {name}")
		).toBe("Hello Ari");
	});

	test("returns unknown literal text verbatim instead of formatting it", () => {
		const runtime = germanRuntime();
		const data = "Don't {stop} until {count, plural, one {#} other {#}}";
		expect(runtime.translate(messageIdForLiteral(data), {}, data)).toBe(data);
		const english = new I18nRuntime([], {
			initialLocale: "en",
			initialPackId: null,
		});
		expect(english.translate(messageIdForLiteral(data), {}, data)).toBe(data);
	});

	test("keeps braces in a literal translation looked up without values", () => {
		const runtime = germanRuntime();
		const source = "Use {name} here";
		expect(runtime.translate(messageIdForLiteral(source), {}, source)).toBe(
			"Verwende {name} hier"
		);
		expect(
			runtime.translate(messageIdForLiteral(source), { name: "Ryu" }, source)
		).toBe("Verwende Ryu hier");
	});
});
