/**
 * Per-endpoint tool price records (Treg parity B2).
 *
 * This is the TypeScript twin of the Rust contract `ryu_gw_contracts::tool_price`.
 * Both read Ryu's catalog, `crates/gateway/contracts/fixtures/tool-price-v1.json`,
 * and assert the same golden cases, `tool-price-cases-v1.json`.
 *
 * A price is recorded in the vendor's native unit (USD, or a vendor credit such
 * as `tavily_credit`) with its provenance (`vendor_page`, `vendor_api`,
 * `ryu_measured`, `unverified`), a confidence, the date it was checked and its
 * source URL. It is a small rule table summed per call: `per_call`, `per_unit`
 * on a named meter, and graduated monthly `tiered` rules. `free` is its own
 * variant, so a missing price never reads as zero.
 *
 * Money rules: an `unverified` price, or a native unit whose USD rate is
 * unverified or missing, never quotes, so it never routes a paid call. A quote
 * sums every component exactly and rounds up once. Each record carries its
 * catalog `source` (`ryu` or `treg`); {@link selectPrice} merges the two under a
 * {@link PricePrecedence}, by default Ryu's own record where verified, else
 * Treg's.
 */

import { z } from "zod";
import catalogJson from "../../../crates/gateway/contracts/fixtures/tool-price-v1.json" with {
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

/** Version of this contract and of `tool-price-v1.json`. */
export const TOOL_PRICE_VERSION = 1 as const;

/** The one unit that needs no rate: amounts are micro-USD. */
export const USD_UNIT = "USD";

/** The reserved meter that counts calls. */
export const CALLS_METER = "calls";

/** Largest charge a quote returns (the safe-integer range). */
export const MAX_QUOTE_MICRO_USD = Number.MAX_SAFE_INTEGER;

const MICRO = 1_000_000n;
const MAX_ENDPOINT_LEN = 128;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;
const SNAKE_NAME = /^[a-z][a-z0-9_]*$/;
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_-]+$/;

const provenanceSchema = z.enum([
	"vendor_page",
	"vendor_api",
	"ryu_measured",
	"unverified",
]);
const confidenceSchema = z.enum(["high", "medium", "low"]);
const sourceSchema = z.enum(["ryu", "treg"]);
const precedenceSchema = z.enum([
	"ryu_verified_first",
	"treg_first",
	"ryu_only",
	"treg_only",
]);
const amountSchema = z.number().nonnegative();

const tierSchema = z.strictObject({
	microAmount: amountSchema,
	per: amountSchema,
	upTo: amountSchema.nullable(),
});

const componentSchema = z.discriminatedUnion("rule", [
	z.strictObject({
		microAmount: amountSchema,
		per: amountSchema,
		rule: z.literal("per_call"),
	}),
	z.strictObject({
		meter: z.string(),
		microAmount: amountSchema,
		per: amountSchema,
		rule: z.literal("per_unit"),
	}),
	z.strictObject({
		meter: z.string(),
		rule: z.literal("tiered"),
		tiers: z.array(tierSchema),
	}),
]);

const priceSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("free") }),
	z.strictObject({
		components: z.array(componentSchema),
		type: z.literal("metered"),
		unit: z.string(),
	}),
]);

const recordSchema = z.strictObject({
	capability: z.string().optional(),
	checkedOn: z.string().optional(),
	confidence: confidenceSchema,
	endpoint: z.string(),
	model: z.string().optional(),
	note: z.string().optional(),
	platform: z.string().optional(),
	price: priceSchema,
	provenance: provenanceSchema,
	provider: z.string(),
	source: sourceSchema,
	sourceUrl: z.string().optional(),
});

const rateSchema = z.strictObject({
	checkedOn: z.string().optional(),
	confidence: confidenceSchema,
	kind: z.enum(["currency", "vendor_credit"]),
	microUsd: amountSchema,
	note: z.string().optional(),
	per: amountSchema,
	provenance: provenanceSchema,
	sourceUrl: z.string().optional(),
	unit: z.string(),
});

