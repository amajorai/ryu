import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getProduct } from "../../data/products.tsx";
import {
	ARCHETYPE_SECTION_ORDER,
	figureFollowsHero,
	PRODUCT_ARCHETYPES,
	PRODUCT_SECTION_MARKERS,
	PRODUCT_SIDE_BY_SIDE_TEST_ID,
} from "../archetypes.ts";
import type {
	ProductArchetypeId,
	ProductProfile,
	ProductSectionKey,
} from "../profile-types.ts";
import { ArchetypeLayout } from "./archetype-layout.tsx";
import {
	ARCHETYPE_THEMES,
	BAND_CLASSES,
	RHYTHM_CLASSES,
} from "./archetype-theme.ts";
import { codeLayoutFor, profileSlots } from "./profile-slots.tsx";
import { buildSectionSlots } from "./section-slots.tsx";

// Fixture profile: every optional field set, so each archetype shows every
// section its order allows. Strings test rendering only, not product claims.
const SOURCE = { path: "fixture.md", quote: "fixture" } as const;
const FULL: ProductProfile = {
	facts: [
		{ label: "Fixture fact", value: "One", source: SOURCE },
		{ label: "Second fixture", value: "Two", source: SOURCE },
	],
	code: [
		{
			id: "a",
			label: "Shell",
			language: "bash",
			code: "fixture",
			source: SOURCE,
		},
	],
	architecture: {
		title: "Fixture flow",
		nodes: [
			{ label: "In", detail: "a" },
			{ label: "Through", detail: "b" },
			{ label: "Out", detail: "c" },
		],
		source: SOURCE,
	},
	interfaces: [
		{ kind: "REST", name: "Fixture API", summary: "x", source: SOURCE },
	],
	limits: {
		title: "Fixture limits",
		rows: [{ label: "Rate", value: "1", source: SOURCE }],
	},
	quickstart: [
		{ title: "First", description: "x", command: "fixture", source: SOURCE },
		{ title: "Second", description: "y" },
	],
	comparison: {
		title: "Fixture comparison",
		columns: ["A", "B"],
		rows: [{ label: "Row", values: ["1", "2"] }],
		source: SOURCE,
	},
	guardrail: {
		title: "Fixture guardrail",
		description: "x",
		lines: [{ kind: "denied", text: "no" }],
		source: SOURCE,
	},
	availability: [
		{ platform: "Fixture OS", state: "available", source: SOURCE },
	],
	catalog: {
		title: "Fixture catalog",
		items: [{ title: "Kind", description: "x", source: SOURCE }],
	},
	status: {
		today: [{ text: "Fixture today", source: SOURCE }],
		planned: [{ text: "Fixture planned", source: SOURCE }],
	},
	docs: [{ label: "Fixture docs", path: "/docs/core" }],
	related: [{ label: "Fixture guide", href: "/guides/fixture", kind: "guide" }],
	openapi: {
		href: "/openapi/box.json",
		baseUrl: "https://box.example.test",
		source: SOURCE,
	},
	compareSlugs: ["cursor"],
	security: { points: [{ text: "Fixture security point", source: SOURCE }] },
};

const SAMPLE_SLUG: Record<ProductArchetypeId, string> = {
	infrastructure: "core",
	"agent-api": "box",
	builder: "sdk",
	workspace: "desktop",
	catalog: "marketplace",
	preview: "devices",
};

function product(slug: string) {
	const found = getProduct(slug);
	if (!found) {
		throw new Error(`unknown product ${slug}`);
	}
	return found;
}

function render(slug: string, profile?: ProductProfile) {
	return renderToStaticMarkup(
		<ArchetypeLayout
			compareNames={{ cursor: "Cursor" }}
			product={product(slug)}
			profile={profile ?? null}
		/>
	);
}

/** The body section keys in DOM order, read from the slot wrappers. */
function bodyKeys(html: string): string[] {
	return [...html.matchAll(/data-product-section="([^"]+)"/g)].map(
		(match) => match[1] ?? ""
	);
}

