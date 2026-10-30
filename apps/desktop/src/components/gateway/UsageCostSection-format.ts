// Constants and formatting helpers shared by the Usage & Cost cards.

import {
	formatCurrency,
	formatNumber as formatSharedNumber,
} from "@ryu/ui/lib/number-format.ts";
import type { ProviderQuota } from "@/src/lib/api/gateway.ts";

const MICRO_PER_USD = 1_000_000;
const SECONDS_PER_MINUTE = 60;
export const TICK_MS = 1000;

/** All provider kinds a cost tier can be assigned to (the 9 gateway kinds). */
export const TIER_PROVIDER_KINDS = [
	"openai",
	"anthropic",
	"local",
	"openrouter",
	"core",
	"modal",
	"genai",
	"replicate",
	"fal",
] as const;

const PROVIDER_LABELS = new Map<string, string>([
	["openai", "OpenAI"],
	["anthropic", "Anthropic"],
	["local", "Local"],
	["openrouter", "OpenRouter"],
	["core", "Core"],
	["modal", "Modal"],
	["genai", "Gemini"],
	["replicate", "Replicate"],
	["fal", "Fal"],
]);

export const ROTATION_PROVIDERS: {
	slug: string;
	label: string;
	envVar: string;
}[] = [
	{ slug: "openai", label: "OpenAI", envVar: "OPENAI_API_KEYS" },
	{ slug: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEYS" },
	{ slug: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEYS" },
];

export const TIER_OPTIONS: { value: string; label: string }[] = [
	{ value: "0", label: "Subscription (0)" },
	{ value: "1", label: "Cheap (1)" },
	{ value: "2", label: "Free (2)" },
];

export function providerLabel(kind: string): string {
	return PROVIDER_LABELS.get(kind) ?? kind;
}

export function formatCost(microUsd: number): string {
	const dollars = microUsd / MICRO_PER_USD;
	if (dollars > 0 && dollars < 0.01) {
		return "<$0.01";
	}
	return formatCurrency(dollars, "USD", {
		maximumFractionDigits: dollars >= 10 ? 0 : 2,
	});
}

export function formatNumber(value: number): string {
	return formatSharedNumber(value);
}

/** "2m 05s" / "42s" / "now" / "—" for a whole-seconds countdown. */
export function formatCountdown(secs: number | null): string {
	if (secs === null) {
		return "—";
	}
	if (secs <= 0) {
		return "now";
	}
	const minutes = Math.floor(secs / SECONDS_PER_MINUTE);
	const seconds = secs % SECONDS_PER_MINUTE;
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}

export function formatQuota(quota: ProviderQuota): string {
	if (quota.remaining === null && quota.limit === null) {
		return "—";
	}
	const remaining =
		quota.remaining === null ? "?" : formatNumber(quota.remaining);
	if (quota.limit === null) {
		return remaining;
	}
	return `${remaining} / ${formatNumber(quota.limit)}`;
}
