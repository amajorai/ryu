import { productMenuGroupsFor } from "./data/product-realms.ts";
import {
	PLAN_LINKS,
	resourceCategories,
	resourcesByCategory,
} from "./data/resources.tsx";

// The link groups behind the mobile nav's Products and Resources sheets. They
// live apart from the animated sheet (./mobile-nav-sheet.tsx) so the bar can
// ship without it and the data stays importable on its own. Both sheets are
// built from the same data, groups, and footers as the desktop header's menus
// (./header-catalog-menus.tsx).

export interface SheetLinkData {
	/** The one-line summary shown under the name (from the shared nav data). */
	description?: string;
	external: boolean;
	href: string;
	label: string;
}

export interface SheetGroup {
	links: readonly SheetLinkData[];
	title: string;
}

export const NO_HIDDEN_PRODUCTS: readonly string[] = [];

/**
 * Available products only, one group per nav group, without the realms the host
 * has not rolled out. Early-access and coming-soon products stay on /products,
 * which the sheet's "All products" link opens, exactly as in the desktop menu.
 */
export function productSheet(
	hiddenProductIds: readonly string[]
): SheetGroup[] {
	return productMenuGroupsFor(hiddenProductIds).map((group) => ({
		title: group.title,
		links: group.items.map(({ description, label, href }) => ({
			description,
			label,
			href,
			external: false,
		})),
	}));
}

export const PRODUCT_SHEET: readonly SheetGroup[] =
	productSheet(NO_HIDDEN_PRODUCTS);

/** Plans, then the desktop Resources menu's Learn, Updates, and Community. */
export const RESOURCE_SHEET: readonly SheetGroup[] = [
	{
		title: "Plans",
		links: PLAN_LINKS.map((link) => ({ ...link, external: false })),
	},
	...resourceCategories.map((category) => ({
		title: category,
		links: resourcesByCategory(category).map((resource) => ({
			description: resource.description,
			label: resource.label,
			href: resource.href,
			// External entries (the Docs link among them) open in a new tab, as
			// they do in the desktop Resources menu.
			external: resource.external ?? false,
		})),
	})),
];

export const SHEET_TITLES = {
	products: "Products",
	resources: "Resources",
} as const;

export type SheetKey = keyof typeof SHEET_TITLES;

/** The desktop menus' footer links: Products has two, Resources none. */
export const SHEET_FOOTERS: Record<SheetKey, readonly SheetLinkData[]> = {
	products: [
		{ label: "All products →", href: "/products", external: false },
		{ label: "How it fits together →", href: "/platform", external: false },
	],
	resources: [],
};

/**
 * The group a sheet opens on: the one that holds the current page, or the
 * first group when the page is not in this sheet.
 */
export function initialSheetGroup(
	groups: readonly SheetGroup[],
	pathname: string
): string | undefined {
	const current = groups.find((group) =>
		group.links.some(
			(link) =>
				!link.external &&
				(pathname === link.href || pathname.startsWith(`${link.href}/`))
		)
	);
	return (current ?? groups[0])?.title;
}

// A collapsed section, or one still animating closed.
const HIDDEN_SECTION_SELECTOR =
	'[hidden], [inert], [data-slot="accordion-content"][data-closed]';

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Tabbable controls in the sheet, skipping anything inside a collapsed or
 * closing section, so the focus trap never lands on a hidden link.
 */
export function focusableElements(root: HTMLElement): HTMLElement[] {
	return Array.from(
		root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
	).filter((element) => !element.closest(HIDDEN_SECTION_SELECTOR));
}
