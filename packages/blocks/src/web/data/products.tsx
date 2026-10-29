import { COMPUTE_TO_MCP } from "./catalog/compute-mcp.tsx";
import { CONNECTIONS_TO_OS } from "./catalog/connections-os.tsx";
import { CORE_TO_BOX } from "./catalog/core-box.tsx";
import { DESKTOP_TO_DEVICES } from "./catalog/desktop-devices.tsx";
import { MARKETPLACE_TO_RED_TEAM } from "./catalog/marketplace-red-team.tsx";
import { NOTIFY_TO_HIRE } from "./catalog/notify-hire.tsx";
import type {
	Product,
	ProductCategory,
	ProductStatus,
} from "./product-types.ts";

export type {
	Product,
	ProductCategory,
	ProductStatus,
} from "./product-types.ts";

/**
 * The /products catalogue, in its canonical order. The entries live in
 * `./catalog/` (split only to keep each file small); this module is the stable
 * import path.
 */
export const products: Product[] = [
	...CORE_TO_BOX,
	...NOTIFY_TO_HIRE,
	...COMPUTE_TO_MCP,
	...CONNECTIONS_TO_OS,
	...DESKTOP_TO_DEVICES,
	...MARKETPLACE_TO_RED_TEAM,
];

export const productMap: Record<string, Product> = Object.fromEntries(
	products.map((p) => [p.slug, p])
);

export function getProduct(slug: string): Product | undefined {
	return productMap[slug];
}

/** Canonical group order, shared with the header nav and footer. */
export const productCategories: ProductCategory[] = [
	"Workspaces",
	"Build",
	"Platform",
	"Agent APIs",
];

/** Canonical order of products inside each group. */
const CATEGORY_ORDER: Record<ProductCategory, readonly string[]> = {
	Workspaces: [
		"bot",
		"os",
		"agent",
		"desktop",
		"island",
		"mobile",
		"chrome-extension",
		"devices",
	],
	Build: [
		"agents",
		"workflows",
		"skills",
		"mcp",
		"connections",
		"marketplace",
		"extensions",
		"sdk",
		"cli",
	],
	Platform: ["core", "gateway", "cloud", "agents-as-a-service", "red-team"],
	"Agent APIs": [
		"connect",
		"passport",
		"box",
		"mail",
		"messaging",
		"notify",
		"sites",
		"compute",
		"share",
		"hire",
	],
};

export function productsByCategory(category: ProductCategory): Product[] {
	return CATEGORY_ORDER[category]
		.map((slug) => productMap[slug])
		.filter((product): product is Product => product?.category === category);
}

const STATUS_LABELS: Record<ProductStatus, string> = {
	"early-access": "Early access",
	"coming-soon": "Coming soon",
};

/** Short label for a pre-release product, or undefined when it is available. */
export function productStatusLabel(product: Product): string | undefined {
	return product.status ? STATUS_LABELS[product.status] : undefined;
}
