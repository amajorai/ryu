// The node's threshold model fallback rules — "when I'm nearly out of X, run Y
// instead, and tell me you did it".
//
// Lives in the Gateway (node) settings dialog next to the other routing cards,
// NOT in an apps-store app's own settings tab. An app-registered tab inherits
// the app's enablement, so disabling the app would either keep rewriting turns
// with no UI left to explain why, or quietly stop enforcing rules the user still
// believes are on. Both are silent loss of control over which model answers.
// Kernel-owned with an empty default rule list is exactly today's behaviour
// until somebody writes a rule.
//
// The three sources are NOT interchangeable and the form says so, because they
// do not report the same kind of number:
//
//   Ryu credit        -> dollars left in the org's prepaid wallet
//   Provider credit   -> dollars left on a BYO key (only the few vendors that
//                        expose a balance to an inference key)
//   Subscription      -> percent left of a rolling rate-limit window
//
// Picking the source swaps the threshold field with it, so "Claude subscription
// below $5" — a rule that could never evaluate — is unrepresentable here rather
// than merely discouraged.

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { sileo } from "sileo";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useSubscriptions } from "@/src/hooks/useSubscriptions.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	RoutingPolicy,
	RoutingPolicyView,
	RoutingRule,
} from "@/src/lib/api/routing.ts";
import {
	fetchRoutingPolicy,
	saveRoutingPolicy,
} from "@/src/lib/api/routing.ts";
import { supportsUsage } from "@/src/lib/api/usage.ts";
import { RuleCard } from "./fallback-rules/rule-card.tsx";
import { newRule, scopeOptions } from "./fallback-rules/shared.tsx";

/**
 * The rules card for the Gateway dialog's "Model routing" section.
 *
 * Order is meaningful and preserved verbatim: Core stops at the FIRST rule that
 * fires, so the arrows are the user's priority statement, not decoration.
 */
export function FallbackRulesSection({
	canConfigure,
	target,
}: {
	canConfigure: boolean;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const { agents } = useAgents();
	// Only agents whose subscription windows Core can actually read can back a
	// percent rule — the same gate the usage bar uses, so the two never disagree
	// about which agents have a readable plan.
	const subscriptionAgents = agents
		.map((a) => a.id)
		.filter((id) => supportsUsage(id));
	// Ryu subscription providers and their saved accounts, from Core's listing
	// (no usage read): only providers whose accounts Core can read are offered.
	const subscriptions = useSubscriptions({ target, usage: "none" });
	const scopes = scopeOptions(subscriptionAgents, subscriptions.data, tl);

	const policyQuery = useQuery({
		queryKey: ["routing-policy", target.url],
		queryFn: () => fetchRoutingPolicy(target),
		refetchOnWindowFocus: false,
	});

	const save = useMutation({
		mutationFn: (policy: RoutingPolicy) => saveRoutingPolicy(target, policy),
		onSuccess: (_data, policy) => {
			// Merge, don't replace: the cached value also carries `credit_providers`
			// (served by Core, not something a save round-trips), and overwriting it
			// with the bare policy would empty the provider dropdown until refetch.
			queryClient.setQueryData<RoutingPolicyView>(
				["routing-policy", target.url],
				(prev) =>
					prev
						? { ...prev, rules: policy.rules }
						: { rules: policy.rules, credit_providers: [] }
			);
			// The verdict the composer shows is derived from these rules, so a save
			// has to drop it or the bar keeps describing the old configuration.
			queryClient.invalidateQueries({ queryKey: ["routing-advice"] });
		},
		onError: (error: Error) => {
			sileo.error({
				title: "Could not save fallback rules",
				description: error.message,
			});
		},
	});

	const rules = policyQuery.data?.rules ?? [];
	// Which providers a credit rule may name — served by Core, which owns the
	// balance readers, so this form can never offer a provider whose balance
	// cannot actually be read.
	const creditProviders = policyQuery.data?.credit_providers ?? [];
	const commit = useCallback(
		(next: RoutingRule[]) => save.mutate({ rules: next }),
		[save]
	);

	const addRule = () => {
		// A rule id only has to be stable and unique within the list; it is what
		// the composer notice cites and what the reorder keys off.
		const id = `rule-${Date.now().toString(36)}`;
		commit([...rules, newRule(id)]);
	};

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Checked before every turn, against cached balances. The first rule that matches wins, so order these from most specific to most general."
					}
				>
					{"Checked before every turn. The first matching rule wins."}
				</CaptionInfo>
			}
			headerAction={
				<Button
					disabled={!canConfigure || save.isPending}
					onClick={addRule}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon icon={Add01Icon} size={16} />
					Add rule
				</Button>
			}
			title="Fallback when you're running low"
		>
			{policyQuery.isLoading ? (
				<SettingsCard>
					<SkeletonRows />
				</SettingsCard>
			) : null}
			{!policyQuery.isLoading && rules.length === 0 ? (
				<SettingsCard>
					<p className="text-muted-foreground text-sm">
						No rules yet. Add one to drop to a cheaper model when your Ryu
						credit, a provider key's balance, or a subscription window runs low,
						instead of finding out when a turn fails.
					</p>
				</SettingsCard>
			) : null}
			<div className="space-y-3">
				{rules.map((rule, index) => (
					<RuleCard
						canConfigure={canConfigure && !save.isPending}
						creditProviders={creditProviders}
						index={index}
						key={rule.id}
						onChange={(next) =>
							commit(rules.map((r) => (r.id === rule.id ? next : r)))
						}
						onMove={(delta) => {
							const to = index + delta;
							if (to < 0 || to >= rules.length) {
								return;
							}
							const next = [...rules];
							const [moved] = next.splice(index, 1);
							next.splice(to, 0, moved);
							commit(next);
						}}
						onRemove={() => commit(rules.filter((r) => r.id !== rule.id))}
						rule={rule}
						scopes={scopes}
						target={target}
						total={rules.length}
					/>
				))}
			</div>
		</SettingsSection>
	);
}
