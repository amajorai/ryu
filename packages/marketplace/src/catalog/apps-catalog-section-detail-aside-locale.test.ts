// The listing stat strip under German and Japanese UIs: the ratings label is a
// plural message, the average uses the locale's decimal separator, and "Runs on"
// translates each surface before joining them as a localized list.

import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import { appStatItems } from "./apps-catalog-section-detail-aside.tsx";
import type { CatalogEntry } from "./types.ts";

const RATINGS =
	"{count, plural, one {{formatted} rating} other {{formatted} ratings}}";

const CATALOGS: Record<string, Record<string, string>> = {
	de: {
		[RATINGS]:
			"{count, plural, one {{formatted} Bewertung} other {{formatted} Bewertungen}}",
		Desktop: "Desktop",
		Web: "Web",
	},
	ja: {
		[RATINGS]: "{formatted} 件の評価",
		Desktop: "デスクトップ",
		Web: "ウェブ",
	},
};

function standIn(locale: string) {
	const catalog = CATALOGS[locale] ?? {};
	return {
		direction: "ltr" as const,
		locale,
		translate(source: string, values?: MessageValuesInput, fallback?: string) {
			const english = fallback ?? source;
			return formatMessage(catalog[english] ?? english, values, locale);
		},
	};
}

let active: ReturnType<typeof standIn> | null = null;

function useLocale(locale: string) {
	active = standIn(locale);
	registerActiveI18nRuntime(active);
}

afterEach(() => {
	if (active) {
		unregisterActiveI18nRuntime(active);
		active = null;
	}
});

const ENTRY = {
	id: "@ryu/example",
	name: "Example",
	rating_average: 4.5,
	rating_count: 1234,
	surfaces: ["desktop", "web"],
} as unknown as CatalogEntry;

function cells() {
	const items = appStatItems({
		detail: null,
		entry: ENTRY,
		onOpenHealth: () => undefined,
		onOpenReviews: () => undefined,
		scorecard: null,
		showRating: true,
		showTechnical: false,
	});
	const rating = items[0];
	const runsOn = items.find((item) => item.label === "Runs on");
	return { rating, runsOn };
}

describe("appStatItems under a non-English UI", () => {
	test("German: plural label, comma decimal, joined surface list", () => {
		useLocale("de");
		const { rating, runsOn } = cells();
		expect(rating?.label).toBe("1.234 Bewertungen");
		expect(rating?.value).toBe("4,5");
		expect(runsOn?.value).toBe("Desktop und Web");
	});

	test("Japanese: translated surfaces in a Japanese list", () => {
		useLocale("ja");
		const { rating, runsOn } = cells();
		expect(rating?.label).toBe("1,234 件の評価");
		expect(rating?.value).toBe("4.5");
		expect(runsOn?.value).toBe("デスクトップ、ウェブ");
	});

	test("English keeps the singular for one rating", () => {
		useLocale("en");
		const items = appStatItems({
			detail: null,
			entry: { ...ENTRY, rating_count: 1 } as CatalogEntry,
			onOpenHealth: () => undefined,
			onOpenReviews: () => undefined,
			scorecard: null,
			showRating: true,
			showTechnical: false,
		});
		expect(items[0]?.label).toBe("1 rating");
	});
});
