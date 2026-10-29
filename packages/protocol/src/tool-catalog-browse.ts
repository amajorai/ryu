/**
 * Anonymous browse projection of Ryu's tool catalog (Treg parity B8).
 *
 * The control plane serves these views at `/api/tool-catalog/catalog/*`
 * without a login, and the website renders them. Their field names and
 * nesting follow the public `/catalog/*` shape Core's Integrations Store
 * already reads (`apps/core/src/treg_catalog.rs`), so Core can point the same
 * reader at Ryu's catalog:
 *
 * - `GET /catalog/platforms` lists platforms (`slug`, `label`, `summary`,
 *   `capabilities` and `endpoints` counts, `price_from`).
 * - `GET /catalog/platforms/:slug` groups a platform's endpoints into
 *   `domains[].rows[].endpoints[]`. A row is one comparison key from the
 *   capability taxonomy (`<platform>/<capability>`, plus `@<model>` for
 *   generative media), built here on the server so every client compares the
 *   same vendors. Rows order their endpoints: usable first, then verified,
 *   then by reliability evidence, then by price.
 * - `GET /catalog/endpoints/:id` is one endpoint with its row siblings and its
 *   full reviewed price record.
 *
 * Every endpoint carries its `source` label (`ryu`), its verification state,
 * whether it may route a paid call, a one-call cost in the vendor's native unit
 * and in USD (null when the price is unverified, never a guess), and its
 * reliability evidence when Ryu has calls to report, and its agent review
 * summary when anybody reviewed it (C7). Retired endpoints are
 * left out of platform views (an endpoint lookup still answers them with the
 * successor). Probes, examples and verifier details are never part of it.
 */

import {
	type Capability,
	comparisonKey,
	resolveCapability,
	type Taxonomy,
} from "./capability-taxonomy.ts";
import type {
	CatalogOperation,
	CatalogSource,
	CatalogSpec,
	Verification,
} from "./tool-catalog.ts";
import {
	decodePriceUsage,
	type PriceRecord,
	quotePrice,
	type UsdRate,
} from "./tool-price.ts";
import {
	compareReliability,
	type ReliabilityEvidence,
} from "./tool-reliability.ts";
import type { ReviewSummary } from "./tool-reviews.ts";

export const TOOL_CATALOG_BROWSE_VERSION = 1 as const;

/** One published catalog entry, as the control plane projects it. */
export interface BrowseEntry {
	capability: string | null;
	docsUrl: string;
	endpoint: string;
	model: string | null;
	/** The vendor method and path template, when recorded (always for a generated row). */
	operation?: CatalogOperation | null;
	paidRoutingAllowed: boolean;
	platform: string | null;
	price: PriceRecord | null;
	provider: string;
	source: CatalogSource;
	/** The vendor-published spec a generated row came from. */
	spec?: CatalogSpec | null;
	tier: string;
	title: string;
	toolkit: string | null;
	verification: Verification;
}

export interface BrowseInput {
	entries: readonly BrowseEntry[];
	generatedAt: string;
	/** Reliability evidence by catalog endpoint id. */
	reliability?: (endpoint: string) => ReliabilityEvidence | null | undefined;
	/** Agent review summaries by catalog endpoint id (Treg parity C7). */
	reviews?: (endpoint: string) => ReviewSummary | null | undefined;
	taxonomy: Taxonomy;
	usdRates: readonly UsdRate[];
	version: number;
}

/**
 * One call's price, in the `cost` / `price_from` shape. `basis` says what the
 * figure covers: `one_call` (the price depends on the call count alone),
 * `base_call` (the per-call part; `metered_by` meters add to it) or `usage`
 * (no per-call part, so no one-call figure: `value` and `usd` are null).
 */
export interface BrowseCost {
	basis: "one_call" | "base_call" | "usage";
	checked_on: string | null;
	confidence: string;
	/** The vendor's native unit (`USD`, or a vendor credit such as `tavily_credit`). */
	currency: string;
	free: boolean;
	/** Meters other than the call count that the price also charges. */
	metered_by: string[];
	per: 1;
	provenance: string;
	source: CatalogSource;
	source_url: string | null;
	unit: "call";
	/** One call in USD; null when the price or its USD rate is unverified. */
	usd: number | null;
	/** One call in the native unit; null when the price is unverified. */
	value: number | null;
}

export interface BrowseVerification {
	checked_on: string | null;
	method: string | null;
	state: Verification["state"];
	successor: string | null;
	verified_on: string | null;
}

