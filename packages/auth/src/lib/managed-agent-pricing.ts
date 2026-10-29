/**
 * Ryu Managed Agents rate card (docs/managed-agents-spec.md §12.2).
 *
 * Vendor LIST prices, effective-dated, used to price usage that a vendor reports in tokens
 * (OpenAI and Gemini) and to cross-check Anthropic, whose `list_cost` is authoritative for
 * billing. Every price is integer micro-USD: token prices per million tokens (USD per MTok ×
 * 1,000,000) and tool prices per call. Every entry cites the official pricing page it was copied
 * from and the day it was read.
 *
 * A model that is not on the card is not priced: platform mode and session budgets refuse it with
 * 422 `model_not_priced`. Models whose vendor price depends on prompt length are listed only when
 * the card can represent the price exactly (see the OpenAI and Anthropic notes below).
 */

export const MANAGED_AGENT_PRICING_VERSION = 1;

export type ManagedAgentRatedBackend = "anthropic" | "openai" | "gemini";
export type ManagedAgentContainerMemoryLimit = "1g" | "4g" | "16g" | "64g";

export interface ManagedAgentRateCardEntry {
	backend: ManagedAgentRatedBackend;
	/** Cache-read (cache hit) token price; cached tokens are charged once, at this rate. */
	cacheReadMicroUsdPerMTok: number;
	/** 1-hour cache-write price; null falls back to the 5-minute price, then the input price. */
	cacheWrite1hMicroUsdPerMTok: number | null;
	/** 5-minute (default) cache-write price; null charges cache writes at the input price. */
	cacheWrite5mMicroUsdPerMTok: number | null;
	/** RFC 3339, inclusive. */
	effectiveFrom: string;
	/** RFC 3339, exclusive; null when no end is announced. */
	effectiveUntil: string | null;
	fileSearchMicroUsdPerCall: number | null;
	groundingMicroUsdPerCall: number | null;
	/** Uncached input token price. */
	inputMicroUsdPerMTok: number;
	/** Exact vendor model id. */
	model: string;
	outputMicroUsdPerMTok: number;
	/** Official pricing URL the entry was copied from. */
	source: string;
	/** YYYY-MM-DD the source was read. */
	verifiedAt: string;
	webSearchMicroUsdPerCall: number | null;
}

/** One unit of vendor usage to price. Token counts are disjoint: `inputTokens` is UNCACHED input. */
export interface ManagedAgentPricedUsage {
	cacheReadInputTokens: number;
	cacheWrite1hInputTokens: number;
	cacheWrite5mInputTokens: number;
	container: {
		memoryLimit: ManagedAgentContainerMemoryLimit;
		billedMinutes: number;
	} | null;
	fileSearchCalls: number;
	groundingCalls: number;
	inputTokens: number;
	outputTokens: number;
	webSearchRequests: number;
}

const ANTHROPIC_PRICING_SOURCE =
	"https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
const GEMINI_PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";
const VERIFIED_AT = "2026-10-10";
const CARD_START = "2026-10-10T00:00:00Z";
const GEMINI_PRICE_CHANGE = "2027-01-01T00:00:00Z";

/** $10.00 per 1,000 web searches (Anthropic and OpenAI). */
const WEB_SEARCH_MICRO_USD_PER_CALL = 10_000;
/** OpenAI file search: $2.50 per 1,000 calls. */
const FILE_SEARCH_MICRO_USD_PER_CALL = 2500;
/**
 * Gemini grounding with Google Search: $14 per 1,000 requests after a monthly free allowance.
 * The allowance belongs to Ryu's project in platform mode, so every call is billed.
 */
const GROUNDING_MICRO_USD_PER_CALL = 14_000;

/**
 * OpenAI containers (Code Interpreter and hosted Shell), micro-USD per 20-minute container
 * session, billed by the minute with a 5-minute minimum that the adapter applies to
 * `billedMinutes` (§10.2).
 */