const catalogSchema = z.strictObject({
	description: z.string(),
	rows: z.array(recordSchema),
	staleAfterDays: z.int().nonnegative(),
	usdRates: z.array(rateSchema),
	version: z.int().nonnegative(),
});

const usageSchema = z.strictObject({
	calls: amountSchema.default(0),
	meters: z.record(z.string(), amountSchema).default(() => ({})),
	monthToDate: z.record(z.string(), amountSchema).default(() => ({})),
});

export type PriceProvenance = z.infer<typeof provenanceSchema>;
export type PriceConfidence = z.infer<typeof confidenceSchema>;
export type PriceSource = z.infer<typeof sourceSchema>;
export type PricePrecedence = z.infer<typeof precedenceSchema>;
export type PriceTier = z.infer<typeof tierSchema>;
export type PriceComponent = z.infer<typeof componentSchema>;
export type PriceRule = z.infer<typeof priceSchema>;
export type PriceRecord = z.infer<typeof recordSchema>;
export type UsdRate = z.infer<typeof rateSchema>;
export type PriceCatalog = z.infer<typeof catalogSchema>;
export type PriceUsage = z.infer<typeof usageSchema>;

/** The default precedence: Ryu's verified record, else Treg's. */
export const DEFAULT_PRICE_PRECEDENCE: PricePrecedence = "ryu_verified_first";

export type QuoteError =
	| "invalid_price"
	| "price_unverified"
	| "unknown_unit"
	| "invalid_rate"
	| "rate_unverified"
	| "overflow";

export type PriceQuoteResult =
	| { free: boolean; microUsd: number; ok: true }
	| { error: QuoteError; ok: false };

export interface PriceIssue {
	code: string;
	subject: string;
}

export const decodePriceRecord = (value: unknown): PriceRecord =>
	recordSchema.parse(value);
export const decodeUsdRate = (value: unknown): UsdRate =>
	rateSchema.parse(value);
export const decodePriceUsage = (value: unknown): PriceUsage =>
	usageSchema.parse(value);
export const decodePricePrecedence = (value: unknown): PricePrecedence =>
	precedenceSchema.parse(value);
export const decodePriceCatalog = (value: unknown): PriceCatalog =>
	catalogSchema.parse(value);

/** `[a-z0-9][a-z0-9-]*`, at most 64 characters. */
export const isValidProviderId = (id: string): boolean =>
	id.length <= 64 && PROVIDER_ID.test(id);

/**
 * `<provider>.<operation>…`: a provider id, then one or more segments of
 * `[A-Za-z0-9_-]`, at most 128 characters.
 */
export const isValidEndpointId = (id: string): boolean => {
	if (id.length === 0 || id.length > MAX_ENDPOINT_LEN) {
		return false;
	}
	const [head = "", ...rest] = id.split(".");
	return (
		isValidProviderId(head) &&
		rest.length >= 1 &&
		rest.every((segment) => ENDPOINT_SEGMENT.test(segment))
	);
};

const isSnakeName = (value: string): boolean =>
	value.length <= 64 && SNAKE_NAME.test(value);

/** `USD` or a lowercase native unit name. */
export const isValidUnit = (unit: string): boolean =>
	unit === USD_UNIT || isSnakeName(unit);

const isHttpsUrl = (value: string): boolean => {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" && parsed.hostname !== "";
	} catch {
		return false;
	}
};

const isSafeAmount = (value: number): boolean => Number.isSafeInteger(value);

const checkEvidence = (
	evidence: {
		checkedOn?: string;
		confidence: PriceConfidence;
		provenance: PriceProvenance;
		sourceUrl?: string;
	},
	codes: Set<string>
) => {
	if (evidence.checkedOn === undefined) {
		if (evidence.provenance !== "unverified") {
			codes.add("missing_checked_on");
		}
	} else if (!isValidIsoDate(evidence.checkedOn)) {
		codes.add("invalid_checked_on");
	}
	if (evidence.sourceUrl === undefined) {
		if (
			evidence.provenance === "vendor_page" ||
			evidence.provenance === "vendor_api"
		) {
			codes.add("missing_source_url");
		}
	} else if (!isHttpsUrl(evidence.sourceUrl)) {
		codes.add("invalid_source_url");
	}
	if (evidence.provenance === "unverified" && evidence.confidence !== "low") {
		codes.add("unverified_confidence");
	}
};

