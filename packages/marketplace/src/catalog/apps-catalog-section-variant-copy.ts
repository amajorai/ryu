import type { AppsCatalogVariant } from "./apps-catalog-section-filters.ts";

type Translate = (source: string) => string;

/** One message per catalog state, written whole for each variant: a language
 *  inflects "apps" and "plugins" differently in each sentence, so the noun is
 *  never passed in as a message argument. Each entry is a literal `tl()` call
 *  so the extractor carries it. */
export interface CatalogVariantMessages {
	/** Title of the list's no-results state. */
	emptySearch: (tl: Translate) => string;
	/** Title of the list's load-failure state. */
	loadError: (tl: Translate) => string;
	/** Title of the detail pane before a listing is picked. */
	noneSelected: (tl: Translate) => string;
	/** Description of the detail pane before a listing is picked. */
	pickHint: (tl: Translate) => string;
}

export interface CatalogVariantCopy extends CatalogVariantMessages {
	noun: string;
	searchPlaceholder: string;
}

const PLUGIN_MESSAGES: CatalogVariantMessages = {
	loadError: (tl) => tl("Couldn't load plugins"),
	emptySearch: (tl) => tl("No plugins found"),
	noneSelected: (tl) => tl("No plugin selected"),
	pickHint: (tl) =>
		tl(
			"Pick a plugin from the list to read what it does, review its permissions, and install it."
		),
};

export const VARIANT_COPY = {
	apps: {
		noun: "app",
		searchPlaceholder: "Search apps…",
		loadError: (tl) => tl("Couldn't load apps"),
		emptySearch: (tl) => tl("No apps found"),
		noneSelected: (tl) => tl("No app selected"),
		pickHint: (tl) =>
			tl(
				"Pick an app from the list to read what it does, review its permissions, and install it."
			),
	},
	plugins: {
		noun: "plugin",
		searchPlaceholder: "Search plugins…",
		...PLUGIN_MESSAGES,
	},
	all: {
		noun: "plugin",
		searchPlaceholder: "Search plugins…",
		...PLUGIN_MESSAGES,
	},
} satisfies Record<AppsCatalogVariant, CatalogVariantCopy>;
