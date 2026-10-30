"use client";

import {
	projectPeriodTotal,
	utcMonthBounds,
} from "@ryu/blocks/desktop/usage-forecast.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { formatCount, formatCurrency } from "@ryu/ui/lib/number-format.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { useSubscriptionCostUsage } from "@/src/hooks/useSubscriptionCostUsage.ts";
import type { SubscriptionUsageAccount } from "@/src/hooks/useSubscriptionUsage.ts";
import type { SubscriptionCostUsageSummary } from "@/src/lib/api/subscription-costs.ts";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";

function formatEstimate(costMicroUsd: number | null): string {
	if (costMicroUsd === null) {
		return "Unpriced";
	}
	return formatCurrency(costMicroUsd / 1_000_000, "USD", {
		maximumFractionDigits: 6,
		minimumFractionDigits: 2,
	});
}

function formatProjection(costMicroUsd: number | null): string | null {
	return costMicroUsd === null
		? null
		: formatCurrency(costMicroUsd / 1_000_000, "USD", {
				maximumFractionDigits: 2,
				minimumFractionDigits: 2,
			});
}

export function SubscriptionCostBreakdown({
	accounts,
	error,
	loading,
	onRetry,
	onSetTracking,
	trackingError,
	trackingUpdating,
	usage,
}: {
	accounts: SubscriptionUsageAccount[];
	error?: string | null;
	loading: boolean;
	onRetry?: () => void;
	onSetTracking?: ReturnType<
		typeof useSubscriptionCostUsage
	>["setTrackingEnabled"];
	trackingError?: string | null;
	trackingUpdating?: boolean;
	usage: SubscriptionCostUsageSummary | null;
}) {
	const tl = useLiteralMessages();
	const providerLabels = new Map<string, string>();
	const accountLabels = new Map<string, string>();
	for (const account of accounts) {
		providerLabels.set(account.providerId, account.category);
		accountLabels.set(
			`${account.providerId}\u0000${account.accountId}`,
			account.accountLabel
		);
	}
	const groups = new Map<string, SubscriptionCostUsageSummary["accounts"]>();
	let overallCost: number | null = null;
	for (const account of usage?.accounts ?? []) {
		const group = groups.get(account.providerId) ?? [];
		group.push(account);
		groups.set(account.providerId, group);
		if (account.estimatedCostMicroUsd !== null) {
			overallCost = (overallCost ?? 0) + account.estimatedCostMicroUsd;
		}
	}
	const month = utcMonthBounds(usage?.month);
	const now = Date.now();
	const monthEnd = (costMicroUsd: number | null) =>
		formatProjection(
			costMicroUsd === null
				? null
				: projectPeriodTotal(costMicroUsd, month.start, month.end, now)
		);
	const overallMonthEnd = monthEnd(overallCost);
	const overallPartial = (usage?.accounts ?? []).some(
		(account) =>
			account.unpricedInputTokens > 0 ||
			account.unpricedOutputTokens > 0 ||
			account.missingInputTurns > 0 ||
			account.missingOutputTurns > 0
	);

	return (
		<div data-testid="subscription-cost-usage">
			<SettingsSection title="API-equivalent usage">
				{error ? (
					<SettingsGroup>
						<SettingsItem
							actions={
								onRetry ? (
									<Button onClick={onRetry} size="sm" variant="outline">
										Retry
									</Button>
								) : null
							}
							title={
								<span
									className="text-status-destructive"
									data-testid="subscription-cost-usage-error"
									title={error}
								>
									{"Couldn't load API-equivalent usage."}
								</span>
							}
						/>
					</SettingsGroup>
				) : null}
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Track API-equivalent subscription usage"
								checked={usage?.enabled ?? false}
								disabled={
									loading ||
									trackingUpdating ||
									!onSetTracking ||
									Boolean(error)
								}
								onCheckedChange={(enabled) => {
									const pending = onSetTracking?.(enabled);
									if (pending) {
										void pending.catch(() => undefined);
									}
								}}
							/>
						}
						description="Core stores only model/account IDs and reported token counts on this node. Prompts and credentials are never included. Estimates start after you turn tracking on. Past estimates can change when models.dev updates its prices; cached-input discounts and subscription allowances are not inferred. Turning tracking off keeps already-recorded estimates for this month visible. Month-end figures extend the month-to-date pace, so they read low when tracking started after the 1st."
						title="Track estimates"
					/>
					<SettingsItem
						actions={
							<div className="text-right">
								<div
									className="font-medium text-sm tabular-nums"
									data-testid="subscription-cost-total"
								>
									{usage && usage.accounts.length > 0
										? formatEstimate(overallCost)
										: "—"}
								</div>
								{usage && usage.accounts.length > 0 && overallMonthEnd ? (
									<div
										className="text-muted-foreground text-xs tabular-nums"
										data-testid="subscription-cost-month-end"
									>
										{tl("Month-end ≈ {overallMonthEnd}", { overallMonthEnd })}
									</div>
								) : null}
							</div>
						}
						description={tl(
							"Month to date ({month}) · estimated at models.dev list prices, not provider billing.",
							{ month: usage?.month ?? "UTC" }
						)}
						title={
							overallPartial
								? tl("Total estimate · partial")
								: tl("Total estimate")
						}
					/>
				</SettingsGroup>
				{trackingError ? (
					<p className="px-3 text-destructive text-xs" role="alert">
						{trackingError}
					</p>
				) : null}
				{loading && !usage ? (
					<SettingsCard>
						<SkeletonRows label="Loading monthly API-equivalent usage…" />
					</SettingsCard>
				) : groups.size > 0 ? (
					<div className="flex flex-col gap-3">
						{[...groups.entries()].map(([providerId, providerAccounts]) => {
							const knownCost = providerAccounts.reduce<number | null>(
								(total, account) =>
									account.estimatedCostMicroUsd === null
										? total
										: (total ?? 0) + account.estimatedCostMicroUsd,
								null
							);
							const partial = providerAccounts.some(
								(account) =>
									account.unpricedInputTokens > 0 ||
									account.unpricedOutputTokens > 0 ||
									account.missingInputTurns > 0 ||
									account.missingOutputTurns > 0
							);
							const providerLabel =
								providerLabels.get(providerId) ?? providerId;
							const providerMonthEnd = monthEnd(knownCost);
							return (
								<div
									data-testid={`subscription-cost-provider-${providerId}`}
									key={providerId}
								>
									<SettingsGroup>
										<SettingsItem
											actions={
												<div className="text-right">
													<div className="text-muted-foreground text-xs">
														{partial
															? tl("API equivalent · partial")
															: tl("API equivalent")}
													</div>
													<div
														className="font-medium text-sm tabular-nums"
														data-testid={`subscription-cost-provider-total-${providerId}`}
													>
														{formatEstimate(knownCost)}
													</div>
													{providerMonthEnd ? (
														<div className="text-muted-foreground text-xs tabular-nums">
															{tl("Month-end ≈ {providerMonthEnd}", {
																providerMonthEnd,
															})}
														</div>
													) : null}
												</div>
											}
											title={
												<span className="flex min-w-0 items-center gap-2">
													<ProviderBrandLogo
														providerKey={`${providerId} ${providerLabel}`}
														size={20}
													/>
													<span
														className="truncate font-medium"
														title={providerLabel}
													>
														{providerLabel}
													</span>
												</span>
											}
										/>
										{providerAccounts.map((account) => {
											const accountLabel =
												accountLabels.get(
													`${providerId}\u0000${account.accountId}`
												) ??
												tl("Former account · {accountId}", {
													accountId: account.accountId.slice(-6),
												});
											const accountMonthEnd = monthEnd(
												account.estimatedCostMicroUsd
											);
											const accountPartial =
												account.unpricedInputTokens > 0 ||
												account.unpricedOutputTokens > 0 ||
												account.missingInputTurns > 0 ||
												account.missingOutputTurns > 0;
											return (
												<div
													className="flex flex-col gap-1 px-3 py-2"
													data-testid={`subscription-cost-account-${providerId}-${account.accountId}`}
													key={account.accountId}
												>
													<div className="flex items-center justify-between gap-3 text-sm">
														<span
															className="min-w-0 truncate"
															title={accountLabel}
														>
															{accountLabel}
														</span>
														<span className="shrink-0 tabular-nums">
															{formatEstimate(account.estimatedCostMicroUsd)}
															{accountPartial ? " · partial" : ""}
														</span>
													</div>
													<div className="text-muted-foreground text-xs">
														{accountMonthEnd
															? tl(
																	"{input} input · {output} output tokens · ≈ {accountMonthEnd} by month end",
																	{
																		accountMonthEnd,
																		input:
																			formatCount(account.inputTokens) ?? "0",
																		output:
																			formatCount(account.outputTokens) ?? "0",
																	}
																)
															: tl("{input} input · {output} output tokens", {
																	input:
																		formatCount(account.inputTokens) ?? "0",
																	output:
																		formatCount(account.outputTokens) ?? "0",
																})}
													</div>
													{account.unpricedInputTokens +
														account.unpricedOutputTokens >
													0 ? (
														<p className="text-muted-foreground text-xs">
															{tl("{count} tokens have no models.dev price.", {
																count:
																	formatCount(
																		account.unpricedInputTokens +
																			account.unpricedOutputTokens
																	) ?? "",
															})}
														</p>
													) : null}
													{account.missingInputTurns +
														account.missingOutputTurns >
													0 ? (
														<p className="text-muted-foreground text-xs">
															Some provider turns did not report both token
															directions.
														</p>
													) : null}
												</div>
											);
										})}
									</SettingsGroup>
								</div>
							);
						})}
					</div>
				) : (
					<SettingsCard className="text-center text-muted-foreground text-sm">
						{usage?.enabled
							? "No completed managed Pi turns with reported token usage this month yet."
							: "Tracking is off by default. Turn it on to estimate the API list-price equivalent of future managed Pi turns."}
					</SettingsCard>
				)}
			</SettingsSection>
		</div>
	);
}
