import { z } from "zod";
import type { OpenRouterProvider } from "@/src/lib/api/openrouter.ts";
import {
	type NodeRoutingPreferences,
	type OpenRouterOption,
	type OpenRouterOptions,
	openRouterOptionsSchema,
	parseNodeRoutingPreferences,
} from "@/src/lib/api/preferences.ts";

export const EMPTY_PATTERNS = "";
export const PROVIDER_LIST_ID = "openrouter-provider-catalog";
export const QUANTIZATIONS = [
	"int4",
	"int8",
	"fp4",
	"mxfp4",
	"nvfp4",
	"fp6",
	"fp8",
	"mxfp8",
	"fp16",
	"bf16",
	"fp32",
	"unknown",
] as const;
export const PERCENTILES = ["p50", "p75", "p90", "p99"] as const;
export const SORT_STRATEGIES = ["price", "throughput", "latency"] as const;
export type Percentile = (typeof PERCENTILES)[number];

/** Sparse numeric values for the four percentile controls authored below. */
export interface PercentileValues {
	p50?: number;
	p75?: number;
	p90?: number;
	p99?: number;
}
export type ProviderListKey = "only" | "ignore";

export function isRecord(
	value: Parameters<typeof openRouterOptionsSchema.safeParse>[0]
): value is OpenRouterOptions {
	return openRouterOptionsSchema.safeParse(value).success;
}

export function patternsText(prefs: NodeRoutingPreferences): string {
	const patterns = prefs.firewall?.custom_patterns ?? [];
	return patterns.length > 0
		? JSON.stringify(patterns, null, 2)
		: EMPTY_PATTERNS;
}

export function formatOpenRouterOptions(
	options: NodeRoutingPreferences["openrouter"]
): string {
	return options ? JSON.stringify(options, null, 2) : "";
}

export function parsePatterns(raw: string): NodeRoutingPreferences["firewall"] {
	if (!raw.trim()) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("Extra firewall rules must be valid JSON.");
	}
	if (!Array.isArray(value)) {
		throw new Error("Extra firewall rules must be a JSON array.");
	}
	const parsed = parseNodeRoutingPreferences(
		JSON.stringify({ firewall: { custom_patterns: value } })
	);
	if (parsed.firewall?.custom_patterns.length !== value.length) {
		throw new Error(
			"Each rule needs a kind (pii, secret, or prompt_injection), name, and regex."
		);
	}
	return parsed.firewall;
}

export function parseOpenRouterOptions(raw: string): OpenRouterOptions | null {
	if (!raw.trim()) {
		return null;
	}
	let parsed: ReturnType<typeof openRouterOptionsSchema.safeParse>;
	try {
		parsed = openRouterOptionsSchema.safeParse(JSON.parse(raw));
	} catch {
		throw new Error("Advanced OpenRouter options must be valid JSON.");
	}
	if (!parsed.success) {
		throw new Error("Advanced OpenRouter options must be a JSON object.");
	}
	return parsed.data;
}

export function stringList(value: OpenRouterOption | undefined): string[] {
	return Array.isArray(value)
		? value.flatMap((entry) => {
				const parsed = z.string().safeParse(entry);
				return parsed.success ? [parsed.data] : [];
			})
		: [];
}

export function withOption(
	options: OpenRouterOptions | null,
	key: string,
	value: OpenRouterOption | undefined
): OpenRouterOptions | null {
	const next: OpenRouterOptions = Object.fromEntries(
		Object.entries(options ?? {}).filter(([entryKey]) => entryKey !== key)
	);
	if (value !== undefined && value !== null) {
		next[key] = value;
	}
	return Object.keys(next).length > 0 ? next : null;
}

export function optionNumber(options: OpenRouterOptions | null, key: string) {
	const parsed = z.number().finite().safeParse(options?.[key]);
	return parsed.success ? parsed.data : undefined;
}

export function percentileValues(
	options: OpenRouterOptions | null,
	key: string
): PercentileValues {
	const value = options?.[key];
	const numeric = z.number().finite().safeParse(value);
	if (numeric.success) {
		return { p50: numeric.data };
	}
	if (!isRecord(value)) {
		return {};
	}
	const result: PercentileValues = {};
	for (const percentile of PERCENTILES) {
		const parsed = z.number().finite().safeParse(value[percentile]);
		if (parsed.success) {
			result[percentile] = parsed.data;
		}
	}
	return result;
}

export function sortStrategy(options: OpenRouterOptions | null): string {
	const sort = options?.sort;
	const parsed = z.enum(SORT_STRATEGIES).safeParse(sort);
	return parsed.success
		? parsed.data
		: sort === undefined
			? "default"
			: "custom";
}

export function sortStrategyLabel(value: string): string {
	if (value === "throughput") {
		return "Higher throughput first";
	}
	if (value === "latency") {
		return "Lower latency first";
	}
	if (value === "price") {
		return "Lower price first";
	}
	if (value === "custom") {
		return "Custom (advanced JSON)";
	}
	return "OpenRouter health-aware default";
}

export function dataCollectionLabel(value: string): string {
	if (value === "allow") {
		return "Allow collection";
	}
	if (value === "deny") {
		return "Exclude data-collecting providers";
	}
	return "OpenRouter default";
}

export function providerName(
	providers: OpenRouterProvider[],
	slug: string
): string {
	return providers.find((provider) => provider.slug === slug)?.name ?? slug;
}

export function numericText(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}