const checkAmount = (
	microAmount: number,
	per: number,
	codes: Set<string>
): boolean => {
	if (per === 0) {
		codes.add("zero_per");
	}
	if (!(isSafeAmount(microAmount) && isSafeAmount(per))) {
		codes.add("unsafe_amount");
	}
	return microAmount > 0;
};

const checkTiers = (tiers: PriceTier[], codes: Set<string>) => {
	if (tiers.length === 0) {
		codes.add("invalid_tiers");
		return;
	}
	let previous = 0;
	let charges = false;
	for (const [index, tier] of tiers.entries()) {
		const last = index === tiers.length - 1;
		if (tier.upTo === null) {
			if (!last) {
				codes.add("invalid_tiers");
			}
		} else if (last || tier.upTo <= previous) {
			codes.add("invalid_tiers");
		} else {
			previous = tier.upTo;
		}
		if (tier.upTo !== null && !isSafeAmount(tier.upTo)) {
			codes.add("unsafe_amount");
		}
		charges = checkAmount(tier.microAmount, tier.per, codes) || charges;
	}
	if (!charges) {
		codes.add("zero_amount");
	}
};

const checkComponent = (component: PriceComponent, codes: Set<string>) => {
	switch (component.rule) {
		case "per_call":
			if (component.microAmount === 0) {
				codes.add("zero_amount");
			}
			checkAmount(component.microAmount, component.per, codes);
			return;
		case "per_unit":
			if (!isSnakeName(component.meter) || component.meter === CALLS_METER) {
				codes.add("invalid_meter");
			}
			if (component.microAmount === 0) {
				codes.add("zero_amount");
			}
			checkAmount(component.microAmount, component.per, codes);
			return;
		case "tiered":
			if (!isSnakeName(component.meter)) {
				codes.add("invalid_meter");
			}
			checkTiers(component.tiers, codes);
			return;
		default:
			return;
	}
};

const checkTaxonomyRef = (record: PriceRecord, codes: Set<string>) => {
	const { capability, model, platform } = record;
	if (platform !== undefined && capability !== undefined) {
		if (!(isValidPlatformId(platform) && isValidCapabilityId(capability))) {
			codes.add("invalid_taxonomy_ref");
		}
	} else if (platform !== undefined || capability !== undefined) {
		codes.add("partial_taxonomy_ref");
	}
	if (model !== undefined) {
		if (capability === undefined) {
			codes.add("model_without_capability");
		}
		if (!(model.length > 0 && isValidModelId(model))) {
			codes.add("invalid_model");
		}
	}
};

/** Every rule a record breaks, as sorted codes. Empty means valid. */
export const validatePriceRecord = (record: PriceRecord): string[] => {
	const codes = new Set<string>();
	if (!isValidEndpointId(record.endpoint)) {
		codes.add("invalid_endpoint");
	}
	if (!isValidProviderId(record.provider)) {
		codes.add("invalid_provider");
	}
	checkTaxonomyRef(record, codes);
	if (record.price.type === "free") {
		if (record.provenance === "unverified") {
			codes.add("unverified_free");
		}
	} else {
		if (!isValidUnit(record.price.unit)) {
			codes.add("invalid_unit");
		}
		if (record.price.components.length === 0) {
			codes.add("no_components");
		}
		for (const component of record.price.components) {
			checkComponent(component, codes);
		}
	}
	checkEvidence(record, codes);
	return [...codes].sort();
};

