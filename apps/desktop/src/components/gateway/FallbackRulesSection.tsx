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

import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import { AgentSelectionField } from "@/components/agent-elements/input/agent-selection-field.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useSubscriptions } from "@/src/hooks/useSubscriptions.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { EMPTY_AGENT_SELECTION } from "@/src/lib/api/preferences.ts";
import type {
	RoutingCondition,
	RoutingPolicy,
	RoutingPolicyView,
	RoutingRule,
} from "@/src/lib/api/routing.ts";
import {
	fetchRoutingPolicy,
	saveRoutingPolicy,
} from "@/src/lib/api/routing.ts";
import {
	type SubscriptionsSnapshot,
	supportsUsage,
} from "@/src/lib/api/usage.ts";

/** A blank rule, defaulted to the case people reach for first. */
function newRule(id: string): RoutingRule {
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
interface ScopeOption {
	label: string;
	scope: SubscriptionScope;
	value: string;
}

/** A dropdown value that cannot collide across scope kinds or ids. */
function scopeValue(scope: SubscriptionScope): string {
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
function scopeOptions(
	subscriptionAgents: string[],
	snapshot: SubscriptionsSnapshot | undefined
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
			label: `${provider.label} — every account`,
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
function conditionForSource(
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
const WINDOW_OPTIONS: { value: string; label: string }[] = [
	{ value: "any", label: "Whichever bites first" },
	{ value: "session", label: "Session (5h)" },
	{ value: "weekly", label: "Weekly" },
];

const SOURCE_OPTIONS: { value: RoutingCondition["source"]; label: string }[] = [
	{ value: "ryu_credits", label: "Ryu credit runs low" },
	{ value: "provider_credits", label: "A provider key's credit runs low" },
	{ value: "subscription_window", label: "A subscription window runs low" },
];

function sourceLabel(source: RoutingCondition["source"]): string {
	if (source === "ryu_credits") {
		return "Ryu credit";
	}
	if (source === "provider_credits") {
		return "Provider credit";
	}
	return "Subscription window";
}

/** Keep number editing local until commit so an autosave can't interrupt typing. */
function ThresholdInput({
	disabled,
	id,
	inputMode,
	label,
	max,
	onCommit,
	value,
}: {
	disabled: boolean;
	id: string;
	inputMode: "decimal" | "numeric";
	label: string;
	max?: number;
	onCommit: (value: number) => void;
	value: number;
}) {
	const [draft, setDraft] = useState(String(value));
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		setDraft(String(value));
		setError(null);
	}, [value]);

	const commit = () => {
		const trimmed = draft.trim();
		const parsed = Number(trimmed);
		if (
			trimmed.length === 0 ||
			!Number.isFinite(parsed) ||
			parsed < 0 ||
			(max !== undefined && parsed > max)
		) {
			setError(
				max === undefined
					? "Enter a non-negative USD amount."
					: `Enter a percent from 0 to ${max}.`
			);
			return;
		}
		setError(null);
		if (parsed !== value) {
			onCommit(parsed);
		}
	};

	return (
		<SettingsItem
			actions={
				<div>
					<Input
						aria-describedby={error ? `${id}-error` : undefined}
						aria-invalid={error ? true : undefined}
						className="h-8 w-28"
						disabled={disabled}
						id={id}
						inputMode={inputMode}
						onBlur={commit}
						onChange={(event) => {
							setDraft(event.target.value);
							setError(null);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								event.currentTarget.blur();
							}
						}}
						value={draft}
					/>
				</div>
			}
			title={<label htmlFor={id}>{label}</label>}
		>
			{error ? (
				<p className="text-destructive text-xs" id={`${id}-error`} role="alert">
					{error}
				</p>
			) : null}
		</SettingsItem>
	);
}

/**
 * The threshold + its qualifiers, which differ per source. Returned as an array
 * of rows (not a wrapper component) so the rule's `SettingsGroup` draws its
 * hairlines between each of them.
 */
function conditionRows({
	condition,
	creditProviders,
	disabled,
	ruleId,
	onChange,
	scopes,
}: {
	condition: RoutingCondition;
	creditProviders: string[];
	disabled: boolean;
	ruleId: string;
	onChange: (next: RoutingCondition) => void;
	scopes: ScopeOption[];
}): ReactNode[] {
	if (condition.source === "ryu_credits") {
		return [
			<ThresholdInput
				disabled={disabled}
				id={`ryu-credit-threshold-${ruleId}`}
				inputMode="decimal"
				key="threshold"
				label="Dollars left, below"
				onCommit={(below_usd) => onChange({ ...condition, below_usd })}
				value={condition.below_usd}
			/>,
		];
	}

	if (condition.source === "provider_credits") {
		return [
			<SettingsItem
				actions={
					<Select
						disabled={disabled}
						items={creditProviders.map((id) => ({ label: id, value: id }))}
						onValueChange={(provider_id) =>
							onChange({ ...condition, provider_id: provider_id ?? "" })
						}
						value={condition.provider_id}
					>
						<SelectTrigger
							className="h-8 w-40"
							id={`credit-provider-${ruleId}`}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{creditProviders.map((id) => (
								<SelectItem key={id} value={id}>
									{id}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				}
				key="provider"
				title={<label htmlFor={`credit-provider-${ruleId}`}>Provider</label>}
			/>,
			<ThresholdInput
				disabled={disabled}
				id={`provider-credit-threshold-${ruleId}`}
				inputMode="decimal"
				key="threshold"
				label="Dollars left, below"
				onCommit={(below_usd) => onChange({ ...condition, below_usd })}
				value={condition.below_usd}
			/>,
		];
	}

	const currentScope = scopeValue(condition);
	// A saved scope that is no longer offered (an account was removed, or the
	// listing has not loaded) still shows by id instead of a blank trigger.
	const scopeItems = scopes.some((option) => option.value === currentScope)
		? scopes
		: [
				...scopes,
				{
					label:
						condition.account_id ?? condition.provider_id ?? condition.agent_id,
					scope: {
						agent_id: condition.agent_id,
						provider_id: condition.provider_id,
						account_id: condition.account_id,
					},
					value: currentScope,
				},
			];
	return [
		<SettingsItem
			actions={
				<Select
					disabled={disabled}
					items={scopeItems}
					onValueChange={(value) => {
						const picked = scopeItems.find((option) => option.value === value);
						if (!picked) {
							return;
						}
						// Rebuild the scope rather than spreading over it: a stale
						// `account_id` from a previous pick must not survive.
						const {
							agent_id: _agent,
							provider_id: _provider,
							account_id: _account,
							...rest
						} = condition;
						onChange({ ...rest, ...picked.scope });
					}}
					value={currentScope}
				>
					<SelectTrigger
						className="h-8 w-64"
						id={`subscription-agent-${ruleId}`}
					>
						<SelectValue placeholder="Pick a subscription" />
					</SelectTrigger>
					<SelectContent>
						{scopeItems.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			key="subscription"
			title={
				<label htmlFor={`subscription-agent-${ruleId}`}>Subscription</label>
			}
		/>,
		<SettingsItem
			actions={
				<Select
					disabled={disabled}
					items={WINDOW_OPTIONS}
					onValueChange={(window) =>
						onChange({
							...condition,
							window: !window || window === "any" ? "" : window,
						})
					}
					value={condition.window === "" ? "any" : condition.window}
				>
					<SelectTrigger
						className="h-8 w-40"
						id={`subscription-window-${ruleId}`}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{WINDOW_OPTIONS.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			key="window"
			title={<label htmlFor={`subscription-window-${ruleId}`}>Window</label>}
		/>,
		<ThresholdInput
			disabled={disabled}
			id={`window-threshold-${ruleId}`}
			inputMode="numeric"
			key="threshold"
			label="Percent left, below"
			max={100}
			onCommit={(remaining_below_percent) =>
				onChange({ ...condition, remaining_below_percent })
			}
			value={condition.remaining_below_percent}
		/>,
	];
}

function RuleCard({
	canConfigure,
	creditProviders,
	index,
	onChange,
	onMove,
	onRemove,
	rule,
	scopes,
	target,
	total,
}: {
	canConfigure: boolean;
	creditProviders: string[];
	index: number;
	onChange: (next: RoutingRule) => void;
	onMove: (delta: number) => void;
	onRemove: () => void;
	rule: RoutingRule;
	scopes: ScopeOption[];
	target: ApiTarget;
	total: number;
}) {
	const disabled = !canConfigure;
	return (
		<div data-testid={`fallback-rule-${rule.id}`}>
			<SettingsGroup>
				<SettingsItem
					actions={
						<div className="flex items-center gap-1">
							<Switch
								aria-label="Rule enabled"
								checked={rule.enabled}
								className="mr-1"
								disabled={disabled}
								onCheckedChange={(enabled) => onChange({ ...rule, enabled })}
							/>
							<Button
								aria-label="Move rule up"
								disabled={disabled || index === 0}
								onClick={() => onMove(-1)}
								size="icon"
								variant="ghost"
							>
								<HugeiconsIcon icon={ArrowUp01Icon} size={16} />
							</Button>
							<Button
								aria-label="Move rule down"
								disabled={disabled || index === total - 1}
								onClick={() => onMove(1)}
								size="icon"
								variant="ghost"
							>
								<HugeiconsIcon icon={ArrowDown01Icon} size={16} />
							</Button>
							<Button
								aria-label="Delete rule"
								disabled={disabled}
								onClick={onRemove}
								size="icon"
								variant="ghost"
							>
								<HugeiconsIcon icon={Delete01Icon} size={16} />
							</Button>
						</div>
					}
					title={sourceLabel(rule.when.source)}
				/>
				<SettingsItem
					actions={
						<Select<RoutingCondition["source"]>
							disabled={disabled}
							items={SOURCE_OPTIONS}
							onValueChange={(source) =>
								onChange({
									...rule,
									when: conditionForSource(
										source ?? "ryu_credits",
										scopes[0]?.scope ?? { agent_id: "" },
										creditProviders
									),
								})
							}
							value={rule.when.source}
						>
							<SelectTrigger
								className="h-8 w-56"
								id={`fallback-source-${rule.id}`}
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{SOURCE_OPTIONS.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title={<label htmlFor={`fallback-source-${rule.id}`}>When</label>}
				/>
				{conditionRows({
					condition: rule.when,
					creditProviders,
					disabled,
					onChange: (when) => onChange({ ...rule, when }),
					ruleId: rule.id,
					scopes,
				})}
				<SettingsItem
					actions={
						<AgentSelectionField
							ariaLabel="Fallback agent or model"
							disabled={disabled}
							onChange={(fallback) => onChange({ ...rule, fallback })}
							placeholder="Just warn me — don't change the model"
							target={target}
							value={rule.fallback}
						/>
					}
					title="Then run"
				/>
				<SettingsItem
					actions={
						<Switch
							aria-label="Notify when this rule fires"
							checked={rule.notify}
							disabled={disabled}
							onCheckedChange={(notify) => onChange({ ...rule, notify })}
						/>
					}
					title="Show a notice above the composer when this fires"
				/>
			</SettingsGroup>
		</div>
	);
}

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
	const scopes = scopeOptions(subscriptionAgents, subscriptions.data);

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
			caption="Checked before every turn, against cached balances. The first rule that matches wins, so order these from most specific to most general."
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
