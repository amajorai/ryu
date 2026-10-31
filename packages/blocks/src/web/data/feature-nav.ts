import type { ProductNavItem } from "./product-realms.ts";

/**
 * Features with their own page, listed in the Products menu and the mobile
 * Products sheet after the product groups. They are not products, so they stay
 * out of the /products catalogue mapping (`PRODUCT_NAV_GROUPS`) and the realm
 * cards built from it.
 */
export const FEATURE_NAV_GROUP: {
	items: readonly ProductNavItem[];
	title: "Features";
} = {
	title: "Features",
	items: [
		{
			description: "69 ways to see your agents.",
			href: "/interfaces",
			label: "Interfaces",
		},
	],
};