export interface BrowseEndpoint {
	/** The comparison key (or `<platform>/<capability>` before promotion). */
	capability: string | null;
	capability_id: string | null;
	capability_name: string | null;
	cost: BrowseCost | null;
	docs_url: string;
	id: string;
	model: string | null;
	name: string;
	/** The vendor method and path template it describes, or null when not recorded. */
	operation: { method: string; path: string } | null;
	paid_routing_allowed: boolean;
	platform: string | null;
	platform_blocked: string | null;
	platform_eligible: boolean;
	provider: string;
	provider_display: string;
	reliability: ReliabilityEvidence | null;
	/**
	 * Agent reviews of real calls (C7): counts always, ratings only once five
	 * organizations reviewed it; null when nobody did.
	 */
	reviews: ReviewSummary | null;
	source: CatalogSource;
	/** For a generated row, the vendor-published OpenAPI spec it was read from. */
	spec: { checked_on: string; sha256: string; url: string } | null;
	summary: string;
	/** `curated` (reviewed by Ryu) or `generated` (from the vendor's spec, unpriced). */
	tier: string;
	toolkit: string | null;
	verification: BrowseVerification;
}

export interface BrowseRow {
	capability: string;
	capability_name: string;
	cheapest_endpoint: string | null;
	/** False for a proposed capability: listed, not yet compared. */
	compared: boolean;
	comparison_key: string | null;
	endpoints: BrowseEndpoint[];
	model: string | null;
}

export interface BrowseDomain {
	id: string;
	label: string;
	rows: BrowseRow[];
}

export interface BrowsePlatformSummary {
	capabilities: number;
	endpoints: number;
	label: string;
	price_from: BrowseCost | null;
	providers: string[];
	slug: string;
	source: CatalogSource;
	summary: string;
	verified_endpoints: number;
}

export interface BrowsePlatformIndex {
	generated_at: string;
	platforms: BrowsePlatformSummary[];
	source: "ryu";
	type: "ryu.tool_catalog.platforms";
	version: number;
}

export interface BrowsePlatformDetail extends BrowsePlatformSummary {
	domains: BrowseDomain[];
	generated_at: string;
	type: "ryu.tool_catalog.platform";
	version: number;
}

export interface BrowseEndpointDetail {
	endpoint: BrowseEndpoint & {
		price: PriceRecord | null;
		siblings: string[];
	};
	generated_at: string;
	type: "ryu.tool_catalog.endpoint";
	version: number;
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
	brave: "Brave",
	composio: "Composio",
	exa: "Exa",
	github: "GitHub",
	ryu: "Ryu",
	tavily: "Tavily",
};

/** A provider id's display name. */
export const providerDisplay = (provider: string): string =>
	PROVIDER_NAMES[provider] ??
	provider
		.split(/[-_]/u)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");

const ONE_CALL = decodePriceUsage({ calls: 1 });
const MICRO = 1_000_000;
const CALLS = "calls";

/** The native micro-amount of one call's per-call part, and the other meters. */
const callPart = (
	price: PriceRecord
): { meters: string[]; microAmount: number } => {
	if (price.price.type === "free") {
		return { meters: [], microAmount: 0 };
	}
	let microAmount = 0;
	const meters = new Set<string>();
	for (const component of price.price.components) {
		if (component.rule === "per_call") {
			microAmount += component.microAmount / component.per;
		} else if (component.meter !== CALLS) {
			meters.add(component.meter);
		} else if (component.rule === "per_unit") {
			microAmount += component.microAmount / component.per;
		} else {
			// The first band a month's first call falls in: the "from" price.
			const band = component.tiers.find(
				(tier) => tier.upTo === null || tier.upTo >= 1
			);
			microAmount += band ? band.microAmount / band.per : 0;
		}
	}
	return { meters: [...meters].sort(), microAmount };
};

/** One call under `price`, natively and in USD; null without a price. */
export const oneCallCost = (
	price: PriceRecord | null,
	usdRates: readonly UsdRate[]
): BrowseCost | null => {
	if (!price) {
		return null;
	}
	const free = price.price.type === "free";
	const { meters, microAmount } = callPart(price);
	let basis: BrowseCost["basis"] = "one_call";
	if (meters.length > 0) {
		basis = microAmount > 0 ? "base_call" : "usage";
	}
	const verified = price.provenance !== "unverified";
	const quote = quotePrice(price, ONE_CALL, usdRates);
	const priced = basis !== "usage" && verified;
	return {
		basis,
		checked_on: price.checkedOn ?? null,
		confidence: price.confidence,
		currency: price.price.type === "free" ? "USD" : price.price.unit,
		free,
		metered_by: meters,
		per: 1,
		provenance: price.provenance,
		source: price.source,
		source_url: price.sourceUrl ?? null,
		unit: "call",
		usd: priced && quote.ok ? quote.microUsd / MICRO : null,
		value: priced ? microAmount / MICRO : null,
	};
};

