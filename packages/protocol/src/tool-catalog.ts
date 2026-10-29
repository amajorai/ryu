/**
 * Ryu's tool catalog (curated and generated tiers) and its verification rules
 * (Treg parity B3 and C1).
 *
 * This is the TypeScript twin of the Rust contract `ryu_gw_contracts::tool_catalog`.
 * Both read the seed, `crates/gateway/contracts/fixtures/tool-catalog-v1.json`,
 * and assert the same golden cases, `tool-catalog-cases-v1.json`.
 *
 * A catalog entry is one callable vendor endpoint, keyed by the same endpoint id
 * as its price record (`@ryuhq/protocol/tool-price`) and typed by one capability
 * on one platform (`@ryuhq/protocol/capability-taxonomy`). It carries the
 * vendor's own reference URL, the probes that check Ryu's record against the
 * vendor, and a verification state:
 *
 * - `unverified`: no verification run has passed yet.
 * - `verified`: the latest run that reached a verdict passed every probe it
 *   could run; `method` names the strongest one (`docs_page`, `live_free`,
 *   `live_paid`) and `verifiedOn` the date.
 * - `drifted`: a run found the vendor no longer matches the record (a price
 *   marker gone from the pricing page, an endpoint answering 404, a response
 *   missing its documented fields). It needs a curator.
 * - `retired`: withdrawn by a curator, with a reason and an optional successor.
 *   Never probed again.
 *
 * Money rule: only a `verified` entry whose price may route paid calls
 * ({@link catalogPaidRoutingAllowed}) can route a paid call. Drift, retirement
 * and an unverified price all refuse.
 *
 * The verifier (`tools/tool-catalog-verify.ts`) plans runs cheapest first
 * within a spend budget ({@link planVerification}), and keeps only examples
 * passed through {@link scrubExample}. A probe may name a credential only from
 * {@link VERIFIER_CREDENTIAL_HOSTS}, and only for that credential's own host, so
 * an edited catalog row cannot send a verifier secret anywhere else.
 *
 * Two tiers share this shape (Treg parity C1):
 *
 * - `curated` rows are written and reviewed by hand, typed by the taxonomy and
 *   joined to a reviewed price.
 * - `generated` rows come from a vendor's own published OpenAPI spec through
 *   `tools/tool-catalog-generate.ts` (`tool-catalog-generated-v1.json`). Each
 *   records the spec it came from (`spec`: URL, check date, content hash) and
 *   the operation it describes (`operation`); it needs no taxonomy reference
 *   and no price, and without a reviewed price it can never route a paid call,
 *   whatever its verification state. Curated rows win on collision: a
 *   generated row may not repeat an endpoint id or a provider operation that
 *   another live row covers ({@link generatedEntriesBeside}).
 *
 * Treg stays a first-class catalog lane: every entry carries its `source`
 * label, and {@link selectCatalogEntry} merges a Ryu entry with a Treg one under
 * the same `PricePrecedence` switch as prices (default: Ryu's entry where it is
 * verified, else Treg's).
 */

import { z } from "zod";
import generatedCatalogJson from "../../../crates/gateway/contracts/fixtures/tool-catalog-generated-v1.json" with {
	type: "json",
};
import catalogJson from "../../../crates/gateway/contracts/fixtures/tool-catalog-v1.json" with {
	type: "json",
};
import {
	BUILTIN_TAXONOMY,
	isValidCapabilityId,
	isValidIsoDate,
	isValidModelId,
	isValidPlatformId,
	resolveCapability,
	type Taxonomy,
} from "./capability-taxonomy.ts";
import {
	BUILTIN_PRICE_CATALOG,
	DEFAULT_PRICE_PRECEDENCE,
	isValidEndpointId,
	isValidProviderId,
	type PriceCatalog,
	type PricePrecedence,
	type PriceRecord,
	paidRoutingAllowed,
	quotePrice,
} from "./tool-price.ts";

/** Version of this contract and of `tool-catalog-v1.json`. */
export const TOOL_CATALOG_VERSION = 1 as const;

/** At most this many probes per entry. */
export const MAX_PROBES_PER_ENTRY = 4;

/** At most this many markers per docs-page probe. */
export const MAX_PROBE_MARKERS = 8;

/** Longest drift or retirement reason kept. */
export const MAX_REASON_LEN = 300;

/** Largest scrubbed example kept, as serialized JSON. */
export const MAX_EXAMPLE_BYTES = 8 * 1024;

/**
 * The only credentials a probe may name, each bound to the one host it may be
 * sent to. This table is code, not data: adding a credential is a reviewed
 * change, so an edited catalog row cannot exfiltrate a verifier secret.
 */
export const VERIFIER_CREDENTIAL_HOSTS: Readonly<Record<string, string>> =
	Object.freeze({
		RYU_VERIFY_BRAVE_KEY: "api.search.brave.com",
		RYU_VERIFY_EXA_KEY: "api.exa.ai",
		RYU_VERIFY_GITHUB_TOKEN: "api.github.com",
		RYU_VERIFY_TAVILY_KEY: "api.tavily.com",
	});

const TOOLKIT_ID = /^[a-z][a-z0-9_-]*$/;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const MAX_TITLE_LEN = 120;
const MIN_MARKER_LEN = 3;
const MAX_MARKER_LEN = 200;
const MAX_EXPECT_KEYS = 16;
const MAX_ESTIMATE_MICRO_USD = 10_000_000;

