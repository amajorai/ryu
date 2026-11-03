import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bannedCopyHits } from "../data/banned-copy.ts";
import { getProduct } from "../data/products.tsx";
import { docsHref } from "../data/resources.tsx";
import {
	formatMailAllowance,
	PRICING_COPY,
	PUBLISHED_PRICING,
} from "../data/standalone-pricing.ts";
import { getProductArchetype } from "./archetypes.ts";
import { productDocsPath } from "./product-docs-path.ts";
import {
	groundingErrors,
	normalizeWhitespace,
	repoRoot,
} from "./profile-grounding.ts";
import type { ProductProfile } from "./profile-types.ts";
import {
	getProductProfile,
	profileCopyStrings,
	profileGaps,
	profileShapeErrors,
} from "./profiles.ts";
import {
	ARCHETYPE,
	MAIL_PROFILE,
	PROFILE_SLUGS,
	PROFILES,
	type ProfileSlug,
} from "./profiles-agent-api-b.ts";
import {
	MESSAGING_PROFILE,
	OPT_OUT_SOURCE,
} from "./profiles-agent-api-b-messaging.ts";
import { SITES_PROFILE } from "./profiles-agent-api-b-sites.ts";

const PRICE = /\$\s?\d/;

function profile(slug: ProfileSlug): ProductProfile {
	const found = PROFILES[slug];
	if (!found) {
		throw new Error(`no profile for ${slug}`);
	}
	return found;
}

/** Everything a visitor reads: profile copy, code, commands and transcripts. */
function allCopy(entry: ProductProfile): string[] {
	return [
		...profileCopyStrings(entry),
		...(entry.code?.map((sample) => sample.code) ?? []),
		...(entry.quickstart?.flatMap((step) => step.command ?? []) ?? []),
		...(entry.guardrail?.lines.map((line) => line.text) ?? []),
	];
}

function limitValue(slug: ProfileSlug, label: string): string | undefined {
	return profile(slug).limits?.rows.find((row) => row.label === label)?.value;
}

/** The hosted (https) server an OpenAPI document declares, if any. */
function hostedServer(href: string): string | undefined {
	const document = JSON.parse(
		readFileSync(join(repoRoot(), "apps/web/public", href), "utf8")
	) as { servers?: { url: string }[] };
	return document.servers?.find((server) => server.url.startsWith("https://"))
		?.url;
}

function deniedLines(slug: ProfileSlug): string[] {
	return (profile(slug).guardrail?.lines ?? [])
		.filter((line) => line.kind === "denied")
		.map((line) => line.text);
}

describe.each(PROFILE_SLUGS)("%s profile", (slug) => {
	const entry = profile(slug);

	test("is the agent-api archetype and is registered", () => {
		expect(ARCHETYPE).toBe("agent-api");
		expect(getProductArchetype(slug)).toBe("agent-api");
		expect(getProductProfile(slug)).toBe(entry);
	});

	test("meets every requirement of its page, OpenAPI included", () => {
		expect(profileGaps(slug)).toEqual([]);
		expect(profileShapeErrors(entry)).toEqual([]);
	});

	test("is grounded in real repo files and quotes", () => {
		expect(groundingErrors(entry)).toEqual([]);
	});

	test("uses no banned copy anywhere a visitor can read", () => {
		expect(bannedCopyHits(allCopy(entry))).toEqual([]);
	});

	test("never installs the unpublished SDK or CLI", () => {
		expect(allCopy(entry).join("\n")).not.toMatch(
			/\b(?:npm|pnpm|yarn|bun|pip)\s+(?:i|install|add)\b/
		);
		const packaged = (entry.interfaces ?? []).filter((row) =>
			["SDK", "CLI"].includes(row.kind)
		);
		expect(packaged.map((row) => row.kind).sort()).toEqual(["CLI", "SDK"]);
		for (const row of packaged) {
			expect(row.status).toBe("not-published");
			expect(row.note).toMatch(/Not on npm yet/);
		}
	});

	test("links the docs page behind the product's docs button", () => {
		const product = getProduct(slug);
		const docsPath = product ? productDocsPath(product) : undefined;
		expect(docsPath).toBe(`/docs/standalone/${slug}`);
		expect(entry.docs?.map((link) => link.path)).toContain(docsPath ?? "");
	});

	test("links its own OpenAPI document, with the hosted base URL it declares", () => {
		expect(entry.openapi?.href).toBe(`/openapi/${slug}.json`);
		expect(entry.openapi?.baseUrl).toBe(
			hostedServer(entry.openapi?.href ?? "")
		);
	});

	test("interface links open the docs site", () => {
		for (const row of entry.interfaces ?? []) {
			expect(row.href?.startsWith(docsHref("/docs/"))).toBe(true);
		}
	});

	test("a docs link is never repeated under related reading", () => {
		const docs = new Set(entry.docs?.map((link) => link.path));
		for (const link of entry.related ?? []) {
			expect(docs.has(link.href)).toBe(false);
		}
	});
});