const blockedReason = (entry: BrowseEntry): string | null => {
	switch (entry.verification.state) {
		case "drifted":
			return "Ryu's latest check found this endpoint no longer matches the vendor's published docs or prices; paid calls are paused until it is re-checked.";
		case "retired":
			return entry.verification.successor
				? `Retired; use ${entry.verification.successor}.`
				: "Retired.";
		default:
			return null;
	}
};

interface Placed {
	capability: Capability | undefined;
	compared: boolean;
	key: string | null;
	view: BrowseEndpoint;
}

const place = (entry: BrowseEntry, input: BrowseInput): Placed => {
	const capability =
		entry.capability === null
			? undefined
			: resolveCapability(input.taxonomy, entry.capability);
	const compared =
		entry.platform !== null && entry.capability !== null
			? comparisonKey(
					input.taxonomy,
					entry.platform,
					entry.capability,
					entry.model
				)
			: null;
	const key = compared?.ok ? compared.key : null;
	const rowKey =
		key ??
		(entry.platform && capability
			? `${entry.platform}/${capability.id}`
			: null);
	const blocked = blockedReason(entry);
	const { verification } = entry;
	return {
		capability,
		compared: key !== null,
		key: rowKey,
		view: {
			capability: rowKey,
			capability_id: capability?.id ?? entry.capability,
			capability_name: capability?.name ?? null,
			cost: oneCallCost(entry.price, input.usdRates),
			docs_url: entry.docsUrl,
			id: entry.endpoint,
			model: entry.model,
			name: entry.title,
			operation: entry.operation
				? { method: entry.operation.method, path: entry.operation.path }
				: null,
			paid_routing_allowed: entry.paidRoutingAllowed,
			platform: entry.platform,
			platform_blocked: blocked,
			platform_eligible: blocked === null,
			provider: entry.provider,
			provider_display: providerDisplay(entry.provider),
			reliability: input.reliability?.(entry.endpoint) ?? null,
			reviews: input.reviews?.(entry.endpoint) ?? null,
			source: entry.source,
			spec: entry.spec
				? {
						checked_on: entry.spec.checkedOn,
						sha256: entry.spec.sha256,
						url: entry.spec.url,
					}
				: null,
			summary: capability?.description ?? entry.title,
			tier: entry.tier,
			toolkit: entry.toolkit,
			verification: {
				checked_on: verification.checkedOn ?? null,
				method: verification.method ?? null,
				state: verification.state,
				successor: verification.successor ?? null,
				verified_on: verification.verifiedOn ?? null,
			},
		},
	};
};

const VERIFICATION_RANK: Record<Verification["state"], number> = {
	verified: 0,
	unverified: 1,
	drifted: 2,
	retired: 3,
};

/** Row order: usable, verified, reliable, cheap, then by id. */
export const compareEndpoints = (
	left: BrowseEndpoint,
	right: BrowseEndpoint
): number => {
	if (left.platform_eligible !== right.platform_eligible) {
		return left.platform_eligible ? -1 : 1;
	}
	const rank =
		VERIFICATION_RANK[left.verification.state] -
		VERIFICATION_RANK[right.verification.state];
	if (rank !== 0) {
		return rank;
	}
	const reliability = compareReliability(left.reliability, right.reliability);
	if (reliability !== 0) {
		return reliability;
	}
	const leftUsd = left.cost?.usd ?? Number.POSITIVE_INFINITY;
	const rightUsd = right.cost?.usd ?? Number.POSITIVE_INFINITY;
	if (leftUsd !== rightUsd) {
		return leftUsd < rightUsd ? -1 : 1;
	}
	return left.id < right.id ? -1 : Number(left.id > right.id);
};

const cheapest = (costs: readonly (BrowseCost | null)[]): BrowseCost | null => {
	let best: BrowseCost | null = null;
	for (const cost of costs) {
		if (cost?.usd != null && (best?.usd == null || cost.usd < best.usd)) {
			best = cost;
		}
	}
	return best;
};

const live = (input: BrowseInput, platform?: string): Placed[] =>
	input.entries
		.filter(
			(entry) =>
				entry.verification.state !== "retired" &&
				entry.platform !== null &&
				(platform === undefined || entry.platform === platform)
		)
		.map((entry) => place(entry, input));

