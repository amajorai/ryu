import type { ComposerSettingItem } from "@/components/agent-elements/input/composer-settings-menu.tsx";

/** OpenRouter's general-purpose model router. */
export const OPENROUTER_AUTO_MODEL_ID = "openrouter/auto";

/** OpenRouter's coding-focused Pareto router. */
export const OPENROUTER_PARETO_CODE_MODEL_ID = "openrouter/pareto-code";

const ROUTER_MODEL_LABELS = new Map<
	string,
	{ description: string; name: string }
>([
	[
		OPENROUTER_AUTO_MODEL_ID,
		{
			name: "Auto Router",
			description: "OpenRouter picks a strong model for each task.",
		},
	],
	[
		OPENROUTER_PARETO_CODE_MODEL_ID,
		{
			name: "Auto Code",
			description: "OpenRouter picks a coding model with its Pareto router.",
		},
	],
]);

const RYU_ALIAS_TIERS: Record<string, string> = {
	code: "Code",
	fast: "Fast",
	frontier: "Frontier",
	reasoning: "Reasoning",
	vision: "Vision",
};

const RYU_ALIAS_SIZES: Record<string, string> = {
	lite: "Lite",
	max: "Max",
	standard: "Standard",
};

const RYU_ALIAS_PATTERN = /^ryu-([a-z]+)\/([a-z]+)$/;

/**
 * Display name for a Ryu managed-tier model alias (`ryu-code/max` →
 * "Ryu Code Max"). Managed tiers are offered only under these aliases, which
 * the Gateway resolves; the supplier's own model id is never shown.
 */
export function ryuAliasModelName(id: string): string | null {
	const match = RYU_ALIAS_PATTERN.exec(id.toLowerCase());
	if (!match) {
		return null;
	}
	const tier = RYU_ALIAS_TIERS[match[1] ?? ""];
	const size = RYU_ALIAS_SIZES[match[2] ?? ""];
	return tier && size ? `Ryu ${tier} ${size}` : null;
}

/**
 * Give upstream router model ids a readable label while preserving any richer
 * name returned by live provider discovery.
 */
export function modelMenuItem(
	id: string,
	discoveredName?: string | null
): ComposerSettingItem {
	const metadata = ROUTER_MODEL_LABELS.get(id);
	const suppliedName = discoveredName?.trim();
	return {
		description: metadata?.description,
		id,
		name:
			suppliedName && suppliedName !== id
				? suppliedName
				: (metadata?.name ?? ryuAliasModelName(id) ?? id),
	};
}
