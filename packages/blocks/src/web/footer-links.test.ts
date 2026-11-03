import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { bannedCopyHits } from "./data/banned-copy.ts";
import { COMPANY_PROFILES, COMPANY_ROUTES } from "./data/company.ts";
import { productMap, products } from "./data/products.tsx";
import {
	allFooterLinks,
	FOOTER_COLUMNS,
	FOOTER_COMMUNITY_LINKS,
	FOOTER_DOCS_HOME,
	FOOTER_LEGAL_LINKS,
	FOOTER_START_LINKS,
	FOOTER_TAGLINE,
	type FooterLink,
	footerColumnsFor,
	footerProductSlug,
} from "./footer-links.ts";

const repoRoot = new URL("../../../../", import.meta.url);
const exists = (path: string) => existsSync(new URL(path, repoRoot));
const APP_DIR = "apps/web/src/app";
const PRODUCT_SLUG = /^\/products\/([^/]+)$/u;

const pathOf = (href: string) => href.split("#")[0] ?? href;
const siteLinks = () =>
	allFooterLinks().filter((link) => (link.kind ?? "site") === "site");
const hrefsOf = (links: readonly FooterLink[]) =>
	links.map((link) => link.href);

const ROUTE_FILES = ["page.tsx", "page.ts", "route.ts", "route.tsx"];

/** A static route directory (or one of its `(group)` folders) with a page or a handler. */
function hasAppRoute(path: string) {
	const dir = `${APP_DIR}${path === "/" ? "" : path}`;
	if (!exists(dir)) {
		return false;
	}
	const groups = readdirSync(new URL(dir, repoRoot)).filter((name) =>
		/^\(.+\)$/u.test(name)
	);
	return [dir, ...groups.map((group) => `${dir}/${group}`)].some((folder) =>
		ROUTE_FILES.some((file) => exists(`${folder}/${file}`))
	);
}

const DRAFT_FRONTMATTER = /^---\n[\s\S]*?^draft:\s*true\s*$[\s\S]*?^---$/mu;

/**
 * A CMS page served by `app/[slug]` from `apps/web/content/pages`. A draft is
 * never routed, so it does not count.
 */
function hasCmsPage(path: string) {
	if (!/^\/[a-z0-9-]+$/u.test(path)) {
		return false;
	}
	const file = `apps/web/content/pages${path}.mdx`;
	if (!exists(file)) {
		return false;
	}
	const source = readFileSync(new URL(file, repoRoot), "utf8");
	return !DRAFT_FRONTMATTER.test(source);
}

test("the six columns read Products, Platform, Build, Resources, Company, Programs", () => {
	expect(FOOTER_COLUMNS.map((column) => column.title)).toEqual([
		"Products",
		"Platform",
		"Build",
		"Resources",
		"Company",
		"Programs",
	]);
	for (const column of FOOTER_COLUMNS) {
		expect([column.title, column.links.length >= 3]).toEqual([
			column.title,
			true,
		]);
		expect([column.title, column.links.length <= 9]).toEqual([
			column.title,
			true,
		]);
	}
});

test("every footer href appears once, and Contact only in the legal row", () => {
	const hrefs = hrefsOf(allFooterLinks());
	expect(new Set(hrefs).size).toBe(hrefs.length);
	expect(hrefs.filter((href) => href === COMPANY_ROUTES.contact)).toHaveLength(
		1
	);
	expect(hrefsOf(FOOTER_LEGAL_LINKS)).toEqual([
		"/privacy",
		"/terms",
		"/dpa",
		"/subprocessors",
		"/contact",
	]);
	const columnHrefs = FOOTER_COLUMNS.flatMap((column) => hrefsOf(column.links));
	for (const legal of hrefsOf(FOOTER_LEGAL_LINKS)) {
		expect(columnHrefs).not.toContain(legal);
	}
});

test("every site link resolves to a route or a published CMS page", () => {
	const unresolved = siteLinks()
		.map((link) => pathOf(link.href))
		.filter((path) => {
			const slug = PRODUCT_SLUG.exec(path)?.[1];
			if (slug && !hasAppRoute(path)) {
				return !(
					exists(`${APP_DIR}/products/[slug]/page.tsx`) && productMap[slug]
				);
			}
			return !(hasAppRoute(path) || hasCmsPage(path));
		});
	expect(unresolved).toEqual([]);
});

test("company routes are linked from the Company and Resources columns", () => {
	const company = FOOTER_COLUMNS.find((column) => column.title === "Company");
	expect(hrefsOf(company?.links ?? [])).toEqual(
		expect.arrayContaining([
			COMPANY_ROUTES.about,
			COMPANY_ROUTES.manifesto,
			COMPANY_ROUTES.careers,
			COMPANY_ROUTES.press,
			COMPANY_ROUTES.brandAssets,
			COMPANY_ROUTES.events,
		])
	);
	const resources = FOOTER_COLUMNS.find(
		(column) => column.title === "Resources"
	);
	expect(hrefsOf(resources?.links ?? [])).toContain(
		COMPANY_ROUTES.knowledgeBase
	);
	// Help Center stays in the footer after the header swaps it out.
	expect(hrefsOf(resources?.links ?? [])).toContain("/help");
});