const stateSchema = z.enum(["unverified", "verified", "drifted", "retired"]);
const methodSchema = z.enum(["docs_page", "live_free", "live_paid"]);
const sourceSchema = z.enum(["ryu", "treg"]);
const tierSchema = z.enum(["curated", "generated"]);

/** The vendor operation an entry describes: method plus the spec's path template. */
const operationSchema = z.strictObject({
	method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
	path: z.string(),
});

/** The vendor-published spec a generated entry came from. */
const specSchema = z.strictObject({
	checkedOn: z.string(),
	sha256: z.string(),
	url: z.string(),
});

/**
 * An anonymous free route (Treg parity C6): the vendor serves this GET
 * without a credential and for free, so Connect may relay it with no key and
 * no balance entry. `baseUrl` is the vendor origin (and base path) the
 * operation's path is joined to.
 */
const freeRouteSchema = z.strictObject({
	baseUrl: z.string(),
});

const verificationSchema = z.strictObject({
	checkedOn: z.string().optional(),
	method: methodSchema.optional(),
	reason: z.string().optional(),
	state: stateSchema,
	successor: z.string().optional(),
	verifiedOn: z.string().optional(),
});

const credentialSchema = z.strictObject({
	env: z.string(),
	header: z.string(),
	scheme: z.enum(["bearer", "raw"]),
});

const probeSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		expect: z.array(z.string()),
		kind: z.literal("docs_page"),
		url: z.string(),
	}),
	z.strictObject({
		body: z.record(z.string(), z.unknown()).optional(),
		credential: credentialSchema.optional(),
		estimatedMicroUsd: z.number().int().nonnegative(),
		expectJson: z.enum(["object", "array"]),
		expectKeys: z.array(z.string()),
		expectStatus: z.number().int(),
		kind: z.literal("http"),
		method: z.enum(["GET", "POST"]),
		url: z.string(),
	}),
]);

const entrySchema = z.strictObject({
	capability: z.string().optional(),
	docsCheckedOn: z.string(),
	docsUrl: z.string(),
	endpoint: z.string(),
	freeRoute: freeRouteSchema.optional(),
	model: z.string().optional(),
	note: z.string().optional(),
	operation: operationSchema.optional(),
	platform: z.string().optional(),
	probes: z.array(probeSchema),
	provider: z.string(),
	source: sourceSchema,
	spec: specSchema.optional(),
	tier: tierSchema,
	title: z.string(),
	toolkit: z.string().optional(),
	verification: verificationSchema,
});

const catalogSchema = z.strictObject({
	description: z.string(),
	entries: z.array(entrySchema),
	version: z.int().nonnegative(),
});

const resultSchema = z.strictObject({
	endpoint: z.string(),
	method: methodSchema.optional(),
	outcome: z.enum(["pass", "mismatch", "error", "skipped"]),
	ranOn: z.string(),
	reason: z.string().optional(),
});

export type VerificationState = z.infer<typeof stateSchema>;
export type VerificationMethod = z.infer<typeof methodSchema>;
export type CatalogSource = z.infer<typeof sourceSchema>;
export type CatalogTier = z.infer<typeof tierSchema>;
export type CatalogOperation = z.infer<typeof operationSchema>;
export type CatalogSpec = z.infer<typeof specSchema>;
export type CatalogFreeRoute = z.infer<typeof freeRouteSchema>;
export type Verification = z.infer<typeof verificationSchema>;
export type ProbeCredential = z.infer<typeof credentialSchema>;
export type CatalogProbe = z.infer<typeof probeSchema>;
export type CatalogEntry = z.infer<typeof entrySchema>;
export type ToolCatalog = z.infer<typeof catalogSchema>;
export type VerificationResult = z.infer<typeof resultSchema>;

export interface CatalogIssue {
	code: string;
	subject: string;
}

export const decodeCatalogEntry = (value: unknown): CatalogEntry =>
	entrySchema.parse(value);
export const decodeToolCatalog = (value: unknown): ToolCatalog =>
	catalogSchema.parse(value);
export const decodeVerificationResult = (value: unknown): VerificationResult =>
	resultSchema.parse(value);
export const decodeVerification = (value: unknown): Verification =>
	verificationSchema.parse(value);

const METHOD_RANK: Record<VerificationMethod, number> = {
	docs_page: 0,
	live_free: 1,
	live_paid: 2,
};

/** The stronger of two methods (`live_paid` > `live_free` > `docs_page`). */
export const strongerMethod = (
	left: VerificationMethod | undefined,
	right: VerificationMethod
): VerificationMethod =>
	left !== undefined && METHOD_RANK[left] >= METHOD_RANK[right] ? left : right;

/** What a probe proves when it passes. */
export const probeMethod = (probe: CatalogProbe): VerificationMethod => {
	if (probe.kind === "docs_page") {
		return "docs_page";
	}
	return probe.estimatedMicroUsd > 0 ? "live_paid" : "live_free";
};

/** What a probe is expected to cost, in micro-USD. */
export const probeCost = (probe: CatalogProbe): number =>
	probe.kind === "docs_page" ? 0 : probe.estimatedMicroUsd;

const parseHttpsUrl = (value: string): URL | null => {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" &&
			parsed.hostname !== "" &&
			parsed.username === "" &&
			parsed.password === ""
			? parsed
			: null;
	} catch {
		return null;
	}
};

