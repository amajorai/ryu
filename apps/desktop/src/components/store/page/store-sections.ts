// The Store page's section model: the built-in section values, the sections that
// use the shared catalog grid/list geometry, and the deep-link canonicalisation.

import {
	MARKETPLACE_SECTION_VALUES,
	type MarketplaceSection,
} from "@ryu/marketplace/catalog/chrome/marketplace-sections";

/** The built-in section values are shared with the web Marketplace. Everything
 * else in the bar is an app-registered `contributes.store_tabs[]` entry. */
export const WALLPAPERS_STORE_SECTION = "wallpapers" as const;

export type BuiltinStoreSection =
	| MarketplaceSection
	| typeof WALLPAPERS_STORE_SECTION;

/** An active section value: a {@link BuiltinStoreSection}, or a contributed tab's
 *  `plugin:<pluginId>:<tabId>` key. Deliberately open — the Store's section list is
 *  no longer a closed union the shell can enumerate at compile time. */
export type StoreSection = string;

export const BUILTIN_SECTION_VALUES = [
	...MARKETPLACE_SECTION_VALUES,
	WALLPAPERS_STORE_SECTION,
] as const;

/** Store sections whose content uses the shared catalog grid/list geometry. */
export const STORE_VIEW_SECTIONS: ReadonlySet<string> = new Set([
	"bundles",
	"apps",
	"plugins",
	"skills",
	"mcp",
	"agents",
	"engines",
	"integrations",
	"workflows",
	"themes",
	"browse",
]);

export function storeShowcaseSupported(section: string): boolean {
	// The Agents tab owns the employee-badge renderer. Other Store tabs keep the
	// compact catalog card in both Grid and List modes until they gain a real
	// alternate presentation of their own.
	return section === "agents";
}

/** Preserve old `/store/account` deep links while the visible nav uses the same
 * individual money tabs as the web surface. */
export function canonicalStoreSection(value: string): string {
	return value === "account" ? "connections" : value;
}

export function isBuiltinSection(value: string): value is BuiltinStoreSection {
	return BUILTIN_SECTION_VALUES.includes(value);
}

/** The sections shown as tabs in the Store strip. Everything else, including
 *  app-registered tabs, sits behind the strip's "More" menu; the active section
 *  is always promoted into view. */
export const STORE_PRIMARY_SECTIONS: readonly string[] = [
	"home",
	"apps",
	"plugins",
	"models",
	"agents",
];