test("every archetype renders its rendered sections in its declared order", () => {
	for (const archetype of PRODUCT_ARCHETYPES) {
		const slug = SAMPLE_SLUG[archetype];
		const html = render(slug, FULL);
		const keys = bodyKeys(html);
		// The figure joins the head only when it sits directly under the hero.
		const order = ARCHETYPE_SECTION_ORDER[archetype].filter(
			(key) =>
				key !== "hero" && (key !== "figure" || !figureFollowsHero(archetype))
		);
		expect(keys).toEqual(order.filter((key) => keys.includes(key)));
		// Every rendered key's marker sits in the same order.
		// The figure's marker also occurs in inline figure CSS, so a body figure
		// is located by its slot wrapper.
		const positions = (["hero", ...keys] as ProductSectionKey[]).map((key) =>
			html.indexOf(
				key === "figure"
					? 'data-product-section="figure"'
					: PRODUCT_SECTION_MARKERS[key](slug)
			)
		);
		expect(positions.every((position) => position > -1)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(html.match(/<h1/g)?.length).toBe(1);
	}
});

test("a full profile fills the archetype's signature sections", () => {
	const expectations: Record<ProductArchetypeId, ProductSectionKey[]> = {
		infrastructure: [
			"at-a-glance",
			"architecture",
			"code",
			"guardrail",
			"comparison",
			"security",
			"docs",
		],
		"agent-api": [
			"code",
			"interfaces",
			"api",
			"limits",
			"guardrail",
			"quickstart",
			"integrations",
		],
		builder: ["code", "quickstart", "at-a-glance", "integrations", "docs"],
		workspace: ["explorer", "availability", "at-a-glance", "integrations"],
		catalog: ["catalog", "at-a-glance", "works-with"],
		preview: ["status-board", "availability", "at-a-glance"],
	};
	for (const archetype of PRODUCT_ARCHETYPES) {
		const keys = bodyKeys(render(SAMPLE_SLUG[archetype], FULL));
		for (const key of expectations[archetype]) {
			expect(`${archetype}:${keys.includes(key)}`).toBe(`${archetype}:true`);
		}
	}
	// A quickstart replaces the explainer's steps on API and builder pages.
	expect(bodyKeys(render("box", FULL))).not.toContain("how-it-works");
	expect(bodyKeys(render("box"))).toContain("how-it-works");
	// Workspaces show feature rows inside the explorer, never twice.
	expect(bodyKeys(render("desktop", FULL))).not.toContain("features");
});

test("archetypes differ in composition, rhythm and bands", () => {
	const sequences = new Set(
		PRODUCT_ARCHETYPES.map((archetype) =>
			bodyKeys(render(SAMPLE_SLUG[archetype], FULL)).join(",")
		)
	);
	expect(sequences.size).toBe(PRODUCT_ARCHETYPES.length);
	expect(render("box", FULL)).toContain('data-product-rhythm="dense"');
	expect(render("devices", FULL)).toContain('data-product-rhythm="airy"');
	expect(render("core", FULL)).toMatch(
		/data-product-band="muted" data-product-section="at-a-glance"/
	);
	const sdk = render("sdk", FULL);
	expect(sdk).toMatch(
		/class="[^"]*\bdark\b[^"]*" data-product-band="inverse" data-product-section="code"/
	);
	// Builder pages open on code: it is the first body section.
	expect(bodyKeys(sdk)[0]).toBe("code");
});

test("agent APIs pair code with the ways to call it on one band", () => {
	const html = render("box", FULL);
	expect(html).toContain(`data-testid="${PRODUCT_SIDE_BY_SIDE_TEST_ID}"`);
	const band = html.slice(html.indexOf(PRODUCT_SIDE_BY_SIDE_TEST_ID));
	expect(band.indexOf('data-testid="product-code"')).toBeLessThan(
		band.indexOf('data-testid="product-interfaces"')
	);
	// Inside the band the interfaces are the compact list, not the wide table.
	expect(
		band.slice(0, band.indexOf('data-product-section="api"'))
	).not.toContain("<table");
	const unpaired = render("box", { ...FULL, interfaces: undefined });
	expect(unpaired).not.toContain(PRODUCT_SIDE_BY_SIDE_TEST_ID);
	expect(unpaired).toContain('data-testid="product-code"');
});

test("every sub-nav anchor points at an element on the page, pricing included", () => {
	for (const slug of [...Object.values(SAMPLE_SLUG), "gateway", "mail"]) {
		const html = render(slug, FULL);
		const nav =
			html.match(/<nav aria-label="On this page".*?<\/nav>/s)?.[0] ?? "";
		const anchors = [...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
		expect(anchors.length).toBeGreaterThanOrEqual(3);
		expect(new Set(anchors).size).toBe(anchors.length);
		for (const anchor of anchors) {
			expect(html).toContain(`id="${anchor}"`);
		}
		if (html.includes('href="#pricing"')) {
			expect(html).toMatch(/id="pricing"[^>]*>|<div[^>]*id="pricing"/);
		}
	}
	expect(render("box")).toContain('id="pricing"');
});

test("without a profile a page keeps its authored content and drops profile sections", () => {
	const html = render("core");
	for (const key of ["code", "architecture", "comparison", "docs"] as const) {
		expect(html).not.toContain(PRODUCT_SECTION_MARKERS[key]("core"));
	}
	// Infrastructure always links the security overview.
	expect(html).toContain('data-testid="product-security"');
	expect(html).toContain('data-testid="product-at-a-glance"');
	// Only the infrastructure order has a security slot.
	expect(render("box", FULL)).not.toContain('data-testid="product-security"');
	expect(render("core", FULL)).toContain("Fixture security point");
	expect(render("core", FULL)).toContain(">Cursor<");
});

test("slots: profile keys are null without a profile, layout helpers pick the right frame", () => {
	const context = {
		archetype: "agent-api" as const,
		product: product("box"),
		theme: ARCHETYPE_THEMES["agent-api"],
	};
	const empty = profileSlots(context);
	expect(Object.values(empty).every((slot) => slot === null)).toBe(true);
	const slots = buildSectionSlots({ ...context, profile: FULL });
	expect(slots.hero).not.toBeNull();
	expect(slots["how-it-works"]).toBeNull();
	expect(slots.pricing).not.toBeNull();
	expect(
		buildSectionSlots({ ...context, product: product("sites") }).pricing
	).toBeNull();
	expect(codeLayoutFor(true, "lead")).toBe("column");
	expect(codeLayoutFor(false, "column")).toBe("stacked");
	expect(codeLayoutFor(false, "lead")).toBe("lead");
});

test("themes cover every archetype and only band sections their order lists", () => {
	for (const archetype of PRODUCT_ARCHETYPES) {
		const theme = ARCHETYPE_THEMES[archetype];
		for (const key of Object.keys(theme.bands)) {
			expect(ARCHETYPE_SECTION_ORDER[archetype]).toContain(
				key as ProductSectionKey
			);
		}
		expect(RHYTHM_CLASSES[theme.rhythm]).toContain("data-product-slot=plain");
	}
	expect(BAND_CLASSES.inverse.split(" ")).toContain("dark");
	// The island must still stand apart when the whole page is dark.
	expect(BAND_CLASSES.inverse.split(" ")).toContain("dark:bg-muted");
	expect(BAND_CLASSES.muted).toContain("[data-product-card]");
	// Quiet cards keep a fainter tone than emphasised ones inside a band.
	expect(BAND_CLASSES.muted.split(" ")).toContain(
		"[&_[data-product-card][data-product-card-tone=quiet]]:bg-background/40"
	);
});
