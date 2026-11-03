import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getProduct } from "../../data/products.tsx";
import { docsHref } from "../../data/resources.tsx";
import {
	AVAILABILITY_STATE_LABELS,
	ProductAvailabilityMatrix,
} from "./availability-matrix.tsx";
import {
	catalogGridColumnsClass,
	ProductCatalogGrid,
} from "./catalog-grid.tsx";
import { compareHref, ProductCompareLinks } from "./compare-links.tsx";
import { ProductDocsLinks } from "./docs-links.tsx";
import {
	explorerEntries,
	ProductFeatureExplorer,
} from "./feature-explorer.tsx";
import { FeatureExplorerTabs } from "./feature-explorer-tabs.tsx";
import { ProductGuardrailDemo } from "./guardrail-demo.tsx";
import {
	integrationProducts,
	ProductIntegrationGrid,
} from "./integration-grid.tsx";
import { ProductRelatedLinks } from "./related-links.tsx";
import {
	MIN_SECTION_NAV_ITEMS,
	ProductSectionNav,
	SECTION_ANCHOR_CLASS,
} from "./section-nav.tsx";
import { ProductSecurityPanel, SECURITY_LINKS } from "./security-panel.tsx";
import { ProductStatusBoard, STATUS_COLUMN_TITLES } from "./status-board.tsx";

// Fixtures only: these strings test rendering, not product claims.
const SOURCE = { path: "fixture.md" } as const;

function requireProduct(slug: string) {
	const product = getProduct(slug);
	if (!product) {
		throw new Error(`unknown product ${slug}`);
	}
	return product;
}

test("guardrail transcript labels verdicts in words, not colour alone", () => {
	const html = renderToStaticMarkup(
		<ProductGuardrailDemo
			demo={{
				title: "A blocked call",
				description: "Fixture description.",
				lines: [
					{ kind: "command", text: "call --tool fixture" },
					{ kind: "denied", text: "403 blocked by rule" },
					{ kind: "allowed", text: "200 ok" },
					{ kind: "output", text: "done" },
				],
				source: SOURCE,
			}}
		/>
	);
	expect(html).toContain('data-testid="product-guardrail"');
	expect(html).toMatch(
		/data-terminal-line="denied"[^>]*>.*Denied.*403 blocked by rule/s
	);
	expect(html).toMatch(/data-terminal-line="allowed"[^>]*>.*Allowed.*200 ok/s);
	expect(html).toContain("text-destructive");
	expect(html.match(/data-terminal-line=/g)?.length).toBe(4);
	expect(html).toContain("<figure");
});

test("security panel links the security page and security.txt, with points when given", () => {
	const bare = renderToStaticMarkup(<ProductSecurityPanel />);
	expect(bare).toContain('data-testid="product-security"');
	for (const link of SECURITY_LINKS) {
		expect(bare).toContain(`href="${link.href}"`);
	}
	expect(bare).toContain("report a vulnerability");
	const withPoints = renderToStaticMarkup(
		<ProductSecurityPanel
			security={{ points: [{ text: "Fixture point", source: SOURCE }] }}
		/>
	);
	expect(withPoints).toContain("Fixture point");
	expect(withPoints).not.toContain("report a vulnerability");
});

test("the explorer opens on an overview tab and renders every feature row", () => {
	const desktop = requireProduct("desktop");
	const entries = explorerEntries(desktop);
	expect(entries[0]?.label).toBe("Overview");
	expect(entries.length).toBe(1 + (desktop.splits?.length ?? 0));

	const html = renderToStaticMarkup(
		<ProductFeatureExplorer product={desktop} />
	);
	expect(html).toContain('data-testid="product-feature-explorer"');
	expect(html).toContain('data-testid="product-features"');
	expect(html.match(/role="tab"/g)?.length).toBe(entries.length);
	expect(html.match(/role="tabpanel"/g)?.length).toBe(entries.length);
	for (const split of desktop.splits ?? []) {
		expect(html).toContain(split.title);
	}
	expect(html).toContain(desktop.tagline);
	// Visual mocks are decoration: hidden from assistive tech.
	expect(html).toMatch(/aria-hidden="true"[^>]*data-product-visual/);
});

