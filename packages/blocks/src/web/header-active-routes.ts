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
];

export const RESOURCE_ACTIVE_PREFIXES: readonly string[] = [
	"/pricing",
	"/gifts",
	"/academy",
	"/certifications",
	"/guides",
	"/help",
	"/blog",
	"/changelog",
	"/stories",
	"/challenges",
	"/compare",
	"/community",
	"/perks",
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
