import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import {
	CONTEXT_MAX_TOKENS_ENGINE_PREF_PREFIX,
	type ContextBudget,
	parseContextBudget,
	type ScopedContextBudgetOverride,
} from "@/src/lib/api/preferences.ts";

/** Budgets offered as one-click presets, in tokens. */
export const CONTEXT_PRESETS = [4096, 8192, 16_384, 32_768, 65_536, 131_072];
/** Sentinel select values (Base UI Select is unreliable with empty strings). */
export const BUDGET_OFF = "off";
export const BUDGET_AUTO = "auto";
export const BUDGET_CUSTOM = "custom";
/** Seed for a Custom pick made from Off/Auto, where there is no current number. */
export const CUSTOM_SEED_TOKENS = 8192;

export const BUDGET_ITEMS = [
	{ value: BUDGET_OFF, label: "Off — send the whole conversation" },
	{
		value: BUDGET_AUTO,
		label: "Auto — needs a context size set for the model",
	},
	...CONTEXT_PRESETS.map((n) => ({
		value: String(n),
		label: `${formatNumber(n)} tokens`,
	})),
	{ value: BUDGET_CUSTOM, label: "Custom…" },
];

/** Who a scoped `context.max-tokens` key applies to, for the card's note. */
function scopedOverrideAudience(key: string): string {
	if (key.startsWith(CONTEXT_MAX_TOKENS_ENGINE_PREF_PREFIX)) {
		return `agents on the ${key.slice(CONTEXT_MAX_TOKENS_ENGINE_PREF_PREFIX.length)} engine`;
	}
	return "local-engine agents";
}

/**
 * What a set scoped override does relative to the global budget shown on the
 * card. Core picks the scoped value instead of the global one, and parses it
 * with the same off/auto/number rules, so an `off` (or unparseable) override
 * disables trimming for its agents even when the global budget is on.
 */
export function scopedOverrideEffect(
	override: ScopedContextBudgetOverride,
	globalBudget: ContextBudget
): string {
	const audience = scopedOverrideAudience(override.key);
	if (parseContextBudget(override.value).kind === "off") {
		return globalBudget.kind === "off"
			? `It also keeps trimming off for ${audience}.`
			: `It turns trimming off for ${audience}, overriding this setting.`;
	}
	return globalBudget.kind === "off"
		? `It trims turns for ${audience} even while this is Off.`
		: `It overrides this setting for ${audience}.`;
}
