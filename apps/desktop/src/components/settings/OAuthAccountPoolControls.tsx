"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { sileo } from "sileo";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	fetchOAuthAccountPoolPolicy,
	type OAuthAccountPoolPolicy,
	type OAuthAccountStrategy,
	type PiAccount,
	type PiProvider,
	updateOAuthAccountPoolPolicy,
} from "@/src/lib/api/pi-config.ts";
import {
	fetchSubscriptionsSnapshot,
	hasReadableAccountWindows,
	subscriptionQueryKeys,
} from "@/src/lib/api/usage.ts";

const STRATEGIES: { label: string; value: OAuthAccountStrategy }[] = [
	{ label: "Manual", value: "manual" },
	{ label: "Round robin", value: "round_robin" },
	{ label: "Quota first", value: "quota_first" },
	{ label: "Fill first", value: "fill_first" },
	{ label: "Reset first", value: "reset_first" },
];

interface Props {
	accounts: PiAccount[];
	capabilities: NonNullable<PiProvider["accountRouting"]>;
	providerId: string;
}

export function OAuthAccountPoolControls(props: Props) {
	const target = toTarget(useActiveNode());
	// A draft and its pending writes belong to the full admission authority.
	// Equivalent target objects retain edits; changed credentials start fresh.
	const instance = useId();
	const sequence = useRef(0);
	const scope = useMemo(() => {
		sequence.current += 1;
		return `${instance}:${sequence.current}`;
	}, [instance, target.url, target.token, target.userJwt, props.providerId]);
	return (
		<ScopedOAuthAccountPoolControls
			key={scope}
			{...props}
			scope={scope}
			target={target}
		/>
	);
}

