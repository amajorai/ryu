import { productMenuGroupsFor } from "./data/product-realms.ts";
import {
	DOCS_URL,
	PLAN_LINKS,
	resourceCategories,
	resourcesByCategory,
} from "./data/resources.tsx";

// The link groups behind the mobile nav's Products and Resources sheets. They
// live apart from the animated sheet (./mobile-nav-sheet.tsx) so the bar can
// ship without it and the data stays importable on its own.

export interface SheetLinkData {
	external: boolean;
	href: string;
	label: string;
	/** Open an external link in this tab (the docs share this site's chrome). */
	sameTab?: boolean;
}

export interface SheetGroup {
	links: readonly SheetLinkData[];
	title?: string;
}

export const NO_HIDDEN_PRODUCTS: readonly string[] = [];

/**
 * Available products only, one group per nav group, without the realms the host
 * has not rolled out. Early-access and coming-soon products stay on /products,
 * which the sheet's "All products" link opens.
 */
export function productSheet(
	hiddenProductIds: readonly string[]
): SheetGroup[] {
	return productMenuGroupsFor(hiddenProductIds).map((group) => ({
		title: group.title,
		links: group.items.map(({ label, href }) => ({
			label,
			href,
			external: false,
		})),
	}));
}

export const PRODUCT_SHEET: readonly SheetGroup[] =
	productSheet(NO_HIDDEN_PRODUCTS);

export const RESOURCE_SHEET: readonly SheetGroup[] = [
	{
		links: [
			...PLAN_LINKS.map((link) => ({ ...link, external: false })),
			{ label: "Docs", href: DOCS_URL, external: true, sameTab: true },
		],
	},
	...resourceCategories.map((category) => ({
		title: category,
		links: resourcesByCategory(category)
			.filter((resource) => resource.href !== DOCS_URL)
			.map((resource) => ({
				label: resource.label,
				href: resource.href,
				external: resource.external ?? false,
			})),
	})),
];

export const SHEET_TITLES = {
	products: "Products",
	resources: "Resources",
} as const;

export type SheetKey = keyof typeof SHEET_TITLES;

export const SHEET_FOOTERS: Record<SheetKey, SheetLinkData | null> = {
	products: { label: "All products →", href: "/products", external: false },
	resources: null,
};

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableElements(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}