test("Mail allowances are the published figures, computed not typed", () => {
	const { mail } = PUBLISHED_PRICING;
	expect(limitValue("mail", "Free baseline")).toBe(
		PRICING_COPY.freeMailBaseline
	);
	expect(limitValue("mail", "Pro")).toBe(
		`${formatMailAllowance(mail.pro)} a month`
	);
	expect(limitValue("mail", "Max")).toBe(
		`${formatMailAllowance(mail.max)} a month`
	);
	expect(limitValue("mail", "Teams and Business")).toBe(
		`${formatMailAllowance(mail.organization)} a month`
	);
	expect(limitValue("mail", "Beyond a paid allowance")).toBe(
		PRICING_COPY.mailOverageRecipients
	);
	const priced = (MAIL_PROFILE.limits?.rows ?? []).filter((row) =>
		PRICE.test(`${row.value} ${row.note ?? ""}`)
	);
	expect(priced.map((row) => row.source.path)).toEqual([
		"packages/blocks/src/web/data/standalone-pricing.ts",
	]);
});

test("Messaging shows no dollar amount: every $ starts a shell variable", () => {
	const text = allCopy(profile("messaging")).join("\n");
	expect(text).not.toMatch(PRICE);
	expect(text).not.toMatch(/\$(?![A-Z][A-Z_]*\b)/);
	expect(text).not.toMatch(/\bUSD\b|MicroUsd/);
	expect(text).toContain("$RYU_API_KEY");
});

test("Sites shows no price at all, and says it is self-hosted and unreleased", () => {
	expect(allCopy(profile("sites")).join("\n")).not.toMatch(PRICE);
	const facts = SITES_PROFILE.facts.map((fact) => fact.value).join("\n");
	expect(facts).toContain("no Ryu-hosted service");
	expect(facts).toContain("not published yet");
	expect(SITES_PROFILE.openapi?.baseUrl).toBeUndefined();
});

test("each page tells a different story", () => {
	const entries = PROFILE_SLUGS.map(profile);
	const codeIds = entries.flatMap((entry) => entry.code ?? []).map((s) => s.id);
	expect(new Set(codeIds).size).toBe(codeIds.length);
	const titles = entries.map((entry) => entry.limits?.title);
	expect(new Set(titles).size).toBe(PROFILE_SLUGS.length);
	const kinds = entries.map((entry) =>
		(entry.interfaces ?? []).map((row) => row.kind).join(",")
	);
	expect(new Set(kinds).size).toBe(PROFILE_SLUGS.length);
	// Mail walks you in; Messaging and Sites each show a control saying no.
	expect(profile("mail").quickstart?.length).toBeGreaterThanOrEqual(3);
	expect(profile("mail").guardrail).toBeUndefined();
	for (const slug of ["messaging", "sites"] as const) {
		expect(profile(slug).guardrail).toBeDefined();
		// No quickstart, so the explainer's own three steps still render.
		expect(profile(slug).quickstart).toBeUndefined();
	}
});

test("the guardrails refuse in words, after something was allowed", () => {
	expect(deniedLines("messaging")).toEqual([
		"422 recipient_opted_out · refused before any hold is taken",
		"402 insufficient_credits · nothing was sent or charged",
	]);
	expect(deniedLines("sites")).toEqual([
		"422 security_blocked · the deploy scan found a secret",
	]);
	for (const slug of ["messaging", "sites"] as const) {
		const kinds = profile(slug).guardrail?.lines.map((line) => line.kind);
		expect(kinds?.indexOf("allowed")).toBeGreaterThan(-1);
		expect(kinds?.indexOf("allowed")).toBeLessThan(
			kinds?.indexOf("denied") ?? -1
		);
	}
});

test("every refusal code shown is one the docs list", () => {
	const docs = (path: string) =>
		normalizeWhitespace(readFileSync(join(repoRoot(), path), "utf8"));
	expect(docs(OPT_OUT_SOURCE.path)).toContain(
		normalizeWhitespace(OPT_OUT_SOURCE.quote)
	);
	const messagingApi = docs(
		"apps/fumadocs/content/docs/standalone/messaging-api.mdx"
	);
	expect(messagingApi).toContain(
		"| 402 | `insufficient_credits` | The available balance does not cover the hold. Nothing was sent or charged. |"
	);
	expect(docs("apps/fumadocs/content/docs/standalone/sites-api.mdx")).toContain(
		"| `422` | `security_blocked` | The deploy scan found a secret |"
	);
});

test("Messaging and Sites live in sibling files and are the ones registered", () => {
	expect(PROFILES.mail).toBe(MAIL_PROFILE);
	expect(PROFILES.messaging).toBe(MESSAGING_PROFILE);
	expect(PROFILES.sites).toBe(SITES_PROFILE);
});
