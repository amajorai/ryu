import { expect, test } from "bun:test";
import type { Product } from "../data/products.tsx";
import { getProduct } from "../data/products.tsx";
import { docsHref } from "../data/resources.tsx";
import { productDocsPath } from "./product-docs-path.ts";

function product(slug: string): Product {
	const found = getProduct(slug);
	if (!found) {
		throw new Error(`unknown product ${slug}`);
	}
	return found;
}

test("finds the docs path behind a primary or secondary Read the docs CTA", () => {
	// Mail leads with the docs; Core keeps them as its secondary CTA.
	expect(product("mail").hero.primaryCta.label).toBe("Read the docs");
	expect(productDocsPath(product("mail"))).toBe("/docs/standalone/mail");
	expect(productDocsPath(product("core"))).toBe("/docs/core");
	expect(productDocsPath(product("cli"))).toBe(
		"/docs/surfaces/cli/getting-started"
	);
});

test("returns undefined when no CTA points at the docs site", () => {
	expect(productDocsPath(product("bot"))).toBeUndefined();
	const base = product("core");
	const withoutDocs: Product = {
		...base,
		hero: { ...base.hero, secondaryCta: undefined },
		cta: { ...base.cta, secondaryCta: undefined },
	};
	expect(productDocsPath(withoutDocs)).toBeUndefined();
});

test("only external links on the docs origin count", () => {
	const base = product("bot");
	const internal: Product = {
		...base,
		hero: {
			...base.hero,
			secondaryCta: { label: "Docs", href: "/docs/core" },
		},
	};
	expect(productDocsPath(internal)).toBeUndefined();
	const docs: Product = {
		...base,
		cta: {
			...base.cta,
			secondaryCta: {
				label: "Read the docs",
				href: docsHref("/docs/surfaces/"),
				external: true,
			},
		},
	};
	expect(productDocsPath(docs)).toBe("/docs/surfaces");
});