const checkVerification = (
	verification: Verification,
	codes: Set<string>
): void => {
	const { checkedOn, method, reason, state, successor, verifiedOn } =
		verification;
	if (checkedOn !== undefined && !isValidIsoDate(checkedOn)) {
		codes.add("invalid_checked_on");
	}
	if (verifiedOn !== undefined && !isValidIsoDate(verifiedOn)) {
		codes.add("invalid_verified_on");
	}
	if (
		checkedOn !== undefined &&
		verifiedOn !== undefined &&
		verifiedOn > checkedOn
	) {
		codes.add("verified_after_checked");
	}
	if (verifiedOn !== undefined && method === undefined) {
		codes.add("verified_without_method");
	}
	if (reason !== undefined && reason.length > MAX_REASON_LEN) {
		codes.add("reason_too_long");
	}
	switch (state) {
		case "verified":
			if (verifiedOn === undefined || checkedOn === undefined) {
				codes.add("verified_without_date");
			}
			if (reason !== undefined) {
				codes.add("reason_not_allowed");
			}
			break;
		case "drifted":
			if (checkedOn === undefined) {
				codes.add("drifted_without_date");
			}
			if (!reason?.trim()) {
				codes.add("drifted_without_reason");
			}
			break;
		case "retired":
			if (!reason?.trim()) {
				codes.add("retired_without_reason");
			}
			break;
		default:
			if (reason !== undefined) {
				codes.add("reason_not_allowed");
			}
			break;
	}
	if (successor !== undefined) {
		if (state !== "retired") {
			codes.add("successor_not_retired");
		}
		if (!isValidEndpointId(successor)) {
			codes.add("invalid_successor");
		}
	}
};

const checkDocsProbe = (
	probe: Extract<CatalogProbe, { kind: "docs_page" }>,
	codes: Set<string>
): void => {
	if (!parseHttpsUrl(probe.url)) {
		codes.add("invalid_probe_url");
	}
	if (
		probe.expect.length === 0 ||
		probe.expect.length > MAX_PROBE_MARKERS ||
		probe.expect.some(
			(marker) =>
				marker.trim().length < MIN_MARKER_LEN ||
				marker.length > MAX_MARKER_LEN ||
				marker !== marker.trim()
		)
	) {
		codes.add("invalid_expect");
	}
};

const checkHttpProbe = (
	probe: Extract<CatalogProbe, { kind: "http" }>,
	codes: Set<string>
): void => {
	const url = parseHttpsUrl(probe.url);
	if (!url) {
		codes.add("invalid_probe_url");
	}
	if (probe.expectStatus < 200 || probe.expectStatus > 299) {
		codes.add("invalid_expect_status");
	}
	if (
		probe.expectKeys.length > MAX_EXPECT_KEYS ||
		probe.expectKeys.some((key) => key.length === 0 || key.length > 64)
	) {
		codes.add("invalid_expect");
	}
	if (probe.estimatedMicroUsd > MAX_ESTIMATE_MICRO_USD) {
		codes.add("invalid_estimate");
	}
	if (probe.method === "GET" && probe.body !== undefined) {
		codes.add("body_on_get");
	}
	const { credential } = probe;
	if (credential === undefined) {
		if (probe.estimatedMicroUsd > 0) {
			codes.add("paid_probe_without_credential");
		}
		return;
	}
	const host = Object.hasOwn(VERIFIER_CREDENTIAL_HOSTS, credential.env)
		? VERIFIER_CREDENTIAL_HOSTS[credential.env]
		: undefined;
	if (host === undefined) {
		codes.add("unknown_credential");
	} else if (url && url.hostname !== host) {
		codes.add("credential_host_mismatch");
	}
	if (!HEADER_NAME.test(credential.header) || credential.header.length > 64) {
		codes.add("invalid_credential_header");
	}
};

