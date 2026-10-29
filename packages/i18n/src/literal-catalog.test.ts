import { afterEach, describe, expect, test } from "bun:test";

import { officialCatalogLocale } from "./catalog-locale.ts";
import { I18nRuntime } from "./core.ts";
import {
	type LiteralCatalog,
	messageIdForLiteral,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";

const GERMAN: LiteralCatalog = {
	"Open workspace settings": "Arbeitsbereichseinstellungen öffnen",
	"{count} files synced": "{count} Dateien synchronisiert",
	"Bad placeholder {name}": "Falscher Platzhalter {other}",
};

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	// official-catalog.ts registers the real loader on import; each test sets
	// its own, so restore a neutral state between them.
	registerLiteralCatalogLoader(null);
});

describe("official literal catalogs", () => {
	test("load lazily for the active locale and publish once ready", async () => {
		const requested: string[] = [];
		registerLiteralCatalogLoader((locale) => {
			requested.push(locale);
			return Promise.resolve(locale.startsWith("de") ? GERMAN : null);
		});
		const runtime = new I18nRuntime([], {
			initialLocale: "de-AT",
			initialPackId: null,
		});
		let published = 0;
		runtime.subscribe(() => {
			published += 1;
		});
		const id = messageIdForLiteral("Open workspace settings");

		expect(runtime.overlayMessage(id)).toBeUndefined();
		await settle();

		expect(published).toBe(1);
		expect(runtime.overlayMessage(id)).toBe(
			"Arbeitsbereichseinstellungen öffnen"
		);
		expect(runtime.translate(id, {}, "Open workspace settings")).toBe(
			"Arbeitsbereichseinstellungen öffnen"
		);
		runtime.overlayMessage(id);
		expect(requested).toEqual(["de"]);
	});

	test("keep ICU placeholders and reject a translation that drops one", async () => {
		registerLiteralCatalogLoader(() => Promise.resolve(GERMAN));
		const runtime = new I18nRuntime([], {
			initialLocale: "de",
			initialPackId: null,
		});
		const countId = messageIdForLiteral("{count} files synced");
		const badId = messageIdForLiteral("Bad placeholder {name}");
		runtime.overlayMessage(countId);
		await settle();

		expect(
			runtime.translate(countId, { count: 3 }, "{count} files synced")
		).toBe("3 Dateien synchronisiert");
		expect(
			runtime.translate(badId, { name: "x" }, "Bad placeholder {name}")
		).toBe("Bad placeholder x");
	});

	test("answer on the first lookup when the catalog is bundled", () => {
		registerLiteralCatalogLoader((locale) =>
			locale.startsWith("de") ? GERMAN : null
		);
		const runtime = new I18nRuntime([], {
			initialLocale: "de",
			initialPackId: null,
		});
		expect(
			runtime.overlayMessage(messageIdForLiteral("Open workspace settings"))
		).toBe("Arbeitsbereichseinstellungen öffnen");
	});

	test("never load for English and tolerate a failing chunk", async () => {
		let calls = 0;
		registerLiteralCatalogLoader(() => {
			calls += 1;
			return Promise.reject(new Error("chunk failed"));
		});
		const english = new I18nRuntime([], {
			initialLocale: "en",
			initialPackId: null,
		});
		english.overlayMessage(messageIdForLiteral("Open workspace settings"));
		expect(calls).toBe(0);

		const french = new I18nRuntime([], {
			initialLocale: "fr",
			initialPackId: null,
		});
		const id = messageIdForLiteral("Open workspace settings");
		expect(french.overlayMessage(id)).toBeUndefined();
		await settle();
		expect(french.overlayMessage(id)).toBeUndefined();
		expect(calls).toBe(1);
	});

	test("give distinct raw literals distinct ids regardless of order", () => {
		const plain = messageIdForLiteral("Frobnicating widgets");
		const ellipsis = messageIdForLiteral("Frobnicating widgets…");
		expect(plain).not.toBe(ellipsis);
		expect(messageIdForLiteral("Frobnicating widgets")).toBe(plain);
		// Only an exact English message resolves to its named catalog id; case
		// and trailing punctuation are part of the copy.
		expect(messageIdForLiteral("Cancel")).toBe("common.cancel");
		expect(messageIdForLiteral("cancel…")).not.toBe("common.cancel");
		expect(messageIdForLiteral("cancel")).not.toBe("common.cancel");
		expect(messageIdForLiteral("Cancel.")).not.toBe("common.cancel");
	});

	test("map regional and script variants onto the shipped locales", () => {
		expect(officialCatalogLocale("de-AT")).toBe("de");
		expect(officialCatalogLocale("pt-PT")).toBe("pt-BR");
		expect(officialCatalogLocale("zh-CN")).toBe("zh-CN");
		expect(officialCatalogLocale("zh-SG")).toBe("zh-CN");
		expect(officialCatalogLocale("zh-TW")).toBeNull();
		expect(officialCatalogLocale("sv")).toBeNull();
	});
});