/** Every rule a USD rate breaks, as sorted codes. Empty means valid. */
export const validateUsdRate = (rate: UsdRate): string[] => {
	const codes = new Set<string>();
	if (rate.unit === USD_UNIT) {
		codes.add("usd_rate");
	} else if (!isValidUnit(rate.unit)) {
		codes.add("invalid_unit");
	}
	if (rate.microUsd === 0) {
		codes.add("zero_amount");
	}
	if (rate.per === 0) {
		codes.add("zero_per");
	}
	if (!(isSafeAmount(rate.microUsd) && isSafeAmount(rate.per))) {
		codes.add("unsafe_amount");
	}
	checkEvidence(rate, codes);
	return [...codes].sort();
};

/** Whether a record may price a call that someone pays for. */
export const paidRoutingAllowed = (record: PriceRecord): boolean =>
	record.provenance !== "unverified" &&
	validatePriceRecord(record).length === 0;

const gcd = (left: bigint, right: bigint): bigint => {
	let a = left;
	let b = right;
	while (b !== 0n) {
		[a, b] = [b, a % b];
	}
	return a;
};

/** An exact non-negative fraction, reduced after every step. */
class Fraction {
	readonly numerator: bigint;
	readonly denominator: bigint;

	constructor(numerator: bigint, denominator: bigint) {
		const divisor = gcd(numerator, denominator);
		this.numerator = divisor > 1n ? numerator / divisor : numerator;
		this.denominator = divisor > 1n ? denominator / divisor : denominator;
	}

	/** `this + quantity * amount / per`. */
	add(quantity: number, amount: number, per: number): Fraction {
		const divisor = BigInt(per);
		return new Fraction(
			this.numerator * divisor +
				BigInt(quantity) * BigInt(amount) * this.denominator,
			this.denominator * divisor
		);
	}

	/** `this * multiplier / divisor`. */
	scale(multiplier: bigint, divisor: bigint): Fraction {
		return new Fraction(
			this.numerator * multiplier,
			this.denominator * divisor
		);
	}

	ceil(): bigint {
		return (this.numerator + this.denominator - 1n) / this.denominator;
	}
}

const meterQuantity = (usage: PriceUsage, meter: string): number =>
	meter === CALLS_METER ? usage.calls : (usage.meters[meter] ?? 0);

const addTiered = (
	total: Fraction,
	meter: string,
	tiers: PriceTier[],
	usage: PriceUsage
): Fraction => {
	const before = usage.monthToDate[meter] ?? 0;
	const after = before + meterQuantity(usage, meter);
	let sum = total;
	let floor = 0;
	for (const tier of tiers) {
		const ceiling = tier.upTo ?? Number.POSITIVE_INFINITY;
		const start = Math.max(before, floor);
		const end = Math.min(after, ceiling);
		if (end > start) {
			sum = sum.add(end - start, tier.microAmount, tier.per);
		}
		floor = ceiling;
	}
	return sum;
};

const resolveRate = (
	unit: string,
	rates: readonly UsdRate[]
): { error: QuoteError } | { microUsd: bigint; per: bigint } => {
	if (unit === USD_UNIT) {
		return { microUsd: MICRO, per: 1n };
	}
	const rate = rates.find((candidate) => candidate.unit === unit);
	if (!rate) {
		return { error: "unknown_unit" };
	}
	if (validateUsdRate(rate).length > 0) {
		return { error: "invalid_rate" };
	}
	if (rate.provenance === "unverified") {
		return { error: "rate_unverified" };
	}
	return { microUsd: BigInt(rate.microUsd), per: BigInt(rate.per) };
};

/** Price `usage` under `record`, converting native units through `rates`. */
export const quotePrice = (
	record: PriceRecord,
	usage: PriceUsage,
	rates: readonly UsdRate[]
): PriceQuoteResult => {
	if (validatePriceRecord(record).length > 0) {
		return { error: "invalid_price", ok: false };
	}
	if (record.price.type === "free") {
		return { free: true, microUsd: 0, ok: true };
	}
	if (record.provenance === "unverified") {
		return { error: "price_unverified", ok: false };
	}
	const rate = resolveRate(record.price.unit, rates);
	if ("error" in rate) {
		return { error: rate.error, ok: false };
	}
	let native = new Fraction(0n, 1n);
	for (const component of record.price.components) {
		switch (component.rule) {
			case "per_call":
				native = native.add(usage.calls, component.microAmount, component.per);
				break;
			case "per_unit":
				native = native.add(
					meterQuantity(usage, component.meter),
					component.microAmount,
					component.per
				);
				break;
			case "tiered":
				native = addTiered(native, component.meter, component.tiers, usage);
				break;
			default:
				break;
		}
	}
	const microUsd = native.scale(rate.microUsd, rate.per * MICRO).ceil();
	if (microUsd > BigInt(MAX_QUOTE_MICRO_USD)) {
		return { error: "overflow", ok: false };
	}
	return { free: false, microUsd: Number(microUsd), ok: true };
};