const checkTaxonomyRef = (entry: CatalogEntry, codes: Set<string>): void => {
	const { capability, model, platform } = entry;
	if (platform === undefined || capability === undefined) {
		// A generated row may carry no taxonomy reference at all, never half of one.
		if (
			entry.tier === "curated" ||
			platform !== undefined ||
			capability !== undefined
		) {
			codes.add("missing_taxonomy_ref");
		}
	} else if (
		!(isValidPlatformId(platform) && isValidCapabilityId(capability))
	) {
		codes.add("invalid_taxonomy_ref");
	}
	if (model !== undefined && !(model.length > 0 && isValidModelId(model))) {
		codes.add("invalid_model");
	}
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
const OPERATION_PATH = /^\/[\x21-\x7e]*$/;
/** Longest operation path template kept. */
export const MAX_OPERATION_PATH_LEN = 512;

/** Whether an operation path is a spec path template (`/a/{b}`), not a URL. */
export const isValidOperationPath = (path: string): boolean =>
	path.length <= MAX_OPERATION_PATH_LEN &&
	OPERATION_PATH.test(path) &&
	!/[?#]/.test(path);

/** A free route's base URL: HTTPS, no credentials, query or fragment. */
const isValidFreeRouteBase = (value: string): boolean => {
	const url = parseHttpsUrl(value);
	return (
		url !== null &&
		url.search === "" &&
		url.hash === "" &&
		!value.includes("?") &&
		!value.includes("#") &&
		!value.endsWith("/")
	);
};

/**
 * Rules a free route keeps on its own: a curated GET operation under an HTTPS
 * base, verified only by credential-free probes, one of them a free live GET.
 */
const checkFreeRoute = (entry: CatalogEntry, codes: Set<string>): void => {
	const route = entry.freeRoute;
	if (route === undefined) {
		return;
	}
	if (entry.tier !== "curated") {
		codes.add("free_route_not_curated");
	}
	if (entry.operation?.method !== "GET") {
		codes.add("free_route_not_get");
	}
	if (!isValidFreeRouteBase(route.baseUrl)) {
		codes.add("invalid_free_route_url");
	}
	const http = entry.probes.filter(
		(probe): probe is Extract<CatalogProbe, { kind: "http" }> =>
			probe.kind === "http"
	);
	if (http.some((probe) => probe.credential !== undefined)) {
		codes.add("free_route_credentialed_probe");
	}
	if (
		!http.some(
			(probe) =>
				probe.method === "GET" &&
				probe.estimatedMicroUsd === 0 &&
				probe.credential === undefined
		)
	) {
		codes.add("free_route_without_free_probe");
	}
};

const checkTierFields = (entry: CatalogEntry, codes: Set<string>): void => {
	if (entry.tier === "generated") {
		if (entry.spec === undefined) {
			codes.add("generated_without_spec");
		}
		if (entry.operation === undefined) {
			codes.add("generated_without_operation");
		}
	} else if (entry.spec !== undefined) {
		codes.add("spec_not_allowed");
	}
	const { operation, spec } = entry;
	if (operation !== undefined && !isValidOperationPath(operation.path)) {
		codes.add("invalid_operation");
	}
	if (spec !== undefined) {
		if (!parseHttpsUrl(spec.url)) {
			codes.add("invalid_spec_url");
		}
		if (!isValidIsoDate(spec.checkedOn)) {
			codes.add("invalid_spec_checked_on");
		}
		if (!SHA256_HEX.test(spec.sha256)) {
			codes.add("invalid_spec_sha256");
		}
	}
};

/** Every rule an entry breaks on its own, as sorted codes. Empty means valid. */
export const validateCatalogEntry = (entry: CatalogEntry): string[] => {
	const codes = new Set<string>();
	checkTierFields(entry, codes);
	checkFreeRoute(entry, codes);
	if (!isValidEndpointId(entry.endpoint)) {
		codes.add("invalid_endpoint");
	}
	if (!isValidProviderId(entry.provider)) {
		codes.add("invalid_provider");
	} else if (!entry.endpoint.startsWith(`${entry.provider}.`)) {
		codes.add("endpoint_provider_mismatch");
	}
	if (
		entry.toolkit !== undefined &&
		!(entry.toolkit.length <= 64 && TOOLKIT_ID.test(entry.toolkit))
	) {
		codes.add("invalid_toolkit");
	}
	checkTaxonomyRef(entry, codes);
	const title = entry.title.trim();
	if (title.length === 0 || entry.title.length > MAX_TITLE_LEN) {
		codes.add("invalid_title");
	}
	if (!parseHttpsUrl(entry.docsUrl)) {
		codes.add("invalid_docs_url");
	}
	if (!isValidIsoDate(entry.docsCheckedOn)) {
		codes.add("invalid_docs_checked_on");
	}
	checkVerification(entry.verification, codes);
	if (entry.probes.length > MAX_PROBES_PER_ENTRY) {
		codes.add("too_many_probes");
	}
	if (entry.probes.length === 0 && entry.verification.state !== "retired") {
		codes.add("no_probes");
	}
	for (const probe of entry.probes) {
		if (probe.kind === "docs_page") {
			checkDocsProbe(probe, codes);
		} else {
			checkHttpProbe(probe, codes);
		}
	}
	if (
		entry.verification.method !== undefined &&
		entry.probes.length > 0 &&
		!entry.probes.some(
			(probe) =>
				METHOD_RANK[probeMethod(probe)] >=
				METHOD_RANK[entry.verification.method ?? "docs_page"]
		)
	) {
		codes.add("method_without_probe");
	}
	return [...codes].sort();
};

const ONE_CALL = { calls: 1, meters: {}, monthToDate: {} };

const checkEntryAgainstPrice = (
	entry: CatalogEntry,
	price: PriceRecord | undefined,
	prices: PriceCatalog,
	push: (code: string) => void
): void => {
	if (entry.freeRoute !== undefined && price?.price.type !== "free") {
		push("free_route_not_free");
	}
	if (!price) {
		// A generated row has no reviewed price yet, so it cannot route paid calls.
		if (entry.tier === "curated") {
			push("missing_price");
		}
		return;
	}
	if (entry.tier === "generated") {
		// A price is reviewed for a curated entry only: a generated row is
		// promoted by adding a curated entry, never by pricing it in place.
		push("generated_priced");
		return;
	}
	if (
		price.platform !== undefined &&
		(price.platform !== entry.platform ||
			price.capability !== entry.capability ||
			price.model !== entry.model)
	) {
		push("price_taxonomy_mismatch");
	}
	if (price.provider !== entry.provider) {
		push("price_provider_mismatch");
	}
	for (const probe of entry.probes) {
		if (probe.kind !== "http") {
			continue;
		}
		if (price.price.type === "free") {
			if (probe.estimatedMicroUsd > 0) {
				push("estimate_on_free");
			}
			continue;
		}
		const quote = quotePrice(price, ONE_CALL, prices.usdRates);
		// An unverified price cannot quote; its probe must still be budgeted.
		if (quote.ok ? probe.estimatedMicroUsd < quote.microUsd : false) {
			push("estimate_below_quote");
		}
		if (probe.estimatedMicroUsd === 0) {
			push("free_estimate_on_metered");
		}
	}
};

const checkEntryTaxonomy = (
	entry: CatalogEntry,
	taxonomy: Taxonomy,
	push: (code: string) => void
): void => {
	const { capability, model, platform } = entry;
	if (platform === undefined || capability === undefined) {
		return;
	}
	const found = resolveCapability(taxonomy, capability);
	if (!found) {
		push("unknown_capability");
		return;
	}
	if (found.id !== capability) {
		push("alias_reference");
	}
	if (!found.platforms.includes(platform)) {
		push("platform_not_allowed");
	}
	if (found.comparison === "per_model" && model === undefined) {
		push("model_required");
	}
	if (found.comparison === "capability" && model !== undefined) {
		push("model_not_allowed");
	}
};

/** The key two entries collide on when they describe one vendor operation. */
export const operationKey = (entry: CatalogEntry): string | null =>
	entry.operation === undefined
		? null
		: `${entry.provider} ${entry.operation.method} ${entry.operation.path}`;

/**
 * Live generated entries that repeat an operation another live entry
 * describes. Curated entries may share one (body variants such as Exa's
 * search types); a generated one may not.
 */
const duplicateOperations = (entries: readonly CatalogEntry[]): string[] => {
	const byKey = new Map<string, CatalogEntry[]>();
	for (const entry of entries) {
		const key = operationKey(entry);
		if (key === null || entry.verification.state === "retired") {
			continue;
		}
		byKey.set(key, [...(byKey.get(key) ?? []), entry]);
	}
	const subjects: string[] = [];
	for (const group of byKey.values()) {
		if (group.length < 2) {
			continue;
		}
		for (const entry of group) {
			if (entry.tier === "generated") {
				subjects.push(entry.endpoint);
			}
		}
	}
	return subjects;
};

/**
 * Every issue in a Ryu catalog, checked against `taxonomy` and `prices`: each
 * entry on its own, then duplicates (endpoint ids, and a generated entry
 * repeating another live entry's operation), a missing (curated) or
 * disagreeing price record, probe estimates below one call's quote, and
 * retirement successors.
 */
export const validateToolCatalog = (
	catalog: ToolCatalog,
	taxonomy: Taxonomy,
	prices: PriceCatalog
): CatalogIssue[] => {
	const issues: CatalogIssue[] = [];
	if (catalog.version !== TOOL_CATALOG_VERSION) {
		issues.push({
			code: "unsupported_version",
			subject: String(catalog.version),
		});
		return issues;
	}
	const byEndpoint = new Map<string, CatalogEntry>();
	for (const entry of catalog.entries) {
		const subject = entry.endpoint;
		const push = (code: string) => issues.push({ code, subject });
		for (const code of validateCatalogEntry(entry)) {
			push(code);
		}
		if (byEndpoint.has(subject)) {
			push("duplicate_endpoint");
		}
		byEndpoint.set(subject, entry);
		if (entry.source !== "ryu") {
			push("foreign_source");
		}
		checkEntryTaxonomy(entry, taxonomy, push);
		checkEntryAgainstPrice(
			entry,
			prices.rows.find((row) => row.endpoint === subject),
			prices,
			push
		);
	}
	for (const subject of duplicateOperations(catalog.entries)) {
		issues.push({ code: "duplicate_operation", subject });
	}
	for (const entry of catalog.entries) {
		const { successor } = entry.verification;
		if (successor === undefined) {
			continue;
		}
		const next = byEndpoint.get(successor);
		if (!next || next.verification.state === "retired") {
			issues.push({ code: "unknown_successor", subject: entry.endpoint });
		}
	}
	return issues;
};

/** Decode and validate a catalog; throws on the first issue. */
export const parseToolCatalog = (
	value: unknown,
	taxonomy: Taxonomy = BUILTIN_TAXONOMY,
	prices: PriceCatalog = BUILTIN_PRICE_CATALOG
): ToolCatalog => {
	const catalog = decodeToolCatalog(value);
	const [first, ...rest] = validateToolCatalog(catalog, taxonomy, prices);
	if (first) {
		throw new Error(
			`tool catalog invalid: ${first.code} (${first.subject}), ${rest.length + 1} issue(s)`
		);
	}
	return catalog;
};

/** Every rule a verification result breaks, as sorted codes. */
export const validateVerificationResult = (
	result: VerificationResult
): string[] => {
	const codes = new Set<string>();
	if (!isValidEndpointId(result.endpoint)) {
		codes.add("invalid_endpoint");
	}
	if (!isValidIsoDate(result.ranOn)) {
		codes.add("invalid_ran_on");
	}
	if (result.outcome === "pass") {
		if (result.method === undefined) {
			codes.add("pass_without_method");
		}
	} else if (!result.reason?.trim()) {
		codes.add("missing_reason");
	}
	if (result.reason !== undefined && result.reason.length > MAX_REASON_LEN) {
		codes.add("reason_too_long");
	}
	return [...codes].sort();
};

export interface AppliedVerification {
	/** Whether the stored verification changed. */
	changed: boolean;
	verification: Verification;
}

/**
 * The verification an entry has after one run result.
 *
 * - A retired entry never changes.
 * - A result older than the entry's last verdict (`ranOn < checkedOn`) is
 *   stale and changes nothing, so a delayed report cannot undo a newer one.
 * - `pass` makes the entry `verified` on `ranOn` with the result's method.
 * - `mismatch` makes it `drifted` with the reason, keeping the last pass.
 * - `error` (network, rate limit, bad credential) and `skipped` (budget, no
 *   credential) are not verdicts: the state stays as it was.
 */
export const applyVerificationResult = (
	current: Verification,
	result: VerificationResult
): AppliedVerification => {
	const unchanged = { changed: false, verification: current };
	if (
		current.state === "retired" ||
		validateVerificationResult(result).length > 0 ||
		(current.checkedOn !== undefined && result.ranOn < current.checkedOn)
	) {
		return unchanged;
	}
	if (result.outcome === "pass" && result.method !== undefined) {
		const verification: Verification = {
			checkedOn: result.ranOn,
			method: result.method,
			state: "verified",
			verifiedOn: result.ranOn,
		};
		return {
			changed: !sameVerification(current, verification),
			verification,
		};
	}
	if (result.outcome === "mismatch") {
		const verification: Verification = {
			checkedOn: result.ranOn,
			reason: result.reason?.trim() ?? "",
			state: "drifted",
			...(current.verifiedOn === undefined
				? {}
				: { verifiedOn: current.verifiedOn }),
			...(current.method === undefined ? {} : { method: current.method }),
		};
		return {
			changed: !sameVerification(current, verification),
			verification,
		};
	}
	return unchanged;
};

const VERIFICATION_FIELDS = [
	"checkedOn",
	"method",
	"reason",
	"state",
	"successor",
	"verifiedOn",
] as const;

/** Field-by-field equality of two verification records. */
export const sameVerification = (
	left: Verification,
	right: Verification
): boolean =>
	VERIFICATION_FIELDS.every((field) => left[field] === right[field]);

/**
 * Whether an entry may route a call someone pays for: the entry is curated
 * and `verified`, and its price record may route paid calls
 * (`paidRoutingAllowed`). A generated row (even one a docs check verified), a
 * missing price, drift, retirement or an unverified price all refuse.
 */
export const catalogPaidRoutingAllowed = (
	entry: CatalogEntry,
	price: PriceRecord | null | undefined
): boolean =>
	entry.tier === "curated" &&
	entry.verification.state === "verified" &&
	price !== null &&
	price !== undefined &&
	price.endpoint === entry.endpoint &&
	paidRoutingAllowed(price);

/**
 * Whether Connect may relay an entry as an anonymous free route: it declares
 * one and breaks no rule, Ryu's reviewed price for it is `free`, and it is
 * verified by a live call (a credential-free one, by the free-route rules).
 * Anything else is never served without a key.
 */
export const catalogFreeRouteAllowed = (
	entry: CatalogEntry,
	price: PriceRecord | null | undefined
): boolean =>
	entry.freeRoute !== undefined &&
	entry.source === "ryu" &&
	validateCatalogEntry(entry).length === 0 &&
	entry.verification.state === "verified" &&
	entry.verification.method !== undefined &&
	METHOD_RANK[entry.verification.method] >= METHOD_RANK.live_free &&
	price !== null &&
	price !== undefined &&
	price.endpoint === entry.endpoint &&
	price.price.type === "free";

/**
 * Merge one endpoint's Ryu and Treg catalog entries under `precedence`, the
 * same switch prices use. The winner keeps its `source` label, which every
 * surface that serves it must show.
 */
export const selectCatalogEntry = (
	ryu: CatalogEntry | null | undefined,
	treg: CatalogEntry | null | undefined,
	precedence: PricePrecedence = DEFAULT_PRICE_PRECEDENCE
): CatalogEntry | null => {
	switch (precedence) {
		case "ryu_verified_first":
			if (ryu && ryu.verification.state === "verified") {
				return ryu;
			}
			return treg ?? ryu ?? null;
		case "treg_first":
			return treg ?? ryu ?? null;
		case "ryu_only":
			return ryu ?? null;
		case "treg_only":
			return treg ?? null;
		default:
			return null;
	}
};

/* -------------------------------------------------------------------------- *
 * Verification planning (TypeScript only: the verifier and control plane)
 * -------------------------------------------------------------------------- */

export type SkipReason = "budget" | "no_credential";

export interface PlannedProbe {
	cost: number;
	index: number;
	probe: CatalogProbe;
}

export interface PlannedEntry {
	endpoint: string;
	/** Probes to run, cheapest first. */
	run: PlannedProbe[];
	/** Probes left out, with why. */
	skipped: Array<PlannedProbe & { reason: SkipReason }>;
}

export interface VerificationPlan {
	budgetMicroUsd: number;
	entries: PlannedEntry[];
	/** What the planned probes are expected to cost in total. */
	plannedMicroUsd: number;
}

export interface PlanOptions {
	/** Whether the verifier holds credential `env`. */
	available: (env: string) => boolean;
	/** The most the run may spend on paid probes, in micro-USD. */
	budgetMicroUsd: number;
	/** Only these endpoints, when given. */
	endpoints?: readonly string[];
	/** Only this Connect toolkit, when given. */
	toolkit?: string;
}

/**
 * Order a verification run cheapest first within a spend budget.
 *
 * Retired entries are left out. Each entry's probes are sorted by expected cost
 * (free docs pages and free live calls first); a probe whose credential the
 * verifier lacks is skipped (`no_credential`), and a paid probe that would take
 * the run over budget is skipped (`budget`), so a free probe of the same entry
 * still runs. Entries are ordered by the cost of their runnable probes, then by
 * endpoint, so the budget buys the most verdicts.
 */
export const planVerification = (
	entries: readonly CatalogEntry[],
	options: PlanOptions
): VerificationPlan => {
	const budget = Math.max(0, Math.floor(options.budgetMicroUsd));
	const chosen = entries.filter(
		(entry) =>
			entry.verification.state !== "retired" &&
			(options.endpoints === undefined ||
				options.endpoints.includes(entry.endpoint)) &&
			(options.toolkit === undefined || entry.toolkit === options.toolkit)
	);
	const candidates = chosen.map((entry) => {
		const probes = entry.probes
			.map((probe, index) => ({ cost: probeCost(probe), index, probe }))
			.sort(
				(left, right) => left.cost - right.cost || left.index - right.index
			);
		const usable = probes.filter(
			(planned) =>
				planned.probe.kind === "docs_page" ||
				planned.probe.credential === undefined ||
				options.available(planned.probe.credential.env)
		);
		return {
			entry,
			probes,
			weight: usable.reduce((sum, planned) => sum + planned.cost, 0),
		};
	});
	candidates.sort(
		(left, right) =>
			left.weight - right.weight ||
			(left.entry.endpoint < right.entry.endpoint ? -1 : 1)
	);
	let planned = 0;
	const plan: PlannedEntry[] = [];
	for (const { entry, probes } of candidates) {
		const run: PlannedProbe[] = [];
		const skipped: PlannedEntry["skipped"] = [];
		for (const item of probes) {
			const { probe } = item;
			if (
				probe.kind === "http" &&
				probe.credential !== undefined &&
				!options.available(probe.credential.env)
			) {
				skipped.push({ ...item, reason: "no_credential" });
			} else if (planned + item.cost > budget) {
				skipped.push({ ...item, reason: "budget" });
			} else {
				planned += item.cost;
				run.push(item);
			}
		}
		plan.push({ endpoint: entry.endpoint, run, skipped });
	}
	return { budgetMicroUsd: budget, entries: plan, plannedMicroUsd: planned };
};

/* -------------------------------------------------------------------------- *
 * Example scrubbing (TypeScript only)
 * -------------------------------------------------------------------------- */

const SECRET_KEYS = new Set([
	"access_token",
	"api_key",
	"apikey",
	"authorization",
	"client_secret",
	"cookie",
	"password",
	"private_key",
	"refresh_token",
	"secret",
	"session",
	"set-cookie",
	"token",
]);

const IDENTITY_KEYS = new Set([
	"address",
	"author",
	"avatar_url",
	"bio",
	"blog",
	"company",
	"display_name",
	"email",
	"emails",
	"first_name",
	"full_name",
	"gravatar_id",
	"ip",
	"last_name",
	"location",
	"login",
	"name",
	"node_id",
	"phone",
	"twitter_username",
	"username",
]);

const TEXT_KEYS = new Set([
	"answer",
	"body",
	"comment",
	"content",
	"description",
	"extra_snippets",
	"highlights",
	"message",
	"query",
	"raw_content",
	"snippet",
	"summary",
	"text",
	"title",
]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A trailing `<path>` is consumed so scrubbing an already scrubbed URL is a no-op.
const URL_TEXT = /https?:\/\/[^\s"'<>]+(?:<path>)?/g;
const TOKEN_TEXT =
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{32,})\b/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PHONE = /\+\d[\d\s().-]{7,}\d/g;
const ID_KEY = /(?:^|_)id$/;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 3;
const MAX_OBJECT_KEYS = 40;
const MAX_STRING_LEN = 120;

const urlOrigin = (raw: string): string => {
	try {
		return `${new URL(raw).origin}/<path>`;
	} catch {
		return "<url>";
	}
};

const scrubString = (value: string): string => {
	const scrubbed = value
		.replace(URL_TEXT, (match) => urlOrigin(match))
		.replace(EMAIL, "<email>")
		.replace(TOKEN_TEXT, "<token>")
		.replace(IPV4, "<ip>")
		.replace(PHONE, "<phone>");
	return scrubbed.length > MAX_STRING_LEN
		? `${scrubbed.slice(0, MAX_STRING_LEN)}…`
		: scrubbed;
};

const scrubValue = (value: unknown, key: string, depth: number): unknown => {
	const lower = key.toLowerCase();
	if (SECRET_KEYS.has(lower)) {
		return "<secret>";
	}
	if (value === null || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return ID_KEY.test(lower) ? 0 : value;
	}
	if (IDENTITY_KEYS.has(lower)) {
		return "<identity>";
	}
	if (typeof value === "string") {
		return TEXT_KEYS.has(lower) ? "<text>" : scrubString(value);
	}
	if (depth >= MAX_DEPTH) {
		return "<truncated>";
	}
	if (Array.isArray(value)) {
		return value
			.slice(0, MAX_ARRAY_ITEMS)
			.map((item) => scrubValue(item, key, depth + 1));
	}
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [childKey, child] of Object.entries(value).slice(
			0,
			MAX_OBJECT_KEYS
		)) {
			out[childKey] = scrubValue(child, childKey, depth + 1);
		}
		return out;
	}
	return "<unsupported>";
};

/**
 * A verification example with personal data and secrets removed, safe to keep
 * and show to curators. Secret-named keys become `<secret>`, identity keys
 * (login, name, email, avatar…) `<identity>`, free-text keys (title, body,
 * snippet…) `<text>`, and numbers under `id` keys `0`. Other strings keep
 * only a URL's origin and lose emails, tokens, IPv4 addresses and phone
 * numbers. Depth, arrays (3 items), objects (40 keys) and strings (120
 * characters) are capped, and an example still over {@link MAX_EXAMPLE_BYTES}
 * is replaced by `{"<truncated>": true}`.
 */
export const scrubExample = (value: unknown): unknown => {
	const scrubbed = scrubValue(value, "", 0);
	return JSON.stringify(scrubbed).length > MAX_EXAMPLE_BYTES
		? { "<truncated>": true }
		: scrubbed;
};

/* -------------------------------------------------------------------------- *
 * Toolkit readiness (shared with the Composio cut-over)
 * -------------------------------------------------------------------------- */

export interface ToolkitVerification {
	drifted: number;
	/** Every non-retired entry is verified and at least one exists. */
	ready: boolean;
	retired: number;
	toolkit: string;
	total: number;
	unverified: number;
	verified: number;
}

/**
 * Per-toolkit verification counts. A toolkit is `ready` for a cut-over step
 * when it has at least one live entry and every live entry is verified.
 */
export const summarizeToolkits = (
	entries: readonly CatalogEntry[]
): ToolkitVerification[] => {
	const byToolkit = new Map<string, ToolkitVerification>();
	for (const entry of entries) {
		if (entry.toolkit === undefined) {
			continue;
		}
		const summary = byToolkit.get(entry.toolkit) ?? {
			drifted: 0,
			ready: false,
			retired: 0,
			toolkit: entry.toolkit,
			total: 0,
			unverified: 0,
			verified: 0,
		};
		summary.total += 1;
		summary[entry.verification.state] += 1;
		byToolkit.set(entry.toolkit, summary);
	}
	return [...byToolkit.values()]
		.map((summary) => ({
			...summary,
			ready:
				summary.total - summary.retired > 0 &&
				summary.verified === summary.total - summary.retired,
		}))
		.sort((left, right) => (left.toolkit < right.toolkit ? -1 : 1));
};

/** Ryu's built-in catalog seed, decoded and validated at module load. */
export const BUILTIN_TOOL_CATALOG: ToolCatalog = parseToolCatalog(catalogJson);

/* -------------------------------------------------------------------------- *
 * Generated tier (Treg parity C1)
 * -------------------------------------------------------------------------- */

/**
 * The generated entries that may sit beside `curated` ones: curated wins on
 * collision, so a generated entry is left out when a live curated entry has
 * its endpoint id or describes the same provider operation (any curated entry,
 * retired or not, keeps its endpoint id). Order is kept.
 */
export const generatedEntriesBeside = (
	curated: readonly CatalogEntry[],
	generated: readonly CatalogEntry[]
): CatalogEntry[] => {
	const endpoints = new Set(curated.map((entry) => entry.endpoint));
	const operations = new Set(
		curated
			.filter((entry) => entry.verification.state !== "retired")
			.map(operationKey)
			.filter((key): key is string => key !== null)
	);
	return generated.filter((entry) => {
		const key = operationKey(entry);
		return !(endpoints.has(entry.endpoint) || (key && operations.has(key)));
	});
};

/**
 * Every issue in a generated catalog file checked beside the curated seed:
 * each entry must be `generated` (`not_generated`) and `unverified`
 * (`generated_not_unverified`, as the generator never verifies anything), and
 * the two together must validate as one catalog, so a generated entry that
 * repeats a curated endpoint or operation fails.
 */
export const validateGeneratedCatalog = (
	generated: ToolCatalog,
	curated: ToolCatalog,
	taxonomy: Taxonomy,
	prices: PriceCatalog
): CatalogIssue[] => {
	const issues: CatalogIssue[] = [];
	for (const entry of generated.entries) {
		if (entry.tier !== "generated") {
			issues.push({ code: "not_generated", subject: entry.endpoint });
		}
		if (entry.verification.state !== "unverified") {
			issues.push({
				code: "generated_not_unverified",
				subject: entry.endpoint,
			});
		}
	}
	if (generated.version !== TOOL_CATALOG_VERSION) {
		issues.push({
			code: "unsupported_version",
			subject: String(generated.version),
		});
		return issues;
	}
	issues.push(
		...validateToolCatalog(
			{
				description: curated.description,
				entries: [...curated.entries, ...generated.entries],
				version: TOOL_CATALOG_VERSION,
			},
			taxonomy,
			prices
		)
	);
	return issues;
};

/** Decode and validate a generated catalog beside `curated`; throws on the first issue. */
export const parseGeneratedToolCatalog = (
	value: unknown,
	curated: ToolCatalog = BUILTIN_TOOL_CATALOG,
	taxonomy: Taxonomy = BUILTIN_TAXONOMY,
	prices: PriceCatalog = BUILTIN_PRICE_CATALOG
): ToolCatalog => {
	const catalog = decodeToolCatalog(value);
	const [first, ...rest] = validateGeneratedCatalog(
		catalog,
		curated,
		taxonomy,
		prices
	);
	if (first) {
		throw new Error(
			`generated tool catalog invalid: ${first.code} (${first.subject}), ${rest.length + 1} issue(s)`
		);
	}
	return catalog;
};

let builtinGenerated: ToolCatalog | undefined;

/**
 * Ryu's generated tier (`tool-catalog-generated-v1.json`, written by
 * `tools/tool-catalog-generate.ts`), validated beside the curated seed on
 * first use. Lazy on purpose: a curated edit that a stale generated file now
 * collides with must not stop this module (and so the generator that fixes
 * the file) from loading. Throws when the file is invalid.
 */
export const builtinGeneratedToolCatalog = (): ToolCatalog => {
	builtinGenerated ??= parseGeneratedToolCatalog(generatedCatalogJson);
	return builtinGenerated;
};