test("explorer tabs: one selected tab in the tab order, other panels hidden", () => {
	const html = renderToStaticMarkup(
		<FeatureExplorerTabs
			groupId="g"
			panels={[<p key="a">Panel A</p>, <p key="b">Panel B</p>]}
			tabs={[
				{ id: "a", label: "First" },
				{ id: "b", label: "Second" },
			]}
		/>
	);
	expect(html.match(/tabindex="0"[^>]*>/g)?.length).toBeGreaterThanOrEqual(1);
	expect(html).toMatch(/aria-selected="true"[^>]*id="g-a-tab"/);
	expect(html).toMatch(/aria-selected="false"[^>]*id="g-b-tab"/);
	expect(html).toMatch(/data-explorer-panel="b"[^>]*hidden=""/);
	expect(html).toContain("Panel B");
});

test("availability tiles state each platform in words", () => {
	const html = renderToStaticMarkup(
		<ProductAvailabilityMatrix
			rows={[
				{ platform: "macOS", state: "available", source: SOURCE },
				{ platform: "Linux", state: "early-access", source: SOURCE },
				{
					platform: "Phone",
					state: "planned",
					note: "Fixture note",
					source: SOURCE,
				},
				{ platform: "Watch", state: "not-planned", source: SOURCE },
			]}
		/>
	);
	expect(html).toContain('data-testid="product-availability"');
	for (const label of Object.values(AVAILABILITY_STATE_LABELS)) {
		expect(html).toContain(label);
	}
	expect(html).toContain('data-availability-state="planned"');
	// Only the not-yet-available tiles are marked quiet for banded sections.
	expect(html.match(/data-product-card-tone="quiet"/g)?.length).toBe(2);
	expect(html).toContain("Fixture note");
	expect(renderToStaticMarkup(<ProductAvailabilityMatrix rows={[]} />)).toBe(
		""
	);
});

test("catalog grid numbers its entries, shows the count, and links when it can", () => {
	const html = renderToStaticMarkup(
		<ProductCatalogGrid
			catalog={{
				title: "What is listed",
				subtitle: "Fixture subtitle",
				items: [
					{
						title: "Apps",
						description: "One",
						href: "/marketplace",
						source: SOURCE,
					},
					{ title: "Plugins", description: "Two", source: SOURCE },
					{
						title: "External",
						description: "Three",
						href: "https://example.test",
						source: SOURCE,
					},
				],
			}}
		/>
	);
	expect(html).toContain('data-testid="product-catalog"');
	expect(html).toContain('data-catalog-count="3"');
	expect(html).toMatch(/>3<\/span><span[^>]*>Listed below/);
	expect(html).toContain('href="/marketplace"');
	expect(html).toMatch(
		/href="https:\/\/example\.test"[^>]*rel="noopener noreferrer"/
	);
	expect(html).toContain(">02<");
});

test("catalog grid columns leave no lone card on the last row", () => {
	expect(catalogGridColumnsClass(2)).toBe("sm:grid-cols-2");
	expect(catalogGridColumnsClass(4)).toContain("lg:grid-cols-4");
	expect(catalogGridColumnsClass(9)).toContain("lg:grid-cols-3");
	expect(catalogGridColumnsClass(3)).toContain("lg:grid-cols-3");
});

test("status board labels planned work as not a commitment", () => {
	const html = renderToStaticMarkup(
		<ProductStatusBoard
			status={{
				today: [{ text: "Works today", source: SOURCE }],
				planned: [{ text: "Planned thing", source: SOURCE }],
			}}
		/>
	);
	expect(html).toContain('data-testid="product-status-board"');
	expect(html).toContain(STATUS_COLUMN_TITLES.planned);
	expect(STATUS_COLUMN_TITLES.planned).toBe("Planned (not a commitment)");
	expect(html).not.toContain('data-status-column="not-planned"');
	expect(html).toMatch(
		/data-product-card-tone="quiet" data-status-column="planned"/
	);
	expect(html).not.toMatch(
		/data-product-card-tone="quiet" data-status-column="today"/
	);
	expect(
		renderToStaticMarkup(
			<ProductStatusBoard
				status={{
					today: [],
					planned: [],
					notPlanned: [{ text: "Not this", source: SOURCE }],
				}}
			/>
		)
	).toContain('data-status-column="not-planned"');
	expect(
		renderToStaticMarkup(
			<ProductStatusBoard status={{ today: [], planned: [] }} />
		)
	).toBe("");
});

