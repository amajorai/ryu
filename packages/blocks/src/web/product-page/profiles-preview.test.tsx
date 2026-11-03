import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { bannedCopyHits } from "../data/banned-copy.ts";
import { getProduct } from "../data/products.tsx";
import ProductLandingPage from "../product-landing-page.tsx";
import { getProductArchetype, PRODUCT_SECTION_MARKERS } from "./archetypes.ts";
import { productDocsPath } from "./product-docs-path.ts";
import { groundingErrors } from "./profile-grounding.ts";
import type { ProductProfile, ProductSectionKey } from "./profile-types.ts";
import {
	getProductProfile,
	profileCopyStrings,
	profileGaps,
	profileShapeErrors,
} from "./profiles.ts";
import {
	ARCHETYPE,
	PROFILE_SLUGS,
	PROFILES,
	type ProfileSlug,
} from "./profiles-preview.ts";
import {
	DEVICES_PROFILE,
	ISLAND_PROFILE,
	MOBILE_PROFILE,
} from "./profiles-preview-surfaces.ts";
import { AVAILABILITY_STATE_LABELS } from "./sections/availability-matrix.tsx";
import { STATUS_COLUMN_TITLES } from "./sections/status-board.tsx";

function profile(slug: ProfileSlug): ProductProfile {
	const found = PROFILES[slug];
	if (!found) {
		throw new Error(`no profile for ${slug}`);
	}
	return found;
}

function renderPage(slug: ProfileSlug): string {
	const product = getProduct(slug);
	if (!product) {
		throw new Error(`unknown product ${slug}`);
	}
	return renderToStaticMarkup(<ProductLandingPage product={product} />);
}

/** HTML-escape a value the way React writes text content. */
function escaped(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#x27;");
}

const pages = new Map(PROFILE_SLUGS.map((slug) => [slug, renderPage(slug)]));

function page(slug: ProfileSlug): string {
	return pages.get(slug) ?? "";
}

function at(slug: ProfileSlug, key: ProductSectionKey): number {
	return page(slug).indexOf(PRODUCT_SECTION_MARKERS[key](slug));
}

/** Labels the base facts already use; a profile fact must not repeat them. */
const BASE_FACT_LABELS = ["Availability", "Category", "Pricing", "Docs"];

/** Surfaces with a "where it runs" matrix; the exchange pages and Hire have none. */
const WITH_AVAILABILITY: readonly ProfileSlug[] = [
	"island",
	"mobile",
	"devices",
];

describe.each(PROFILE_SLUGS)("%s profile", (slug) => {
	const entry = profile(slug);
	const status = entry.status;

	test("is the preview archetype and is registered", () => {
		expect(ARCHETYPE).toBe("preview");
		expect(getProductArchetype(slug)).toBe("preview");
		expect(getProductProfile(slug)).toBe(entry);
	});

	test("meets every requirement of its page", () => {
		expect(profileGaps(slug)).toEqual([]);
		expect(profileShapeErrors(entry)).toEqual([]);
	});

	test("is grounded in real repo files and quotes", () => {
		expect(groundingErrors(entry)).toEqual([]);
	});

	test("uses no banned copy and states no price", () => {
		const copy = profileCopyStrings(entry);
		expect(bannedCopyHits(copy)).toEqual([]);
		expect(copy.filter((text) => /\$\s?\d/.test(text))).toEqual([]);
	});

	test("adds its own facts without repeating a base fact", () => {
		const labels = entry.facts.map((fact) => fact.label);
		expect(labels.length).toBeGreaterThanOrEqual(3);
		expect(new Set(labels).size).toBe(labels.length);
		expect(labels.filter((label) => BASE_FACT_LABELS.includes(label))).toEqual(
			[]
		);
	});

	test("has a status board that says what works today and what is planned", () => {
		expect(status?.planned.length ?? 0).toBeGreaterThanOrEqual(2);
		expect(status?.today.length ?? 0).toBeGreaterThanOrEqual(2);
		const texts = [
			...(status?.today ?? []),
			...(status?.planned ?? []),
			...(status?.notPlanned ?? []),
		].map((item) => item.text);
		expect(new Set(texts).size).toBe(texts.length);
	});

	test("never claims a preview surface is available", () => {
		for (const row of entry.availability ?? []) {
			expect(row.state).toBe("planned");
		}
		expect(getProduct(slug)?.status).toBeDefined();
	});

	test("links the docs page behind its Read the docs button, if it has one", () => {
		const product = getProduct(slug);
		const docsPath = product ? productDocsPath(product) : undefined;
		const paths = entry.docs?.map((link) => link.path) ?? [];
		expect(paths.length).toBeGreaterThanOrEqual(3);
		expect(new Set(paths).size).toBe(paths.length);
		if (docsPath) {
			expect(paths[0]).toBe(docsPath);
		}
	});

	test("renders the status board first, then availability, then the facts", () => {
		// Where it stands opens the body, ahead of the figure and statement.
		expect(at(slug, "status-board")).toBeGreaterThan(-1);
		expect(at(slug, "statement")).toBeGreaterThan(at(slug, "status-board"));
		expect(at(slug, "at-a-glance")).toBeGreaterThan(at(slug, "status-board"));
		expect(at(slug, "docs")).toBeGreaterThan(at(slug, "at-a-glance"));
		if (WITH_AVAILABILITY.includes(slug)) {
			expect(at(slug, "availability")).toBeGreaterThan(
				at(slug, "status-board")
			);
			expect(at(slug, "at-a-glance")).toBeGreaterThan(at(slug, "availability"));
		} else {
			expect(at(slug, "availability")).toBe(-1);
		}
	});

	test("shows every status item under its column, and every fact", () => {
		const html = page(slug);
		expect(html).toContain(STATUS_COLUMN_TITLES.planned);
		for (const item of [...(status?.today ?? []), ...(status?.planned ?? [])]) {
			expect(html).toContain(escaped(item.text));
		}
		const notPlanned = status?.notPlanned ?? [];
		expect(html.includes('data-status-column="not-planned"')).toBe(
			notPlanned.length > 0
		);
		for (const fact of entry.facts) {
			expect(html).toContain(escaped(fact.value));
		}
		for (const row of entry.availability ?? []) {
			expect(html).toContain(escaped(row.platform));
			expect(html).toContain(`data-availability-state="${row.state}"`);
			expect(html).toContain(AVAILABILITY_STATE_LABELS[row.state]);
		}
	});
});