test("docs links point at real docs pages", () => {
	const docs = allFooterLinks().filter((link) => link.kind === "docs");
	expect(docs.map((link) => link.label)).toEqual(["API reference", "Docs"]);
	for (const link of docs) {
		if (link.href === FOOTER_DOCS_HOME) {
			continue;
		}
		const path = link.href.replace(/^\/docs\//u, "");
		const base = `apps/fumadocs/content/docs/${path}`;
		expect([
			link.href,
			exists(`${base}.mdx`) || exists(`${base}/index.mdx`),
		]).toEqual([link.href, true]);
	}
});

test("product links name released catalog products only", () => {
	const linked = allFooterLinks().flatMap((link) => {
		const slug = footerProductSlug(link);
		return slug && productMap[slug] ? [slug] : [];
	});
	expect(linked.length).toBeGreaterThan(10);
	for (const slug of linked) {
		expect([slug, productMap[slug]?.status]).toEqual([slug, undefined]);
	}
	// /products/apps is its own route, not a catalog product.
	expect(hasAppRoute("/products/apps")).toBe(true);
});

test("Platform lists every released standalone service", () => {
	const released = products
		.filter((product) => product.category === "Agent APIs" && !product.status)
		.map((product) => `/products/${product.slug}`);
	expect(released.length).toBeGreaterThan(0);
	const platform = FOOTER_COLUMNS.find((column) => column.title === "Platform");
	expect(hrefsOf(platform?.links ?? [])).toEqual(
		expect.arrayContaining(released)
	);
	expect(hrefsOf(platform?.links ?? [])).toContain("/platform#infra");
	expect(FOOTER_COLUMNS.map((column) => column.title)).not.toContain(
		"Agent APIs"
	);
});

test("hidden products drop out at render time, and empty columns go", () => {
	const visible = footerColumnsFor(["mail", "workflows", "red-team"]);
	const titles = visible.map((column) => column.title);
	expect(titles).toEqual(FOOTER_COLUMNS.map((column) => column.title));
	const hrefs = visible.flatMap((column) => hrefsOf(column.links));
	expect(hrefs).not.toContain("/products/mail");
	expect(hrefs).not.toContain("/products/workflows");
	expect(hrefs).not.toContain("/products/red-team");
	expect(hrefs).toContain("/products/core");
	// The shared data is never edited.
	expect(hrefsOf(FOOTER_COLUMNS[1]?.links ?? [])).toContain("/products/mail");

	const programs = FOOTER_COLUMNS.find((column) => column.title === "Programs");
	expect(programs).toBeDefined();
	// A docs or external link is never treated as a product page.
	expect(
		footerProductSlug({ href: "/products/core", kind: "docs", label: "x" })
	).toBeUndefined();
});

test("community links leave GitHub to the build row and name each profile", () => {
	const external = FOOTER_COMMUNITY_LINKS.filter(
		(link) => link.kind === "external"
	);
	expect(external.map((link) => link.href)).toEqual(
		COMPANY_PROFILES.filter((profile) => profile.id !== "github").map(
			(profile) => profile.href
		)
	);
	expect(
		allFooterLinks().some((link) => link.href.includes("github.com"))
	).toBe(false);
	for (const link of FOOTER_COMMUNITY_LINKS) {
		if (link.ariaLabel) {
			// The accessible name contains the visible label (WCAG 2.5.3).
			expect(link.ariaLabel).toContain(link.label);
		}
	}
	expect(hrefsOf(FOOTER_COMMUNITY_LINKS)).toEqual(
		expect.arrayContaining(["/community", "/discord"])
	);
	for (const link of external) {
		expect(link.href.startsWith("https://")).toBe(true);
	}
});

test("the lead band leads with Download and keeps the sign-in path", () => {
	expect(hrefsOf(FOOTER_START_LINKS)).toEqual([
		"/download",
		"/pricing",
		"/subscriptions",
		"/login",
	]);
	expect(FOOTER_TAGLINE).toBe("Run agents with the tools and rules they need.");
});

test("footer copy avoids banned marketing words", () => {
	const copy = allFooterLinks().flatMap((link) => [
		link.label,
		link.ariaLabel ?? "",
	]);
	expect(
		bannedCopyHits([
			...copy,
			FOOTER_TAGLINE,
			...FOOTER_COLUMNS.map((c) => c.title),
		])
	).toEqual([]);
});

test("company routes resolve like any other link, and drafts do not count", () => {
	for (const href of Object.values(COMPANY_ROUTES)) {
		const path = pathOf(href);
		expect([path, hasAppRoute(path) || hasCmsPage(path)]).toEqual([path, true]);
	}
	// about.mdx is a draft source file; /about resolves through its app route.
	expect(exists("apps/web/content/pages/about.mdx")).toBe(true);
	expect(hasCmsPage("/about")).toBe(false);
	expect(hasCmsPage("/manifesto")).toBe(true);
});

test("the route check sees the app directory", () => {
	// Guards the resolver above against a wrong repo root.
	expect(readdirSync(new URL(APP_DIR, repoRoot)).length).toBeGreaterThan(10);
});
