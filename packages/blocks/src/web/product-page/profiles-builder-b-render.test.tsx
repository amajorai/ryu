import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getProduct } from "../data/products.tsx";
import ProductLandingPage from "../product-landing-page.tsx";
import { PRODUCT_SECTION_MARKERS } from "./archetypes.ts";
import type { ProductSectionKey } from "./profile-types.ts";
import {
	PROFILE_SLUGS,
	PROFILES,
	type ProfileSlug,
} from "./profiles-builder-b.ts";

function renderPage(slug: ProfileSlug): string {
	const product = getProduct(slug);
	if (!product) {
		throw new Error(`unknown product ${slug}`);
	}
	return renderToStaticMarkup(<ProductLandingPage product={product} />);
}

const pages = new Map(PROFILE_SLUGS.map((slug) => [slug, renderPage(slug)]));

function page(slug: ProfileSlug): string {
	return pages.get(slug) ?? "";
}

/** Sections every builder-b page renders from its profile. */
const FROM_PROFILE: readonly ProductSectionKey[] = [
	"code",
	"quickstart",
	"at-a-glance",
	"related",
	"docs",
];

/** HTML-escape a value the way React writes text content. */
function escaped(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#x27;");
}

describe.each(PROFILE_SLUGS)("%s product page", (slug) => {
	test("renders its profile sections", () => {
		for (const key of FROM_PROFILE) {
			expect(page(slug)).toContain(PRODUCT_SECTION_MARKERS[key](slug));
		}
	});

	test("opens the body on code, before the statement", () => {
		const html = page(slug);
		const code = html.indexOf(PRODUCT_SECTION_MARKERS.code(slug));
		const statement = html.indexOf(PRODUCT_SECTION_MARKERS.statement(slug));
		expect(code).toBeGreaterThan(-1);
		expect(statement).toBeGreaterThan(code);
	});

	test("the quickstart replaces the generic three steps", () => {
		expect(page(slug)).not.toContain(
			PRODUCT_SECTION_MARKERS["how-it-works"](slug)
		);
	});

	test("shows every profile fact, quickstart step and command", () => {
		const entry = PROFILES[slug];
		for (const fact of entry?.facts ?? []) {
			expect(page(slug)).toContain(escaped(fact.value));
		}
		for (const step of entry?.quickstart ?? []) {
			expect(page(slug)).toContain(escaped(step.title));
			if (step.command) {
				expect(page(slug)).toContain(escaped(step.command));
			}
		}
	});

	test("labels every code tab", () => {
		for (const sample of PROFILES[slug]?.code ?? []) {
			expect(page(slug)).toContain(escaped(sample.label));
		}
	});
});

test("Agents and Workflows link their comparisons; Extensions has none", () => {
	expect(page("agents")).toContain('href="/compare/openai-agent-builder"');
	expect(page("workflows")).toContain('href="/compare/n8n"');
	expect(page("extensions")).not.toContain(
		PRODUCT_SECTION_MARKERS.compare("extensions")
	);
});

test("each page shows its own code first", () => {
	expect(page("extensions")).toContain("permission_grants");
	expect(page("agents")).toContain("ryu-cli agents create");
	expect(page("workflows")).toContain("wf_security_review");
	expect(page("extensions")).not.toContain("ryu-cli agents");
	expect(page("agents")).not.toContain("wf_security_review");
	expect(page("workflows")).not.toContain("tool_filters");
});