const summaryOf = (
	slug: string,
	placed: readonly Placed[],
	input: BrowseInput
): BrowsePlatformSummary => {
	const platform = input.taxonomy.platforms.find((item) => item.id === slug);
	const eligible = placed.filter((item) => item.view.platform_eligible);
	return {
		capabilities: new Set(placed.map((item) => item.view.capability_id)).size,
		endpoints: placed.length,
		label: platform?.name ?? slug,
		price_from: cheapest(eligible.map((item) => item.view.cost)),
		providers: [...new Set(placed.map((item) => item.view.provider))].sort(),
		slug,
		source: "ryu",
		summary: platform?.description ?? "",
		verified_endpoints: placed.filter(
			(item) => item.view.verification.state === "verified"
		).length,
	};
};

/** `GET /catalog/platforms`: every platform with a live endpoint. */
export const buildPlatformIndex = (input: BrowseInput): BrowsePlatformIndex => {
	const placed = live(input);
	const slugs = [
		...new Set(placed.map((item) => item.view.platform ?? "")),
	].filter(Boolean);
	const platforms = slugs
		.map((slug) =>
			summaryOf(
				slug,
				placed.filter((item) => item.view.platform === slug),
				input
			)
		)
		.sort((left, right) => left.label.localeCompare(right.label, "en"));
	return {
		generated_at: input.generatedAt,
		platforms,
		source: "ryu",
		type: "ryu.tool_catalog.platforms",
		version: input.version,
	};
};

const rowsOf = (placed: readonly Placed[]): BrowseRow[] => {
	const byKey = new Map<string, Placed[]>();
	for (const item of placed) {
		const key = item.key ?? `${item.view.platform}/${item.view.id}`;
		byKey.set(key, [...(byKey.get(key) ?? []), item]);
	}
	return [...byKey.entries()]
		.sort(([left], [right]) => (left < right ? -1 : Number(left > right)))
		.map(([, items]) => {
			const [first] = items;
			const endpoints = items.map((item) => item.view).sort(compareEndpoints);
			const best = cheapest(
				endpoints
					.filter((view) => view.platform_eligible)
					.map((view) => view.cost)
			);
			return {
				capability: first?.view.capability_id ?? "",
				capability_name:
					first?.capability?.name ?? first?.view.capability_id ?? "",
				cheapest_endpoint:
					best === null
						? null
						: (endpoints.find(
								(view) => view.platform_eligible && view.cost?.usd === best.usd
							)?.id ?? null),
				compared: first?.compared ?? false,
				comparison_key: first?.compared ? (first.key ?? null) : null,
				endpoints,
				model: first?.view.model ?? null,
			};
		});
};

const domainLabel = (id: string): string =>
	id
		.split(/[-_]/u)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");

/** `GET /catalog/platforms/:slug`, or null when no live endpoint is on it. */
export const buildPlatformDetail = (
	input: BrowseInput,
	slug: string
): BrowsePlatformDetail | null => {
	const placed = live(input, slug);
	if (placed.length === 0) {
		return null;
	}
	const byDomain = new Map<string, Placed[]>();
	for (const item of placed) {
		const domain = (item.view.capability_id ?? "other").split(".", 1)[0] ?? "";
		byDomain.set(domain, [...(byDomain.get(domain) ?? []), item]);
	}
	const domains = [...byDomain.entries()]
		.sort(([left], [right]) => (left < right ? -1 : Number(left > right)))
		.map(([id, items]) => ({
			id,
			label: domainLabel(id),
			rows: rowsOf(items),
		}));
	return {
		...summaryOf(slug, placed, input),
		domains,
		generated_at: input.generatedAt,
		type: "ryu.tool_catalog.platform",
		version: input.version,
	};
};

/** `GET /catalog/endpoints/:id`, retired endpoints included; null when unknown. */
export const buildEndpointDetail = (
	input: BrowseInput,
	endpoint: string
): BrowseEndpointDetail | null => {
	const entry = input.entries.find((item) => item.endpoint === endpoint);
	if (!entry) {
		return null;
	}
	const placed = place(entry, input);
	const siblings =
		placed.key === null
			? []
			: live(input, entry.platform ?? undefined)
					.filter(
						(item) => item.key === placed.key && item.view.id !== endpoint
					)
					.map((item) => item.view)
					.sort(compareEndpoints)
					.map((view) => view.id);
	return {
		endpoint: { ...placed.view, price: entry.price, siblings },
		generated_at: input.generatedAt,
		type: "ryu.tool_catalog.endpoint",
		version: input.version,
	};
};
