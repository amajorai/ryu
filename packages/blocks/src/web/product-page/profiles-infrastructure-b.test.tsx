import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { bannedCopyHits } from "../data/banned-copy.ts";
import { getProduct } from "../data/products.tsx";
import ProductLandingPage from "../product-landing-page.tsx";
import {
	getProductArchetype,
	PRODUCT_SECTION_MARKERS,
	requirementsForSlug,
} from "./archetypes.ts";
import { productDocsPath } from "./product-docs-path.ts";
import { groundingErrors, normalizeWhitespace } from "./profile-grounding.ts";
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
} from "./profiles-infrastructure-b.ts";
import { RED_TEAM_PROFILE } from "./profiles-infrastructure-b-data.ts";

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

function renderPage(slug: ProfileSlug): string {
	const product = getProduct(slug);
	if (!product) {
		throw new Error(`unknown product ${slug}`);
	}
	return renderToStaticMarkup(<ProductLandingPage product={product} />);
}

/** Probe ids the Core red-team campaign accepts (gateway/evals.mdx). */
const PROBE_IDS = [
	"prompt_injection",
	"system_prompt_leak",
	"indirect_injection",
	"jailbreak",
	"toxic_output",
	"pii_exfiltration",
	"tool_misuse",
	"sql_injection",
	"shell_injection",
	"bias_fairness",
] as const;

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

	test("has a security panel, docs links and further reading", () => {
		expect(entry.security?.points.length).toBeGreaterThanOrEqual(3);
		expect(entry.docs?.length).toBeGreaterThanOrEqual(3);
		expect(entry.related?.length).toBeGreaterThanOrEqual(2);
	});

	test("renders its datasheet sections on the product page", () => {
		const html = renderPage(slug);
		const filled: ProductSectionKey[] = [
			"at-a-glance",
			"architecture",
			"comparison",
			"security",
			"related",
			"docs",
		];
		for (const key of filled) {
			expect(html).toContain(PRODUCT_SECTION_MARKERS[key](slug));
		}
		expect(html).toContain(normalizeWhitespace(entry.facts[0]?.value ?? ""));
		expect(html).toContain(entry.architecture?.title ?? "missing");
	});
});

test("Red Teaming has no docs button, so docs links are extra, not required", () => {
	const product = getProduct("red-team");
	expect(product && productDocsPath(product)).toBeUndefined();
	expect(requirementsForSlug("red-team", { hasDocsCta: false })).not.toContain(
		"docs"
	);
	// Agents as a Service does have one, and its docs list starts with it.
	const aaas = getProduct("agents-as-a-service");
	const docsPath = aaas ? productDocsPath(aaas) : undefined;
	expect(docsPath).toBe("/docs/start-here");
	expect(profile("agents-as-a-service").docs?.[0]?.path).toBe(docsPath);
});

test("the Red Teaming profile lives in the data file and is the one registered", () => {
	expect(PROFILES["red-team"]).toBe(RED_TEAM_PROFILE);
});

test("the probe table covers the ten probes exactly once", () => {
	const rows = profile("red-team").comparison?.rows ?? [];
	const listed = rows.flatMap(
		(row) => row.values[0]?.split(",").map((id) => id.trim()) ?? []
	);
	expect([...listed].sort()).toEqual([...PROBE_IDS].sort());
	// Each probe group is scored by one of the five enforced evaluators.
	expect(new Set(rows.map((row) => row.values[1]))).toEqual(
		new Set([
			"prompt_injection",
			"code_injection",
			"pii_leakage",
			"toxicity",
			"bias_fairness",
		])
	);
});

test("the red-team terminal shows the CI gate failing in words, with real probe ids", () => {
	const lines = profile("red-team").guardrail?.lines ?? [];
	expect(lines[0]).toEqual({
		kind: "command",
		text: "ryu-cli redteam support-agent --max-attention 0",
	});
	const denied = lines.filter((line) => line.kind === "denied");
	expect(denied.map((line) => line.text)).toContain(
		"redteam gate failed: 1 probe(s) need attention (maximum 0)"
	);
	for (const line of lines.filter((l) => l.kind !== "command")) {
		const id = line.text.split(" · ")[0] ?? "";
		if (id !== "summary" && !id.startsWith("redteam gate")) {
			expect(PROBE_IDS as readonly string[]).toContain(id);
		}
	}
	expect(lines.some((line) => line.kind === "allowed")).toBe(true);
});

test("only the Red Teaming page renders code, a terminal demo and compare links", () => {
	const redTeam = renderPage("red-team");
	const aaas = renderPage("agents-as-a-service");
	for (const key of ["code", "guardrail", "compare"] as const) {
		expect(redTeam).toContain(PRODUCT_SECTION_MARKERS[key]("red-team"));
		expect(aaas).not.toContain(
			PRODUCT_SECTION_MARKERS[key]("agents-as-a-service")
		);
	}
	expect(redTeam).toContain("redteam gate failed");
});

test("the red-team API sample sends only fields Core accepts", () => {
	const http = profile("red-team").code?.find(
		(sample) => sample.language === "http"
	);
	const body = JSON.parse(http?.code.split("\n\n")[1] ?? "{}") as Record<
		string,
		unknown
	>;
	expect(Object.keys(body).sort()).toEqual(["agent_id", "strategies"]);
	for (const id of body.strategies as string[]) {
		expect(PROBE_IDS as readonly string[]).toContain(id);
	}
});

test("Agents as a Service is a service: no install command and no terminal demo", () => {
	const aaas = profile("agents-as-a-service");
	expect(aaas.code).toBeUndefined();
	expect(aaas.guardrail).toBeUndefined();
	expect(aaas.comparison?.columns).toEqual([
		"Ryu Cloud node",
		"Your own machines",
	]);
});

test("the two pages tell different stories", () => {
	const [redTeam, aaas] = PROFILE_SLUGS.map(profile);
	expect(redTeam?.architecture?.title).not.toBe(aaas?.architecture?.title);
	expect(redTeam?.comparison?.title).not.toBe(aaas?.comparison?.title);
	const redLabels = new Set(redTeam?.facts.map((fact) => fact.label));
	expect(aaas?.facts.filter((fact) => redLabels.has(fact.label))).toEqual([]);
});