/**
 * Merge one endpoint's Ryu and Treg records under `precedence`. The winner
 * keeps its own `source` label, which callers must show beside the price.
 */
export const selectPrice = (
	ryu: PriceRecord | null | undefined,
	treg: PriceRecord | null | undefined,
	precedence: PricePrecedence = DEFAULT_PRICE_PRECEDENCE
): PriceRecord | null => {
	switch (precedence) {
		case "ryu_verified_first":
			if (ryu && ryu.provenance !== "unverified") {
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

const checkRowTaxonomy = (
	row: PriceRecord,
	taxonomy: Taxonomy,
	push: (code: string) => void
) => {
	const { capability, model, platform } = row;
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

/** Every issue in Ryu's own catalog, checked against `taxonomy`. */
export const validatePriceCatalog = (
	catalog: PriceCatalog,
	taxonomy: Taxonomy
): PriceIssue[] => {
	const issues: PriceIssue[] = [];
	const push = (code: string, subject: string) => {
		issues.push({ code, subject });
	};
	if (catalog.version !== TOOL_PRICE_VERSION) {
		push("unsupported_version", String(catalog.version));
		return issues;
	}
	if (catalog.staleAfterDays === 0) {
		push("invalid_stale_after", "staleAfterDays");
	}
	const units = new Set<string>();
	for (const rate of catalog.usdRates) {
		for (const code of validateUsdRate(rate)) {
			push(code, rate.unit);
		}
		if (units.has(rate.unit)) {
			push("duplicate_unit", rate.unit);
		}
		units.add(rate.unit);
	}
	const endpoints = new Set<string>();
	for (const row of catalog.rows) {
		const subject = row.endpoint;
		for (const code of validatePriceRecord(row)) {
			push(code, subject);
		}
		if (endpoints.has(subject)) {
			push("duplicate_endpoint", subject);
		}
		endpoints.add(subject);
		if (row.source !== "ryu") {
			push("foreign_source", subject);
		}
		if (
			row.price.type === "metered" &&
			row.price.unit !== USD_UNIT &&
			!units.has(row.price.unit)
		) {
			push("unknown_unit", subject);
		}
		checkRowTaxonomy(row, taxonomy, (code) => push(code, subject));
	}
	return issues;
};

/** Decode and validate a catalog against `taxonomy`; throws on the first issue. */
export const parsePriceCatalog = (
	value: unknown,
	taxonomy: Taxonomy = BUILTIN_TAXONOMY
): PriceCatalog => {
	const catalog = decodePriceCatalog(value);
	const [first, ...rest] = validatePriceCatalog(catalog, taxonomy);
	if (first) {
		throw new Error(
			`price catalog invalid: ${first.code} (${first.subject}), ${rest.length + 1} issue(s)`
		);
	}
	return catalog;
};

/** Ryu's built-in price catalog, decoded and validated at module load. */
export const BUILTIN_PRICE_CATALOG: PriceCatalog =
	parsePriceCatalog(catalogJson);

/** Quote an endpoint from a catalog with that catalog's own rate table. */
export const quoteCatalogEndpoint = (
	catalog: PriceCatalog,
	endpoint: string,
	usage: PriceUsage
): PriceQuoteResult | null => {
	const row = catalog.rows.find((candidate) => candidate.endpoint === endpoint);
	return row ? quotePrice(row, usage, catalog.usdRates) : null;
};