test("Island, Mobile and Devices come from the surfaces file", () => {
	expect(PROFILES.island).toBe(ISLAND_PROFILE);
	expect(PROFILES.mobile).toBe(MOBILE_PROFILE);
	expect(PROFILES.devices).toBe(DEVICES_PROFILE);
});

test("Hire makes no price, credit, or receipt claim", () => {
	const copy = profileCopyStrings(profile("hire")).join("\n");
	expect(copy).not.toMatch(/pric|credit|receipt|cost|\$/i);
});

test("Devices has no Not planned column", () => {
	expect(profile("devices").status?.notPlanned).toBeUndefined();
	expect(page("devices")).not.toContain(STATUS_COLUMN_TITLES["not-planned"]);
});

test("each matrix answers where it runs in its own terms", () => {
	const platforms = (slug: ProfileSlug) =>
		(profile(slug).availability ?? []).map((row) => row.platform);
	expect(platforms("island")).toEqual(["macOS", "Windows", "Linux"]);
	expect(platforms("devices")).toEqual(["Watch", "Necklace", "Desk hub"]);
	expect(platforms("mobile")).toContain("CarPlay and Android Auto");
	expect(platforms("mobile")).toContain("On-device model");
});

test("the exchange pages draw a hard line around the host machine", () => {
	expect(page("compute")).toContain(
		"SSH, VNC, or a login to the provider&#x27;s machine."
	);
	expect(page("share")).toContain("Offering a Ryu-managed node as your own.");
	expect(page("compute")).not.toContain("Offering a Ryu-managed node");
});

test("each preview page tells a different status story", () => {
	const firstPlanned = PROFILE_SLUGS.map(
		(slug) => profile(slug).status?.planned[0]?.text
	);
	expect(new Set(firstPlanned).size).toBe(PROFILE_SLUGS.length);
	expect(page("hire")).toContain("Ryu Apps in OS or Agent");
	expect(page("mobile")).not.toContain(
		"A release in the App Store and Google Play."
	);
	expect(profile("mobile").facts).toContainEqual(
		expect.objectContaining({ label: "App stores", value: "Not listed yet" })
	);
	expect(
		profile("devices").status?.planned.map((item) => item.text)
	).not.toContain("Devices you can buy. They are still in development.");
	expect(
		profile("hire")
			.facts.slice(0, 2)
			.map((fact) => fact.label)
	).toEqual(["Status", "Planned"]);
	expect(page("island")).toContain("An AI of its own.");
	expect(page("devices")).toContain("ESP32-S3 in all three");
});