export const MANAGED_AGENT_CONTAINER_RATES: Readonly<
	Record<ManagedAgentContainerMemoryLimit, number>
> = Object.freeze({
	"1g": 30_000,
	"4g": 120_000,
	"16g": 480_000,
	"64g": 1_920_000,
});
const CONTAINER_SESSION_MINUTES = 20;

interface AnthropicPrices {
	cacheRead: number;
	cacheWrite1h: number;
	cacheWrite5m: number;
	input: number;
	model: string;
	output: number;
}

function anthropicEntry(prices: AnthropicPrices): ManagedAgentRateCardEntry {
	return {
		backend: "anthropic",
		model: prices.model,
		effectiveFrom: CARD_START,
		effectiveUntil: null,
		inputMicroUsdPerMTok: prices.input,
		outputMicroUsdPerMTok: prices.output,
		cacheReadMicroUsdPerMTok: prices.cacheRead,
		cacheWrite5mMicroUsdPerMTok: prices.cacheWrite5m,
		cacheWrite1hMicroUsdPerMTok: prices.cacheWrite1h,
		webSearchMicroUsdPerCall: WEB_SEARCH_MICRO_USD_PER_CALL,
		fileSearchMicroUsdPerCall: null,
		groundingMicroUsdPerCall: null,
		source: ANTHROPIC_PRICING_SOURCE,
		verifiedAt: VERIFIED_AT,
	};
}

interface OpenAiPrices {
	cacheRead: number;
	input: number;
	model: string;
	output: number;
}

function openAiEntry(prices: OpenAiPrices): ManagedAgentRateCardEntry {
	return {
		backend: "openai",
		model: prices.model,
		effectiveFrom: CARD_START,
		effectiveUntil: null,
		inputMicroUsdPerMTok: prices.input,
		outputMicroUsdPerMTok: prices.output,
		cacheReadMicroUsdPerMTok: prices.cacheRead,
		// The pricing page lists no cache-write price for these models, so cache-write tokens
		// (which `input_tokens` includes) are charged at the input price.
		cacheWrite5mMicroUsdPerMTok: null,
		cacheWrite1hMicroUsdPerMTok: null,
		webSearchMicroUsdPerCall: WEB_SEARCH_MICRO_USD_PER_CALL,
		fileSearchMicroUsdPerCall: FILE_SEARCH_MICRO_USD_PER_CALL,
		groundingMicroUsdPerCall: null,
		source: OPENAI_PRICING_SOURCE,
		verifiedAt: VERIFIED_AT,
	};
}

interface GeminiPrices {
	cacheRead: number;
	effectiveFrom: string;
	effectiveUntil: string | null;
	input: number;
	model: string;
	output: number;
}

function geminiEntry(prices: GeminiPrices): ManagedAgentRateCardEntry {
	return {
		backend: "gemini",
		model: prices.model,
		effectiveFrom: prices.effectiveFrom,
		effectiveUntil: prices.effectiveUntil,
		inputMicroUsdPerMTok: prices.input,
		// Output includes thinking tokens.
		outputMicroUsdPerMTok: prices.output,
		cacheReadMicroUsdPerMTok: prices.cacheRead,
		cacheWrite5mMicroUsdPerMTok: null,
		cacheWrite1hMicroUsdPerMTok: null,
		webSearchMicroUsdPerCall: null,
		fileSearchMicroUsdPerCall: null,
		groundingMicroUsdPerCall: GROUNDING_MICRO_USD_PER_CALL,
		source: GEMINI_PRICING_SOURCE,
		verifiedAt: VERIFIED_AT,
	};
}

