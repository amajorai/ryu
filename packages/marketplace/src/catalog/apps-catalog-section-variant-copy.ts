import type { AppsCatalogVariant } from "./apps-catalog-section-filters.ts";

export const VARIANT_COPY = {
	apps: {
		noun: "app",
		nounPlural: "apps",
		searchPlaceholder: "Search apps…",
	},
	plugins: {
		noun: "plugin",
		nounPlural: "plugins",
		searchPlaceholder: "Search plugins…",
	},
	all: {
		noun: "plugin",
		nounPlural: "plugins",
		searchPlaceholder: "Search plugins…",
	},
} satisfies Record<
	AppsCatalogVariant,
	{ noun: string; nounPlural: string; searchPlaceholder: string }
>;
