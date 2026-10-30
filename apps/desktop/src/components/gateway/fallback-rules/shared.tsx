import type { LiteralMessage } from "@ryu/i18n/react";
import { EMPTY_AGENT_SELECTION } from "@/src/lib/api/preferences.ts";
import type { RoutingCondition, RoutingRule } from "@/src/lib/api/routing.ts";
import type { SubscriptionsSnapshot } from "@/src/lib/api/usage.ts";

/** A blank rule, defaulted to the case people reach for first. */
export function newRule(id: string): RoutingRule {
	return {
		id,
		enabled: true,
		when: { source: "ryu_credits", below_usd: 5 },
		// Copied, not shared: `EMPTY_AGENT_SELECTION` is a module constant, and
		// handing every new rule the same object is one careless in-place edit away
		// from rewriting every rule's default.
		fallback: { ...EMPTY_AGENT_SELECTION },
		applies_to_agents: [],
		notify: true,
	};
}

/**
 * What a subscription-window rule watches: one agent's own login, a Ryu
 * provider's whole account pool, or one saved account of that provider. Core
 * accepts exactly one of `agent_id` / `provider_id`.
 */
interface SubscriptionScope {
	account_id?: string;
	agent_id: string;
	provider_id?: string;
}

/** One entry of the "Subscription" dropdown. */
export interface ScopeOption {
	label: string;
	scope: SubscriptionScope;
	value: string;
}

/** A dropdown value that cannot collide across scope kinds or ids. */
export function scopeValue(scope: SubscriptionScope): string {
	if (scope.provider_id) {
		return scope.account_id
			? `account:${encodeURIComponent(scope.provider_id)}:${encodeURIComponent(scope.account_id)}`
			: `provider:${encodeURIComponent(scope.provider_id)}`;
	}
	return `agent:${encodeURIComponent(scope.agent_id)}`;
}

/**
 * Agents with a readable login, then each Ryu subscription provider whose
 * accounts Core can read: its whole pool, then each saved account by name.
 * Account names are display-only; the rule stores ids.
 */
export function scopeOptions(
	subscriptionAgents: string[],
	snapshot: SubscriptionsSnapshot | undefined,
	tl: LiteralMessage
): ScopeOption[] {
	const options: ScopeOption[] = subscriptionAgents.map((agentId) => ({
		label: agentId,
		scope: { agent_id: agentId },
		value: scopeValue({ agent_id: agentId }),
	}));
	for (const provider of snapshot?.providers ?? []) {
		if (
			provider.kind !== "subscription" ||
			!provider.capabilities.accountUsage ||
			provider.accounts.length === 0
		) {
			continue;
		}
		const pool = { agent_id: "", provider_id: provider.providerId };
		options.push({
			label: tl("{label} — every account", { label: provider.label }),
			scope: pool,
			value: scopeValue(pool),
		});
		for (const account of provider.accounts) {
			const single = { ...pool, account_id: account.accountId };
			options.push({
				label: `${provider.label} — ${account.label ?? account.accountId}`,
				scope: single,
				value: scopeValue(single),
			});
		}
	}
	return options;
}

/** Swap the condition's source, seeding sensible defaults for the new unit. */
export function conditionForSource(
	source: RoutingCondition["source"],
	defaultScope: SubscriptionScope,
	creditProviders: string[]
): RoutingCondition {
	if (source === "ryu_credits") {
		return { source, below_usd: 5 };
	}
	if (source === "provider_credits") {
		return { source, provider_id: creditProviders[0] ?? "", below_usd: 5 };
	}
	return {
		source,
		...defaultScope,
		window: "",
		remaining_below_percent: 50,
	};
}

// Option lists live next to the form, not inline in the dropdown, because the
// closed trigger resolves its text through the Select's `items` prop: split the
// two and the trigger goes back to printing "subscription_window".
//
// "any" is the stored empty string — "whichever window is most consumed" is the
// honest default, since vendors name and count their windows differently and a
// rule matching nothing looks broken.
export const WINDOW_OPTIONS: { value: string; label: string }[] = [
	{ value: "any", label: "Whichever bites first" },
	{ value: "session", label: "Session (5h)" },
	{ value: "weekly", label: "Weekly" },
];

export const SOURCE_OPTIONS: {
	value: RoutingCondition["source"];
	label: string;
}[] = [
	{ value: "ryu_credits", label: "Ryu credit runs low" },
	{ value: "provider_credits", label: "A provider key's credit runs low" },
	{ value: "subscription_window", label: "A subscription window runs low" },
];

export function sourceLabel(source: RoutingCondition["source"]): string {
	if (source === "ryu_credits") {
		return "Ryu credit";
	}
	if (source === "provider_credits") {
		return "Provider credit";
	}
	return "Subscription window";
}
