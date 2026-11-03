import { afterEach, describe, expect, test } from "bun:test";

import { OFFICIAL_CATALOG_LOCALES } from "./catalog-locale.ts";
import { I18nRuntime } from "./core.ts";
import {
	type LiteralCatalog,
	literalCatalogLoader,
	messageIdForLiteral,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";
import { officialBotLiteralCatalog } from "./official-catalog-bot.ts";
import { officialCliLiteralCatalog } from "./official-catalog-cli.ts";
import { officialEmailLiteralCatalog } from "./official-catalog-email.ts";
import { officialExtensionLiteralCatalog } from "./official-catalog-extension.ts";
import { loadOfficialWebLiteralCatalog } from "./official-catalog-web.ts";

afterEach(() => {
	registerLiteralCatalogLoader(null);
});

/** The statically bundled subsets the CLI, the chat bot and email use. */
const SUBSETS: ReadonlyArray<
	readonly [string, (locale: string) => LiteralCatalog | null]
> = [
	["bot", officialBotLiteralCatalog],
	["cli", officialCliLiteralCatalog],
	["email", officialEmailLiteralCatalog],
];

describe.each(SUBSETS)("the official %s subset", (_name, loadCatalog) => {
	test("ship a catalog for every official locale and none for English", () => {
		for (const locale of OFFICIAL_CATALOG_LOCALES) {
			expect(loadCatalog(locale)).not.toBeNull();
		}
		expect(loadCatalog("en")).toBeNull();
	});

	test("answer the runtime's keyed fallback lookup for every entry", () => {
		registerLiteralCatalogLoader(loadCatalog);
		for (const locale of OFFICIAL_CATALOG_LOCALES) {
			const catalog = loadCatalog(locale) ?? {};
			const runtime = new I18nRuntime([], {
				initialLocale: locale,
				initialPackId: null,
			});
			for (const [source, translation] of Object.entries(catalog)) {
				const id = messageIdForLiteral(source);
				// Copy the official pack already names (a catalog message or one of
				// its built-in literals) resolves through the pack, which outranks the
				// literal catalog by design.
				if (
					source.includes("{") ||
					translation.includes("{") ||
					!id.startsWith("literal.") ||
					runtime.availablePacks.some((pack) =>
						Object.hasOwn(pack.messages, id)
					)
				) {
					continue;
				}
				expect(runtime.translate(id, undefined, source)).toBe(translation);
			}
		}
	});
});

/** Labels the extension's MV3 worker renders from `@ryu/blocks` (omnibox). */
const OMNIBOX_LABELS = [
	"Go to {host}",
	"Search {engine}",
	"Run /{name}",
	"Pick a skill",
	"Ask Ryu with {mentions}",
];

describe("the official extension subset", () => {
	test("carries the shared omnibox labels the full catalog translates", async () => {
		for (const locale of OFFICIAL_CATALOG_LOCALES) {
			const full: LiteralCatalog = (
				await import(`../locales/${locale}.json`, { with: { type: "json" } })
			).default;
			const subset = officialExtensionLiteralCatalog(locale) ?? {};
			for (const label of OMNIBOX_LABELS) {
				if (Object.hasOwn(full, label)) {
					expect(subset[label]).toBe(full[label]);
				}
			}
		}
	});
});

describe("the official web subset", () => {
	test("registers itself and lazy-loads a slice of the full catalog per locale", async () => {
		registerLiteralCatalogLoader(null);
		// Importing the module is the opt-in; re-import it to register again.
		await import(`./official-catalog-web.ts?register=${Date.now()}`);
		expect(await literalCatalogLoader()?.("de")).toEqual(
			await loadOfficialWebLiteralCatalog("de")
		);
		expect(await loadOfficialWebLiteralCatalog("en")).toBeNull();
		for (const locale of OFFICIAL_CATALOG_LOCALES) {
			const full: LiteralCatalog = (
				await import(`../locales/${locale}.json`, { with: { type: "json" } })
			).default;
			const subset = (await loadOfficialWebLiteralCatalog(locale)) ?? {};
			const entries = Object.entries(subset);
			// The website's own copy (the cookie banner) ships in the slice…
			expect(subset["Cookie preferences"]).toBe(full["Cookie preferences"]);
			// …every entry is the full catalog's translation…
			for (const [source, translation] of entries) {
				expect<string | undefined>(translation).toBe(full[source]);
			}
			// …and other surfaces' copy stays out of the download.
			expect(entries.length).toBeLessThan(Object.keys(full).length);
		}
	});
});