test("integrations show known products as cards and drop unknown slugs", () => {
	expect(integrationProducts(["gateway", "nope"]).map((p) => p.slug)).toEqual([
		"gateway",
	]);
	const html = renderToStaticMarkup(
		<ProductIntegrationGrid slugs={["gateway", "bot"]} />
	);
	expect(html).toContain('data-testid="product-integrations"');
	expect(html).toContain('href="/products/gateway"');
	expect(html).toContain('href="/bot"');
	expect(
		renderToStaticMarkup(<ProductIntegrationGrid slugs={["nope"]} />)
	).toBe("");
});

test("docs, related and compare links resolve to their real destinations", () => {
	const docs = renderToStaticMarkup(
		<ProductDocsLinks
			links={[
				{
					label: "Box API",
					path: "/docs/standalone/box-api",
					description: "Fixture",
				},
			]}
		/>
	);
	expect(docs).toContain('data-testid="product-docs"');
	expect(docs).toContain(`href="${docsHref("/docs/standalone/box-api")}"`);
	expect(docs).toContain('target="_blank"');
	// A long docs path or label must not widen a phone-width page: the list's
	// single column is minmax(0, 1fr) and each row may shrink below its text.
	expect(docs).toMatch(/<ul class="grid grid-cols-1 /);
	expect(docs).toMatch(/<li class="min-w-0 /);

	const related = renderToStaticMarkup(
		<ProductRelatedLinks
			links={[
				{ label: "A guide", href: "/guides/fixture", kind: "guide" },
				{ label: "A docs page", href: "/docs/core", kind: "docs" },
			]}
		/>
	);
	expect(related).toContain('data-testid="product-related"');
	expect(related).toContain('href="/guides/fixture"');
	expect(related).toContain(`href="${docsHref("/docs/core")}"`);
	expect(related).toContain(">Guide<");

	expect(compareHref("cursor")).toBe("/compare/cursor");
	const compare = renderToStaticMarkup(
		<ProductCompareLinks
			names={{ cursor: "Cursor" }}
			slugs={["cursor", "ai-studio"]}
		/>
	);
	expect(compare).toContain('data-testid="product-compare"');
	expect(compare).toContain('href="/compare/cursor"');
	expect(compare).toContain(">Cursor<");
	// No name given: the slug is shown as written, never a guessed brand name.
	expect(compare).toMatch(/font-mono">ai-studio</);
	expect(renderToStaticMarkup(<ProductCompareLinks slugs={[]} />)).toBe("");
});

test("section nav lists anchors and hides below its minimum", () => {
	const items = [
		{ id: "overview", label: "Overview" },
		{ id: "code", label: "Code" },
		{ id: "faq", label: "FAQ" },
	];
	const html = renderToStaticMarkup(
		<ProductSectionNav items={items} productName="Box" />
	);
	expect(html).toMatch(/^<nav aria-label="On this page"/);
	expect(html).toContain('href="#code"');
	expect(html).toContain(">Box<");
	// It sits below the sticky site header (top-0, z-50), never under it.
	expect(html).toContain("sticky top-18 z-40");
	expect(html).not.toContain("top-0 z-");
	expect(html).toContain("[body:has([data-header-hidden])_&amp;]:top-0");
	expect(SECTION_ANCHOR_CLASS).toBe("scroll-mt-32");
	expect(
		renderToStaticMarkup(
			<ProductSectionNav
				items={items.slice(0, MIN_SECTION_NAV_ITEMS - 1)}
				productName="Box"
			/>
		)
	).toBe("");
});
