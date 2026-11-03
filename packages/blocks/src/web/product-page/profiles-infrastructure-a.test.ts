import { describe, expect, test } from "bun:test";
import { bannedCopyHits } from "../data/banned-copy.ts";
import { OPEN_SOURCE_REPOS } from "../data/company.ts";
import { getProduct } from "../data/products.tsx";
import { getProductArchetype } from "./archetypes.ts";
import { productDocsPath } from "./product-docs-path.ts";
import { groundingErrors } from "./profile-grounding.ts";
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
} from "./profiles-infrastructure-a.ts";
import { GATEWAY_PROFILE } from "./profiles-infrastructure-a-data.ts";

function profile(slug: ProfileSlug): ProductProfile {
	const found = PROFILES[slug];
	if (!found) {
		throw new Error(`no profile for ${slug}`);
	}
	return found;
}

/** Visible copy plus the guardrail transcript, which profileCopyStrings leaves out. */
function allCopy(entry: ProductProfile): string[] {
	return [
		...profileCopyStrings(entry),
		...(entry.guardrail?.lines.map((line) => line.text) ?? []),
	];
}

describe.each(PROFILE_SLUGS)("%s profile", (slug) => {
	const entry = profile(slug);

	test("is the infrastructure archetype and is registered", () => {
		expect(ARCHETYPE).toBe("infrastructure");
		expect(getProductArchetype(slug)).toBe("infrastructure");
		expect(getProductProfile(slug)).toBe(entry);
	});

	test("meets every requirement of its page", () => {
		expect(profileGaps(slug)).toEqual([]);
		expect(profileShapeErrors(entry)).toEqual([]);
	});

	test("is grounded in real repo files and quotes", () => {
		expect(groundingErrors(entry)).toEqual([]);
	});

	test("uses no banned copy, even in the guardrail transcript", () => {
		expect(bannedCopyHits(allCopy(entry))).toEqual([]);
	});

	test("states no price, since none is sourced from the pricing table", () => {
		expect(allCopy(entry).filter((text) => /\$\s?\d/.test(text))).toEqual([]);
	});

	test("links the same docs page as the product's Read the docs button", () => {
		const product = getProduct(slug);
		const docsPath = product ? productDocsPath(product) : undefined;
		expect(docsPath).toBeDefined();
		expect(entry.docs?.map((link) => link.path)).toContain(docsPath ?? "");
	});

	test("has a security panel and further reading", () => {
		expect(entry.security?.points.length).toBeGreaterThanOrEqual(3);
		expect(entry.related?.length).toBeGreaterThanOrEqual(2);
		expect(entry.compareSlugs?.length).toBeGreaterThanOrEqual(1);
	});
});

test("the Gateway profile lives in the data file and is the one registered", () => {
	expect(PROFILES.gateway).toBe(GATEWAY_PROFILE);
});

test("each page tells a different story", () => {
	const entries = PROFILE_SLUGS.map(profile);
	const unique = (values: (string | undefined)[]) => new Set(values).size;
	expect(unique(entries.map((entry) => entry.architecture?.title))).toBe(3);
	expect(unique(entries.map((entry) => entry.comparison?.title))).toBe(3);
	expect(
		unique(entries.map((entry) => entry.comparison?.columns.join("|")))
	).toBe(3);
	const codeIds = entries.flatMap((entry) => entry.code ?? []).map((s) => s.id);
	expect(new Set(codeIds).size).toBe(codeIds.length);
	// Cloud is managed: it has no install command, only a comparison.
	expect(profile("cloud").code).toBeUndefined();
	expect(profile("core").code?.length).toBeGreaterThanOrEqual(2);
	expect(profile("gateway").code?.length).toBeGreaterThanOrEqual(2);
});

test("only the Gateway shows a firewall refusal, and it says denied in words", () => {
	expect(profile("core").guardrail).toBeUndefined();
	expect(profile("cloud").guardrail).toBeUndefined();
	const lines = profile("gateway").guardrail?.lines ?? [];
	const denied = lines.filter((line) => line.kind === "denied");
	expect(denied.map((line) => line.text)).toEqual([
		"403 policy_violation · refused before the provider call",
	]);
	expect(lines.some((line) => line.kind === "allowed")).toBe(true);
	expect(lines.filter((line) => line.kind === "command")).toHaveLength(2);
});

test("no Gateway breaker threshold is claimed (no docs page states one)", () => {
	for (const slug of PROFILE_SLUGS) {
		const copy = allCopy(profile(slug)).join("\n");
		expect(copy).not.toMatch(/breaker|failures in a row|\b5 failures\b/i);
	}
});

test("licence facts match the open-source repo listed on the company page", () => {
	const licences = OPEN_SOURCE_REPOS.find(
		(repo) => repo.name === "amajorai/ryu"
	)?.licenses;
	const licenceOf = (slug: ProfileSlug) =>
		profile(slug).facts.find((fact) => fact.label === "Licence")?.value;
	expect([licenceOf("core"), licenceOf("gateway")]).toEqual([
		...(licences ?? []),
	]);
});

test("the Gateway compares self-hosted and managed, and Cloud compares key modes", () => {
	expect(profile("gateway").comparison?.columns).toEqual([
		"Self-hosted",
		"Managed by Ryu",
	]);
	expect(profile("cloud").comparison?.columns).toEqual([
		"Managed by Ryu",
		"Bring your own keys",
	]);
	const gatewayCharge = profile("gateway").comparison?.rows.find(
		(row) => row.label === "Ryu service charge"
	);
	expect(gatewayCharge?.values[0]).toBe("None");
});
