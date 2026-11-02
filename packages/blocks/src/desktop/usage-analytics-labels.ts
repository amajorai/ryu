import { OWN_SUPPLY_POOLS } from "@ryu/auth/lib/credit-pools";
import type { UsageGranularity, UsageSource } from "./usage-analytics-types.ts";

export const GRANULARITY_LABELS = {
	"15m": "15 min",
	daily: "Daily",
	hourly: "Hourly",
	monthly: "Monthly",
	weekly: "Weekly",
} satisfies Record<UsageGranularity, string>;

export const SOURCE_LABELS = {
	byok: "BYOK",
	local: "Local",
	managed: "Managed credits",
	self_hosted: "Self-hosted",
	unknown: "Other",
} satisfies Record<UsageSource, string>;

/** Background purposes the Gateway attributes (`x-ryu-purpose` wire names). */
export const USAGE_PURPOSES = [
	"btw",
	"advisor",
	"compaction",
	"handoff",
	"auto_title",
	"chat_suggestions",
	"composer_prediction",
	"predict",
	"memory_dream",
	"recommendations",
	"learning_judge",
	"agent_auto_route",
	"workflow_prompt",
	"delegate",
	"app_model_stream",
	"retrieval_expansion",
] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

/**
 * Row key for calls without a purpose (your own chat and agent turns). The
 * parentheses are outside the Gateway's purpose grammar (`[a-z0-9_:.@/-]`),
 * so no tagged call can ever land in this row.
 */
export const FOREGROUND_PURPOSE_KEY = "(foreground)";

/** Prefix the Gateway uses for plugin-initiated background calls. */
export const PLUGIN_PURPOSE_PREFIX = "plugin:";

/**
 * English source literals for purpose rows. Render them through the i18n
 * literal boundary (`useLocalizedText(label, { literal: true })`), like the
 * rest of this dashboard's copy.
 */
export const PURPOSE_LABELS = {
	advisor: "Advisor",
	agent_auto_route: "Agent auto-route",
	app_model_stream: "App model calls",
	auto_title: "Chat titles",
	btw: "/btw side questions",
	chat_suggestions: "Chat suggestions",
	compaction: "Context compaction",
	composer_prediction: "Composer prediction",
	delegate: "Delegation",
	handoff: "Handoff summaries",
	learning_judge: "Learning judge",
	memory_dream: "Memory consolidation",
	predict: "Predictions",
	recommendations: "Recommendations",
	retrieval_expansion: "Search query expansion",
	workflow_prompt: "Workflow steps",
} satisfies Record<UsagePurpose, string>;

export const FOREGROUND_PURPOSE_LABEL = "Chat and agent turns";
export const PLUGIN_PURPOSE_LABEL = "Plugin";

function isUsagePurpose(key: string): key is UsagePurpose {
	return Object.hasOwn(PURPOSE_LABELS, key);
}

/** The plugin id of a `plugin:<id>` purpose, or `null` for any other key. */
export function pluginIdForPurpose(key: string): string | null {
	if (!key.startsWith(PLUGIN_PURPOSE_PREFIX)) {
		return null;
	}
	const pluginId = key.slice(PLUGIN_PURPOSE_PREFIX.length);
	return pluginId.length > 0 ? pluginId : null;
}

/**
 * The English label for a purpose row key. Unknown tags from newer Gateways
 * render verbatim rather than disappearing.
 */
export function usagePurposeLabel(key: string): string {
	if (key === FOREGROUND_PURPOSE_KEY) {
		return FOREGROUND_PURPOSE_LABEL;
	}
	if (isUsagePurpose(key)) {
		return PURPOSE_LABELS[key];
	}
	const pluginId = pluginIdForPurpose(key);
	return pluginId === null ? key : `${PLUGIN_PURPOSE_LABEL} · ${pluginId}`;
}

/** Whether a purpose row key has a first-party English label to localize. */
export function isLabelledPurposeKey(key: string): boolean {
	return key === FOREGROUND_PURPOSE_KEY || isUsagePurpose(key);
}

/** The one provider name a user reads for any Ryu-served work. */
export const RYU_ROUTER_LABEL = "Ryu Router";

/**
 * Gateway slots of Ryu's OWN supply, all shown as "Ryu Router": users pick
 * models from one provider and never see the supplier that served a request.
 * The OpenRouter pass-through is deliberately absent here, because usage
 * analytics also carries BYOK OpenRouter traffic; ledger surfaces, which only
 * ever carry managed traffic, use {@link ledgerProviderLabel}.
 */
export const POOL_PROVIDER_LABELS: Record<string, string> = {
	...Object.fromEntries(
		OWN_SUPPLY_POOLS.flatMap((pool) =>
			pool.gatewayProviders.map((provider) => [provider, RYU_ROUTER_LABEL])
		)
	),
	// The provider id the gateway reports for managed Ryu Router work.
	ryu: RYU_ROUTER_LABEL,
};

/** The user-facing name for a usage row's provider key. */
export function usageProviderLabel(key: string): string {
	return POOL_PROVIDER_LABELS[key] ?? key;
}

/**
 * The user-facing name for a credit-LEDGER row's provider. Every ledger debit
 * is managed (Ryu-billed) traffic, so the managed OpenRouter pass-through is
 * Ryu Router too; anything else falls back to {@link usageProviderLabel}.
 */
export function ledgerProviderLabel(key: string): string {
	return key === "openrouter" ? RYU_ROUTER_LABEL : usageProviderLabel(key);
}