function geminiFlashEntries(model: string): ManagedAgentRateCardEntry[] {
	return [
		geminiEntry({
			model,
			effectiveFrom: CARD_START,
			effectiveUntil: GEMINI_PRICE_CHANGE,
			input: 750_000,
			output: 3_750_000,
			cacheRead: 75_000,
		}),
		geminiEntry({
			model,
			effectiveFrom: GEMINI_PRICE_CHANGE,
			effectiveUntil: null,
			input: 1_500_000,
			output: 7_500_000,
			cacheRead: 150_000,
		}),
	];
}

/**
 * The rate card. Entries for one `(backend, model)` never overlap in time.
 *
 * - Anthropic (cross-check and BYOK informational only; billing uses the vendor `list_cost`):
 *   standard speed and global inference prices. Claude Haiku 5.5 lists its prompts-up-to-100k
 *   tier only, so a cross-check difference is expected above 100k prompt tokens. Fast mode and
 *   US-only inference multipliers are not represented.
 * - OpenAI: only models with one price at every prompt length. Models whose page price changes
 *   above 272K input tokens (for example `gpt-6-*`, `gpt-5.6-*`, `gpt-5.5`, `gpt-5.4`) are left
 *   off: Responses usage is summed over the model calls of a turn, so the card cannot tell which
 *   tier a turn paid, and those models stay unpriced (fail closed) until it can.
 * - Gemini: the Antigravity agent models, with the 2027-01-01 price change.
 */
export const MANAGED_AGENT_RATE_CARD: readonly ManagedAgentRateCardEntry[] =
	Object.freeze([
		anthropicEntry({
			model: "claude-opus-5-5",
			input: 4_000_000,
			cacheWrite5m: 5_000_000,
			cacheWrite1h: 8_000_000,
			cacheRead: 200_000,
			output: 20_000_000,
		}),
		anthropicEntry({
			model: "claude-opus-5",
			input: 5_000_000,
			cacheWrite5m: 6_250_000,
			cacheWrite1h: 10_000_000,
			cacheRead: 500_000,
			output: 25_000_000,
		}),
		anthropicEntry({
			model: "claude-sonnet-5-5",
			input: 2_000_000,
			cacheWrite5m: 2_500_000,
			cacheWrite1h: 4_000_000,
			cacheRead: 100_000,
			output: 10_000_000,
		}),
		anthropicEntry({
			model: "claude-haiku-5-5",
			input: 100_000,
			cacheWrite5m: 125_000,
			cacheWrite1h: 200_000,
			cacheRead: 10_000,
			output: 500_000,
		}),
		openAiEntry({
			model: "gpt-5.4-mini",
			input: 750_000,
			cacheRead: 75_000,
			output: 4_500_000,
		}),
		openAiEntry({
			model: "gpt-5.4-nano",
			input: 200_000,
			cacheRead: 20_000,
			output: 1_250_000,
		}),
		openAiEntry({
			model: "gpt-5.2",
			input: 1_750_000,
			cacheRead: 175_000,
			output: 14_000_000,
		}),
		openAiEntry({
			model: "gpt-5.1",
			input: 1_250_000,
			cacheRead: 125_000,
			output: 10_000_000,
		}),
		openAiEntry({
			model: "gpt-5",
			input: 1_250_000,
			cacheRead: 125_000,
			output: 10_000_000,
		}),
		openAiEntry({
			model: "gpt-5-mini",
			input: 250_000,
			cacheRead: 25_000,
			output: 2_000_000,
		}),
		openAiEntry({
			model: "gpt-5-nano",
			input: 50_000,
			cacheRead: 5000,
			output: 400_000,
		}),
		...geminiFlashEntries("gemini-3.8-flash"),
		...geminiFlashEntries("gemini-3.6-flash"),
		geminiEntry({
			model: "gemini-3.5-flash-lite",
			effectiveFrom: CARD_START,
			effectiveUntil: null,
			input: 300_000,
			output: 2_500_000,
			cacheRead: 30_000,
		}),
	]);

/**
 * The entry in effect for `(backend, model)` at `at`, or null when the model is not priced then.
 * The model id must match exactly.
 */