function ScopedOAuthAccountPoolControls({
	accounts,
	capabilities,
	providerId,
	target,
	scope,
}: Props & { target: ApiTarget; scope: string }) {
	const tl = useLiteralMessages();
	const strategies = STRATEGIES.filter((strategy) =>
		capabilities.strategies.includes(strategy.value)
	);
	const queryClient = useQueryClient();
	const queryKey = [
		"oauth-account-pool",
		target.url,
		providerId,
		scope,
	] as const;
	const query = useQuery({
		queryKey,
		queryFn: () => fetchOAuthAccountPoolPolicy(target, providerId),
	});
	const [draft, setDraft] = useState<OAuthAccountPoolPolicy | null>(null);
	const [saving, setSaving] = useState(false);
	const previousPolicy = useRef<OAuthAccountPoolPolicy | null>(null);
	const policyScope = scope;
	const pendingSave = useRef(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const previousScope = useRef(policyScope);
	// The subscriptions snapshot (usage page, picker rows) and the active-account
	// reading cache their own copies of per-account usage and pool state.
	const invalidateUsageViews = (node: ApiTarget, provider: string) => {
		queryClient
			.invalidateQueries({ queryKey: subscriptionQueryKeys.all(node) })
			.catch(() => undefined);
		queryClient
			.invalidateQueries({
				queryKey: subscriptionQueryKeys.reading(node, provider, null),
			})
			.catch(() => undefined);
	};
	const quotaRefresh = useMutation({
		mutationFn: async (request: {
			accountIds: string[];
			providerId: string;
			scope: string;
			target: ApiTarget;
		}) => {
			// One forced read of the provider: Core reads every account it can
			// (never one that needs a new sign-in or is off in the saved pool),
			// four at a time. The readings are seeded into the per-account cache
			// (badges, stats strip); the snapshot views (usage page, picker rows) and
			// the active-account bar are invalidated below so they refetch Core's
			// now-fresh cached readings.
			const snapshot = await fetchSubscriptionsSnapshot(request.target, {
				providerId: request.providerId,
				usage: "force",
			});
			const provider = snapshot.providers.find(
				(entry) => entry.providerId === request.providerId
			);
			let available = 0;
			for (const account of provider?.accounts ?? []) {
				if (!account.usage) {
					continue;
				}
				queryClient.setQueryData(
					subscriptionQueryKeys.reading(
						request.target,
						request.providerId,
						account.accountId
					),
					account.usage
				);
				if (
					request.accountIds.includes(account.accountId) &&
					hasReadableAccountWindows(account.usage)
				) {
					available += 1;
				}
			}
			invalidateUsageViews(request.target, request.providerId);
			return {
				available,
				checked: request.accountIds.length,
				scope: request.scope,
			};
		},
	});
	useEffect(() => {
		if (query.data) {
			const previous =
				previousScope.current === policyScope ? previousPolicy.current : null;
			const received = query.data;
			setDraft((current) =>
				current &&
				previous &&
				JSON.stringify(current) !== JSON.stringify(previous)
					? current
					: received
			);
			previousPolicy.current = received;
			previousScope.current = policyScope;
		}
	}, [query.data, policyScope]);

	if (query.isError) {
		return (
			<p className="text-detail text-status-destructive" role="alert">
				Could not load account routing.
			</p>
		);
	}
	if (query.isPending || !draft) {
		// Also while the policy has arrived but the effect above has not copied it
		// into the draft yet (first commit after the read, or a cached policy).
		return (
			<p className="text-detail text-muted-foreground">
				Loading account routing…
			</p>
		);
	}

	const updateAccount = (
		accountId: string,
		change: Partial<OAuthAccountPoolPolicy["accounts"][string]>
	) => {
		setDraft((current) => {
			if (!current) {
				return current;
			}
			return {
				...current,
				accounts: {
					...current.accounts,
					[accountId]: {
						...current.accounts[accountId],
						enabled: current.accounts[accountId]?.enabled ?? true,
						priority: current.accounts[accountId]?.priority ?? 0,
						...change,
					},
				},
			};
		});
	};
	const valid =
		Number.isInteger(draft.drainThresholdPercent) &&
		draft.drainThresholdPercent >= 1 &&
		draft.drainThresholdPercent <= 100 &&
		Object.values(draft.accounts).every(
			(rule) =>
				Number.isInteger(rule.priority) &&
				rule.priority >= 0 &&
				rule.priority <= 100 &&
				(rule.drainThresholdPercent == null ||
					(capabilities.quotaObservations &&
						Number.isInteger(rule.drainThresholdPercent) &&
						rule.drainThresholdPercent >= 0 &&
						rule.drainThresholdPercent <= 100))
		);
	const changed = JSON.stringify(draft) !== JSON.stringify(query.data);
	const save = async () => {
		if (!valid || pendingSave.current) {
			return;
		}
		pendingSave.current = true;
		setSaving(true);
		try {
			const saved = await updateOAuthAccountPoolPolicy(
				target,
				providerId,
				draft
			);
			queryClient.setQueryData(queryKey, saved);
			// Enabled/disabled accounts and priorities show in the snapshot views.
			invalidateUsageViews(target, providerId);
			if (mounted.current) {
				setDraft(saved);
				sileo.success({ title: "Account routing saved" });
			}
		} catch (error) {
			if (!mounted.current) {
				return;
			}
			sileo.error({
				title: "Could not save account routing",
				description:
					error instanceof Error ? error.message : "Core rejected the policy.",
			});
		} finally {
			pendingSave.current = false;
			if (mounted.current) {
				setSaving(false);
			}
		}
	};

	return (
		<fieldset
			className="min-w-0 space-y-3 border-border border-t pt-3"
			disabled={saving}
		>
			<div>
				<h4 className="font-medium text-sm">Account routing</h4>
				<p className="text-detail text-muted-foreground">
					Applies to new conversations. Healthy conversations keep their account
					for prompt caching.{" "}
					{capabilities.quotaObservations
						? "Unknown quota falls back to rotation."
						: "Quota observations are unavailable."}
					{!capabilities.quotaObservations &&
					capabilities.strategies.includes("fill_first")
						? " Fill first keeps the first eligible account until availability or priority changes."
						: null}
				</p>
			</div>
			{capabilities.quotaObservations ? (
				<div className="space-y-1.5">
					<Button
						disabled={quotaRefresh.isPending || accounts.length === 0}
						onClick={() =>
							quotaRefresh.mutate({
								accountIds: accounts
									.filter(
										(account) =>
											account.kind === "oauth" &&
											!account.needsReauth &&
											draft.accounts[account.accountId]?.enabled !== false
									)
									.map((account) => account.accountId),
								providerId,
								scope: policyScope,
								target,
							})
						}
						size="sm"
						variant="outline"
					>
						{quotaRefresh.isPending ? "Refreshing quota…" : "Refresh quota"}
					</Button>
					<p aria-live="polite" className="text-detail text-muted-foreground">
						{quotaRefresh.data?.scope === policyScope
							? `Account-wide usage returned for ${quotaRefresh.data.available} of ${quotaRefresh.data.checked} accounts. Missing readings remain unknown.`
							: "Reads each enabled account separately. Quota readings expire after five minutes."}
					</p>
					{quotaRefresh.isError ? (
						<p className="text-detail text-status-destructive" role="alert">
							Could not refresh account quota. Existing logins are unchanged.
						</p>
					) : null}
				</div>
			) : null}
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor={`oauth-strategy-${providerId}`}>Strategy</Label>
					<Select
						onValueChange={(value) => {
							const strategy = strategies.find(
								(option) => option.value === value
							)?.value;
							if (!strategy) {
								return;
							}
							setDraft((current) =>
								current ? { ...current, strategy } : current
							);
						}}
						value={draft.strategy}
					>
						<SelectTrigger id={`oauth-strategy-${providerId}`}>
							<SelectValue>
								{
									strategies.find(
										(strategy) => strategy.value === draft.strategy
									)?.label
								}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{strategies.map((strategy) => (
								<SelectItem key={strategy.value} value={strategy.value}>
									{strategy.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				{draft.strategy === "fill_first" && capabilities.quotaObservations ? (
					<div className="space-y-1.5">
						<Label htmlFor={`oauth-drain-${providerId}`}>
							Drain at usage (%)
						</Label>
						<Input
							id={`oauth-drain-${providerId}`}
							max={100}
							min={1}
							onChange={(event) =>
								setDraft((current) =>
									current
										? {
												...current,
												drainThresholdPercent: Number(event.target.value),
											}
										: current
								)
							}
							type="number"
							value={draft.drainThresholdPercent}
						/>
					</div>
				) : null}
			</div>
			{accounts.length > 0 ? (
				<div>
					<p className="font-medium text-sm">Accounts</p>
					{accounts.map((account) => {
						const rule = draft.accounts[account.accountId] ?? {
							enabled: true,
							priority: 0,
						};
						const names = { label: account.label, provider: providerId };
						return (
							<div
								className="flex flex-wrap items-center gap-2 border-border border-b py-2 last:border-b-0"
								key={account.accountId}
							>
								<span
									className="min-w-24 flex-1 truncate text-sm"
									title={account.label}
								>
									{account.label}
								</span>
								<Label
									htmlFor={`oauth-enabled-${account.accountId}`}
									id={`oauth-enabled-label-${account.accountId}`}
									size="compact"
								>
									Use
									<span className="sr-only">
										{" "}
										{tl("{label} for {provider}", names)}
									</span>
								</Label>
								<Switch
									aria-labelledby={`oauth-enabled-label-${account.accountId}`}
									checked={rule.enabled}
									id={`oauth-enabled-${account.accountId}`}
									onCheckedChange={(enabled) =>
										updateAccount(account.accountId, { enabled })
									}
								/>
								<Label
									htmlFor={`oauth-priority-${account.accountId}`}
									size="compact"
								>
									Priority
								</Label>
								<Input
									aria-label={tl("Priority for {label} on {provider}", names)}
									className="w-16"
									id={`oauth-priority-${account.accountId}`}
									max={100}
									min={0}
									onChange={(event) =>
										updateAccount(account.accountId, {
											priority: Number(event.target.value),
										})
									}
									type="number"
									value={rule.priority}
								/>
								{capabilities.quotaObservations ? (
									<div className="space-y-1">
										<Label
											htmlFor={`oauth-account-drain-${account.accountId}`}
											size="compact"
										>
											Drain override (%)
										</Label>
										<Input
											aria-label={`Drain override for ${account.label} on ${providerId}`}
											className="w-36"
											disabled={saving}
											id={`oauth-account-drain-${account.accountId}`}
											max={100}
											min={0}
											onChange={(event) =>
												updateAccount(account.accountId, {
													drainThresholdPercent:
														event.target.value === ""
															? null
															: Number(event.target.value),
												})
											}
											placeholder="Provider default"
											step={1}
											type="number"
											value={rule.drainThresholdPercent ?? ""}
										/>
									</div>
								) : null}
							</div>
						);
					})}
					<p className="mt-2 text-detail text-muted-foreground">
						Lower priority numbers are tried first.
						{capabilities.quotaObservations
							? " Blank inherits the provider drain point; 0 disables proactive drain. Fully exhausted accounts remain unavailable."
							: null}
					</p>
				</div>
			) : null}
			<div className="flex justify-end">
				<Button
					disabled={!(changed && valid) || saving}
					onClick={save}
					size="sm"
					variant="outline"
				>
					{saving ? "Saving…" : "Save routing"}
				</Button>
			</div>
		</fieldset>
	);
}
