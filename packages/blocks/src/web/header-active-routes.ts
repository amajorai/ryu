// The routes each header menu counts as its own. The desktop header's
// Products and Resources triggers (./header-catalog-menus.tsx) and the mobile
// bottom bar's tabs (./mobile-nav.tsx) both highlight from these lists, so the
// two headers always agree on where a page belongs.

export const PRODUCT_ACTIVE_PREFIXES: readonly string[] = [
	"/products",
	"/bot",
	"/agent",
	"/platform",
	"/marketplace",
	"/interfaces",
];

export const RESOURCE_ACTIVE_PREFIXES: readonly string[] = [
	"/pricing",
	"/gifts",
	"/academy",
	"/certifications",
	"/guides",
	"/help",
	"/knowledge-base",
	"/blog",
	"/changelog",
	"/stories",
	"/challenges",
	"/compare",
	"/community",
	"/perks",
	// The mobile Resources sheet's Company group. The desktop menu leaves them
	// to the footer, but they are still resources pages, not product pages.
	"/about",
	"/careers",
	"/press",
	"/events",
];

/** Whether the route is one of the prefixes or a page under one of them. */
export function isWithinPrefixes(
	pathname: string,
	prefixes: readonly string[]
): boolean {
	return prefixes.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
}