export function findManagedAgentRate(
	backend: string,
	model: string,
	at: Date
): ManagedAgentRateCardEntry | null {
	const atMs = at.getTime();
	if (!Number.isFinite(atMs)) {
		return null;
	}
	for (const entry of MANAGED_AGENT_RATE_CARD) {
		if (entry.backend !== backend || entry.model !== model) {
			continue;
		}
		const fromMs = Date.parse(entry.effectiveFrom);
		const untilMs =
			entry.effectiveUntil === null
				? Number.POSITIVE_INFINITY
				: Date.parse(entry.effectiveUntil);
		if (atMs >= fromMs && atMs < untilMs) {
			return entry;
		}
	}
	return null;
}

const MICRO_UNITS_PER_MILLION = 1_000_000n;

/** A count as a non-negative integer BigInt; anything else (negative, fractional, NaN) is 0. */
function countOf(value: number): bigint {
	if (!(Number.isSafeInteger(value) && value > 0)) {
		return 0n;
	}
	return BigInt(value);
}

function priceOf(value: number | null): bigint {
	return value === null ? 0n : countOf(value);
}

/**
 * Integer micro-USD list cost of one usage unit. Every term is an exact rational with denominator
 * 1,000,000 (token prices are per million tokens, per-call prices are whole micro-USD and a
 * container minute is 1/20 of a session price), so the terms are summed exactly and rounded half
 * up once.
 *
 * With a null entry the model is unpriced: token and per-call charges are unknown and contribute
 * nothing, and only the container charge, which does not depend on the model, is priced.
 */
export function priceManagedAgentUsage(
	entry: ManagedAgentRateCardEntry | null,
	usage: ManagedAgentPricedUsage
): number {
	// Numerator over a denominator of 1,000,000 micro-USD.
	let numerator = 0n;
	if (entry !== null) {
		const inputPrice = priceOf(entry.inputMicroUsdPerMTok);
		const cacheWrite5mPrice =
			entry.cacheWrite5mMicroUsdPerMTok === null
				? inputPrice
				: priceOf(entry.cacheWrite5mMicroUsdPerMTok);
		const cacheWrite1hPrice =
			entry.cacheWrite1hMicroUsdPerMTok === null
				? cacheWrite5mPrice
				: priceOf(entry.cacheWrite1hMicroUsdPerMTok);
		numerator += countOf(usage.inputTokens) * inputPrice;
		numerator +=
			countOf(usage.outputTokens) * priceOf(entry.outputMicroUsdPerMTok);
		numerator +=
			countOf(usage.cacheReadInputTokens) *
			priceOf(entry.cacheReadMicroUsdPerMTok);
		numerator += countOf(usage.cacheWrite5mInputTokens) * cacheWrite5mPrice;
		numerator += countOf(usage.cacheWrite1hInputTokens) * cacheWrite1hPrice;
		const perCall =
			countOf(usage.webSearchRequests) *
				priceOf(entry.webSearchMicroUsdPerCall) +
			countOf(usage.fileSearchCalls) *
				priceOf(entry.fileSearchMicroUsdPerCall) +
			countOf(usage.groundingCalls) * priceOf(entry.groundingMicroUsdPerCall);
		numerator += perCall * MICRO_UNITS_PER_MILLION;
	}
	if (usage.container !== null) {
		const sessionPrice = BigInt(
			MANAGED_AGENT_CONTAINER_RATES[usage.container.memoryLimit] ?? 0
		);
		// sessionPrice × minutes / 20, expressed over the 1,000,000 denominator.
		numerator +=
			(sessionPrice *
				countOf(usage.container.billedMinutes) *
				MICRO_UNITS_PER_MILLION) /
			BigInt(CONTAINER_SESSION_MINUTES);
	}
	const rounded =
		(numerator + MICRO_UNITS_PER_MILLION / 2n) / MICRO_UNITS_PER_MILLION;
	return Number(rounded);
}
