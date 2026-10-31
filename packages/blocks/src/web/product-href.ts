import type { Product } from "./data/products.tsx";

/** Bot and Agent have their own short routes; everything else is under /products. */
const SHORT_ROUTES = new Map([
	["bot", "/bot"],
	["agent", "/agent"],
]);

/**
 * A product's marketing route. Plain module on purpose: server components
 * (the product explainer pages) call it, so it must not live in a
 * `"use client"` file, where Next turns it into a client reference that
 * throws when called during prerender.
 */
export function productHref(product: Pick<Product, "slug">): string {
	return SHORT_ROUTES.get(product.slug) ?? `/products/${product.slug}`;
}
