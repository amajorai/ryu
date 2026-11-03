import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bannedCopyHits } from "../data/banned-copy.ts";
import { getProduct } from "../data/products.tsx";
import { BROWSERS, hasExtensionListing } from "../download-catalog.tsx";
import { getProductArchetype } from "./archetypes.ts";
import { productDocsPath } from "./product-docs-path.ts";
import { groundingErrors, repoRoot } from "./profile-grounding.ts";
import type { ProductProfile } from "./profile-types.ts";
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
} from "./profiles-workspace.ts";
import { CHROME_PROFILE } from "./profiles-workspace-chrome.ts";

function profile(slug: ProfileSlug): ProductProfile {
	const found = PROFILES[slug];
	if (!found) {
		throw new Error(`no profile for ${slug}`);
	}
	return found;
}

function platforms(slug: ProfileSlug): string[] {
	return (profile(slug).availability ?? []).map((row) => row.platform);
}

function readRepoFile(path: string): string {
	return readFileSync(join(repoRoot(), path), "utf8");
}

function compareCategory(slug: string): string {
	const file = `apps/web/src/data/comparisons/${slug}.json`;
	return (JSON.parse(readRepoFile(file)) as { category: string }).category;
}

/** Labels the base facts already use; a profile fact must not repeat them. */
const BASE_FACT_LABELS = ["Availability", "Category", "Pricing", "Docs"];

describe.each(PROFILE_SLUGS)("%s profile", (slug) => {
	const entry = profile(slug);

	test("is the workspace archetype and is registered", () => {
		expect(ARCHETYPE).toBe("workspace");
		expect(getProductArchetype(slug)).toBe("workspace");
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
		expect(entry.facts.length).toBeGreaterThanOrEqual(4);
		const labels = entry.facts.map((fact) => fact.label);
		expect(new Set(labels).size).toBe(labels.length);
		expect(labels.filter((label) => BASE_FACT_LABELS.includes(label))).toEqual(
			[]
		);
	});

	test("has an availability matrix of distinct platforms, each with a note", () => {
		const rows = entry.availability ?? [];
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(new Set(platforms(slug)).size).toBe(rows.length);
		for (const row of rows) {
			expect(row.note?.length ?? 0).toBeGreaterThan(0);
		}
	});

	test("never claims more availability than the catalog status", () => {
		const status = getProduct(slug)?.status;
		const states = new Set(entry.availability?.map((row) => row.state));
		if (status === "early-access") {
			expect(states.has("available")).toBe(false);
			expect(states.has("early-access")).toBe(true);
		} else {
			expect(status).toBeUndefined();
			expect(states.has("available")).toBe(true);
		}
	});

	test("links the docs page behind its Read the docs button, if it has one", () => {
		const product = getProduct(slug);
		const docsPath = product ? productDocsPath(product) : undefined;
		const paths = entry.docs?.map((link) => link.path) ?? [];
		expect(paths.length).toBeGreaterThanOrEqual(3);
		expect(new Set(paths).size).toBe(paths.length);
		if (docsPath) {
			expect(paths).toContain(docsPath);
		}
	});

	test("links related reading and comparisons", () => {
		expect(entry.related?.length).toBeGreaterThanOrEqual(1);
		expect(entry.compareSlugs?.length).toBeGreaterThanOrEqual(2);
	});
});

test("Ryu for Chrome comes from its own file and is the one registered", () => {
	expect(PROFILES["chrome-extension"]).toBe(CHROME_PROFILE);
});

test("each matrix answers where it runs in its own terms", () => {
	expect(platforms("desktop")).toEqual([
		"macOS",
		"Windows",
		"Linux",
		"Web browser",
	]);
	expect(platforms("agent")).toContain("Self-hosted or local node");
	expect(platforms("bot")).toContain("Ryu Bot app");
	expect(platforms("chrome-extension")).toContain("Address bar");
	const keys = PROFILE_SLUGS.map((slug) => platforms(slug).join("|"));
	expect(new Set(keys).size).toBe(PROFILE_SLUGS.length);
});

test("Desktop's operating systems match what the download page promises", () => {
	const download = readRepoFile("apps/web/src/app/download/page-client.tsx");
	const runsOn = download.match(/"Runs on ([^"]+)"/)?.[1] ?? "";
	for (const row of profile("desktop").availability ?? []) {
		if (row.state === "available") {
			expect(runsOn).toContain(row.platform);
			expect(runsOn).toContain(row.source.quote ?? "missing");
		}
	}
});

test("Chrome is the only browser listed until another store listing exists", () => {
	const rows = profile("chrome-extension").availability ?? [];
	for (const browser of BROWSERS) {
		const listed = rows.some((row) => row.platform === browser.name);
		expect(listed).toBe(
			browser.id === "chrome" || hasExtensionListing(browser.id)
		);
	}
	const chrome = rows.find((row) => row.platform === "Chrome");
	expect(chrome?.state).toBe("early-access");
	expect(chrome?.note).toContain("Not on the Chrome Web Store yet");
});

test("Bot's phone and watch apps are not claimed before a store listing", () => {
	const devices = profile("bot").availability?.find((row) =>
		row.platform.startsWith("Phone")
	);
	expect(devices?.state).toBe("planned");
	expect(devices?.note).toContain("App Store or Google Play");
});

test("OS is early access on every desktop it names", () => {
	for (const row of profile("os").availability ?? []) {
		expect(row.platform.startsWith("Ryu Desktop on ")).toBe(true);
		expect(row.state).toBe("early-access");
	}
});

test("comparisons sit in the right category for each workspace", () => {
	const categories = (slug: ProfileSlug) => [
		...new Set((profile(slug).compareSlugs ?? []).map(compareCategory)),
	];
	expect(categories("bot")).toEqual(["AI Chat & Assistants"]);
	expect(categories("desktop")).toEqual(["Local AI Runtimes"]);
	expect(profile("chrome-extension").compareSlugs).toContain("ultra");
	const all = PROFILE_SLUGS.flatMap((slug) => profile(slug).compareSlugs ?? []);
	expect(new Set(all).size).toBe(all.length);
});
