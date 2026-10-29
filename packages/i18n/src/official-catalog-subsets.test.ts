import { afterEach, describe, expect, test } from "bun:test";

import { OFFICIAL_CATALOG_LOCALES } from "./catalog-locale.ts";
import { I18nRuntime } from "./core.ts";
import {
	type LiteralCatalog,
	messageIdForLiteral,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";
import { officialCliLiteralCatalog } from "./official-catalog-cli.ts";
import { officialEmailLiteralCatalog } from "./official-catalog-email.ts";

afterEach(() => {
	registerLiteralCatalogLoader(null);
});

/** The statically bundled subsets the CLI and server-rendered email use. */
const SUBSETS: ReadonlyArray<
	readonly [string, (locale: string) => LiteralCatalog | null]
> = [
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
