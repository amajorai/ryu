import { translate as tl } from "@ryu/i18n/core";
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

/** The budget select's options, labelled in the language the UI shows now. */
export function budgetItems(): { label: string; value: string }[] {
	return [
		{ value: BUDGET_OFF, label: tl("Off — send the whole conversation") },
		{
			value: BUDGET_AUTO,
			label: tl("Auto — needs a context size set for the model"),
		},
		...CONTEXT_PRESETS.map((n) => ({
			value: String(n),
			label: tl("{count} tokens", { count: formatNumber(n) }),
		})),
		{ value: BUDGET_CUSTOM, label: tl("Custom…") },
	];
}

/** Who a scoped `context.max-tokens` key applies to, for the card's note. */
function scopedOverrideAudience(key: string): string {
	if (key.startsWith(CONTEXT_MAX_TOKENS_ENGINE_PREF_PREFIX)) {
		return tl("agents on the {engine} engine", {
			engine: key.slice(CONTEXT_MAX_TOKENS_ENGINE_PREF_PREFIX.length),
		});
	}
	return tl("local-engine agents");
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
			? tl("It also keeps trimming off for {audience}.", { audience })
			: tl("It turns trimming off for {audience}, overriding this setting.", {
					audience,
				});
	}
	return globalBudget.kind === "off"
		? tl("It trims turns for {audience} even while this is Off.", { audience })
		: tl("It overrides this setting for {audience}.", { audience });
}
