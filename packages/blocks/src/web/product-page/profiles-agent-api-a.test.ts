import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bannedCopyHits } from "../data/banned-copy.ts";
import { getProduct } from "../data/products.tsx";
import { docsHref } from "../data/resources.tsx";
import {
	formatUsdRate,
	PRICING_COPY,
	PUBLISHED_PRICING,
} from "../data/standalone-pricing.ts";
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
} from "./profiles-agent-api-a.ts";
import { CONNECT_PROFILE } from "./profiles-agent-api-a-connect.ts";
import {
	BOX_PROFILE,
	servicesCliRow,
	servicesSdkRow,
} from "./profiles-agent-api-a-data.ts";
import { NOTIFY_PROFILE } from "./profiles-agent-api-a-notify.ts";

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

/** The base URL each OpenAPI document declares as its hosted server, if any. */
function hostedServer(href: string): string | undefined {
	const document = JSON.parse(
		readFileSync(join(repoRoot(), "apps/web/public", href), "utf8")
	) as { servers?: { url: string }[] };
	return document.servers?.find((server) => server.url.startsWith("https://"))
		?.url;
}

describe.each(PROFILE_SLUGS)("%s profile", (slug) => {
	const entry = profile(slug);

	test("is the agent-api archetype and is registered", () => {
		expect(ARCHETYPE).toBe("agent-api");
		expect(getProductArchetype(slug)).toBe("agent-api");
		expect(getProductProfile(slug)).toBe(entry);
	});

	test("meets every requirement of its page, limits and OpenAPI included", () => {
		expect(profileGaps(slug)).toEqual([]);
		expect(profileShapeErrors(entry)).toEqual([]);
	});

	test("is grounded in real repo files and quotes", () => {
		expect(groundingErrors(entry)).toEqual([]);
	});

	test("uses no banned copy anywhere a visitor can read", () => {
		expect(bannedCopyHits(allCopy(entry))).toEqual([]);
	});

	test("never installs the unpublished @ryuhq/services packages", () => {
		const text = allCopy(entry).join("\n");
		expect(text).not.toMatch(
			/\b(?:npm|pnpm|yarn|bun|pip)\s+(?:i|install|add)\b/
		);
		const sdkRows = (entry.interfaces ?? []).filter((row) =>
			["SDK", "CLI"].includes(row.kind)
		);
		expect(sdkRows.length).toBeGreaterThanOrEqual(2);
		for (const row of sdkRows) {
			expect(row.status).toBe("not-published");
			expect(row.note).toMatch(/Not on npm yet/);
		}
	});

	test("links the docs page behind the product's Read the docs button", () => {
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

	test("interface links open the docs site, not a marketing route", () => {
		for (const row of entry.interfaces ?? []) {
			expect(row.href?.startsWith(docsHref("/docs/standalone/"))).toBe(true);
		}
	});

	test("shows every price only through the pricing formatters", () => {
		const priced = allCopy(entry).filter((text) => /\$\s?\d/.test(text));
		const fromLimits = (entry.limits?.rows ?? [])
			.filter((row) => /\$\s?\d/.test(`${row.value} ${row.note ?? ""}`))
			.map((row) => row.source.path);
		expect(priced.length).toBeGreaterThan(0);
		expect(new Set(fromLimits)).toEqual(
			new Set(["packages/blocks/src/web/data/standalone-pricing.ts"])
		);
	});
});

test("only Box and Notify have a public API host, matching the host list", () => {
	expect(profile("box").openapi?.baseUrl).toBe("https://box.ryuhq.com");
	expect(profile("notify").openapi?.baseUrl).toBe("https://notify.ryuhq.com");
	expect(profile("passport").openapi?.baseUrl).toBeUndefined();
	expect(profile("connect").openapi?.baseUrl).toBeUndefined();
});

test("Box limits are the published per-size rates, computed not typed", () => {
	const { box } = PUBLISHED_PRICING;
	expect(limitValue("box", "small")).toBe(
		`${formatUsdRate(box.smallHourUsd)} per running hour`
	);
	expect(limitValue("box", "default")).toBe(
		`${formatUsdRate(box.defaultHourUsd)} per running hour`
	);
	expect(limitValue("box", "large")).toBe(
		`${formatUsdRate(box.largeHourUsd)} per running hour`
	);
	expect(limitValue("box", "Each start")).toBe(PRICING_COPY.boxMinimum);
	expect(limitValue("box", "Saved state and snapshots")).toBe(
		`${PRICING_COPY.boxStorageGibMonth} per GiB-month`
	);
});

test("metered services show the published meter, computed not typed", () => {
	expect(limitValue("notify", "Accepted events")).toBe(
		PRICING_COPY.notifyEvents
	);
	expect(limitValue("passport", "Stored credentials")).toBe(
		PRICING_COPY.passportConnectionMonth
	);
	expect(limitValue("passport", "Upstream fetches")).toBe(
		PRICING_COPY.passportFetches
	);
	expect(limitValue("connect", "Natively served toolkit calls")).toBe(
		PRICING_COPY.connectNativeCalls
	);
});

test("each page tells a different story", () => {
	const entries = PROFILE_SLUGS.map(profile);
	const codeIds = entries.flatMap((entry) => entry.code ?? []).map((s) => s.id);
	expect(new Set(codeIds).size).toBe(codeIds.length);
	const titles = entries.map((entry) => entry.limits?.title);
	expect(new Set(titles).size).toBe(PROFILE_SLUGS.length);
	// Passport and Notify show a control saying no; Connect and Box walk you in.
	expect(profile("passport").guardrail).toBeDefined();
	expect(profile("notify").guardrail).toBeDefined();
	expect(profile("passport").quickstart).toBeUndefined();
	expect(profile("notify").quickstart).toBeUndefined();
	expect(profile("connect").quickstart?.length).toBeGreaterThanOrEqual(3);
	expect(profile("box").quickstart?.length).toBeGreaterThanOrEqual(3);
	expect(profile("connect").guardrail).toBeUndefined();
	expect(profile("box").guardrail).toBeUndefined();
});

test("the guardrails refuse in words, after something was allowed", () => {
	const denied = (slug: ProfileSlug) =>
		profile(slug)
			.guardrail?.lines.filter((line) => line.kind === "denied")
			.map((line) => line.text);
	expect(denied("passport")).toEqual([
		"403 forbidden · this grant is not allowed that method",
	]);
	expect(denied("notify")).toEqual([
		"409 idempotency_conflict · same key, different body",
	]);
	for (const slug of ["passport", "notify"] as const) {
		const kinds = profile(slug).guardrail?.lines.map((line) => line.kind);
		expect(kinds?.indexOf("allowed")).toBeLessThan(
			kinds?.indexOf("denied") ?? -1
		);
	}
	const notifyLines = profile("notify").guardrail?.lines ?? [];
	expect(notifyLines.some((line) => line.text.includes("[REDACTED]"))).toBe(
		true
	);
});

test("Connect, Box and Notify live in sibling files and are the ones registered", () => {
	expect(PROFILES.connect).toBe(CONNECT_PROFILE);
	expect(PROFILES.box).toBe(BOX_PROFILE);
	expect(PROFILES.notify).toBe(NOTIFY_PROFILE);
});

test("the shared SDK and CLI rows say they are unpublished, with an optional override", () => {
	const sdk = servicesSdkRow("Box", "/docs/standalone/sdk/box");
	expect(sdk).toMatchObject({
		kind: "SDK",
		name: "@ryuhq/services",
		status: "not-published",
		href: docsHref("/docs/standalone/sdk/box"),
	});
	expect(sdk.summary).toContain("Box");
	const cli = servicesCliRow("ryu-services x", "/docs/standalone/sdk/cli");
	expect(cli.source.path).toBe("apps/web/src/lib/service-openapi-discovery.ts");
	const custom = servicesCliRow("ryu-services y", "/docs/standalone/sdk/cli", {
		summary: "Custom.",
		path: "a.mdx",
		quote: "q",
	});
	expect(custom).toMatchObject({
		summary: "Custom.",
		status: "not-published",
		source: { path: "a.mdx", quote: "q" },
	});
});
