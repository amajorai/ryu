import {
	CATALOG_AGENTS_AS_A_SERVICE_FLAG,
	CATALOG_RED_TEAM_FLAG,
	CATALOG_WORKFLOWS_FLAG,
} from "./feature-flag-keys.ts";
import {
	closedStandaloneProductPages,
	featureFlagFallback,
} from "./feature-flags.ts";

/**
 * Launch flag per marketing product slug (`@ryu/blocks/web/data/products.tsx`)
 * for products that are built but not released. Off, the product is left out
 * of every public listing: the header Products menu, the mobile nav, the
 * footer, the /products index and the homepage cards. Unlike a standalone
 * service flag it never closes the product page, which stays reachable by URL.
 * Surfaces consult this generic map instead of hard-coding a slug.
 */
export const PRODUCT_LAUNCH_FLAGS = {
	"agents-as-a-service": CATALOG_AGENTS_AS_A_SERVICE_FLAG,
	"red-team": CATALOG_RED_TEAM_FLAG,
	workflows: CATALOG_WORKFLOWS_FLAG,
} as const satisfies Readonly<Record<string, string>>;
export type LaunchGatedProductSlug = keyof typeof PRODUCT_LAUNCH_FLAGS;

const isLaunchGatedProductSlug = (
	slug: string
): slug is LaunchGatedProductSlug => Object.hasOwn(PRODUCT_LAUNCH_FLAGS, slug);

export const LAUNCH_GATED_PRODUCT_SLUGS: readonly LaunchGatedProductSlug[] =
	Object.keys(PRODUCT_LAUNCH_FLAGS).filter(isLaunchGatedProductSlug);

/** Launch flag that holds a product back, or undefined when none does. */
export const productLaunchFlag = (slug: string): string | undefined =>
	isLaunchGatedProductSlug(slug) ? PRODUCT_LAUNCH_FLAGS[slug] : undefined;

/**
 * Whether a product is launched in an evaluated flag map. A slug with no
 * launch flag always is; a gated slug missing from the map (never read,
 * malformed) takes the catalog default, which keeps it unlisted.
 */
export function productLaunched(
	slug: string,
	values: Readonly<Record<string, unknown>> | null | undefined
): boolean {
	const flag = productLaunchFlag(slug);
	if (flag === undefined) {
		return true;
	}
	const value = values?.[flag];
	return typeof value === "boolean" ? value : featureFlagFallback(flag);
}

/** Launch-gated product slugs that are not launched in a flag map. */
export function unlaunchedProducts(
	values: Readonly<Record<string, unknown>> | null | undefined
): LaunchGatedProductSlug[] {
	return LAUNCH_GATED_PRODUCT_SLUGS.filter(
		(slug) => !productLaunched(slug, values)
	);
}

/**
 * Product slugs the public site leaves out of its listings: standalone
 * services whose product page is closed, plus products not launched yet. The
 * marketing header, mobile nav, footer, /products index and homepage cards
 * all hide exactly this list.
 */
export function hiddenProductListings(
	values: Readonly<Record<string, unknown>> | null | undefined
): string[] {
	return [
		...closedStandaloneProductPages(values),
		...unlaunchedProducts(values),
	];
}
