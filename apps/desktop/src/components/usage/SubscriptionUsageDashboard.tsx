"use client";

import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	CaptionInfo,
	StatGrid,
	StatTile,
} from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { useSubscriptionCostUsage } from "@/src/hooks/useSubscriptionCostUsage.ts";
import type { SubscriptionUsageAccount } from "@/src/hooks/useSubscriptionUsage.ts";
import type { SubscriptionCostUsageSummary } from "@/src/lib/api/subscription-costs.ts";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";
import { forecastQuotaPool } from "./quota-forecast.ts";
import {
	AccountRow,
	usedPercent,
} from "./SubscriptionUsageDashboard-account-row.tsx";
import { SubscriptionCostBreakdown } from "./SubscriptionUsageDashboard-cost-breakdown.tsx";

function ProviderMark({ account }: { account: SubscriptionUsageAccount }) {
	const logo = (
		<ProviderBrandLogo
			providerKey={`${account.providerId} ${account.providerLabel}`}
			size={20}
		/>
	);
	return (
		<span className="flex size-5 shrink-0 items-center justify-center">
			{logo ?? (
				<span className="flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs uppercase">
					{account.category.slice(0, 1)}
				</span>
			)}
		</span>
	);
}

function hasPoolForecast(
	accounts: SubscriptionUsageAccount[],
	now: number
): boolean {
	const pool = forecastQuotaPool(accounts, now);
	return pool.remainingNow !== null && pool.remainingAtReset !== null;
}

function PoolForecast({
	accounts,
	now,
}: {
	accounts: SubscriptionUsageAccount[];
	now: number;
}) {
	const tl = useLiteralMessages();
	const pool = forecastQuotaPool(accounts, now);
	if (pool.remainingNow === null || pool.remainingAtReset === null) {
		return null;
	}
	return (
		<div
			className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-xs"
			data-testid="subscription-usage-pool-forecast"
		>
			<span className="text-muted-foreground">
				{tl(
					"Pooled headroom across {count, plural, one {# account} other {# accounts}}",
					{ count: pool.forecastable }
				)}
			</span>
			<span className="tabular-nums">
				{tl("{now}% now → ~{atReset}% at reset", {
					atReset: Math.round(pool.remainingAtReset),
					now: Math.round(pool.remainingNow),
				})}
			</span>
			<span
				className={
					pool.atRisk > 0 ? "text-status-warning" : "text-muted-foreground"
				}
			>
				{pool.atRisk > 0
					? tl("{atRisk} on pace to hit a limit", { atRisk: pool.atRisk })
					: "All on pace to last until reset"}
			</span>
		</div>
	);
}

function needsAttention(account: SubscriptionUsageAccount): boolean {
	if (account.error) {
		return true;
	}
	if (account.loading && !account.snapshot) {
		return false;
	}
	if (!account.snapshot?.available) {
		return true;
	}
	return account.snapshot.windows.some((window) => usedPercent(window) >= 80);
}

export function SubscriptionUsageDashboard({
	accounts,
	catalogError,
	catalogLoading,
	costUsage = null,
	costUsageError,
	costUsageLoading = false,
	onRefresh,
	onSetCostTracking,
	costTrackingError,
	costTrackingUpdating = false,
	refreshing = false,
}: {
	accounts: SubscriptionUsageAccount[];
	catalogError?: string | null;
	catalogLoading: boolean;
	costUsage?: SubscriptionCostUsageSummary | null;
	costUsageError?: string | null;
	costUsageLoading?: boolean;
	onRefresh?: () => void;
	onSetCostTracking?: ReturnType<
		typeof useSubscriptionCostUsage
	>["setTrackingEnabled"];
	costTrackingError?: string | null;
	costTrackingUpdating?: boolean;
	refreshing?: boolean;
}) {
	const tl = useLiteralMessages();
	const groups = new Map<string, SubscriptionUsageAccount[]>();
	for (const account of accounts) {
		const group = groups.get(account.providerId) ?? [];
		group.push(account);
		groups.set(account.providerId, group);
	}
	const liveCount = accounts.filter(
		(account) => account.snapshot?.available
	).length;
	const attentionCount = accounts.filter(needsAttention).length;
	const firstAccount = accounts[0];
	const now = Date.now();
	const pool = forecastQuotaPool(accounts, now);

	return (
		<section
			aria-label="Subscription usage"
			className="flex flex-col gap-8 [&>*]:mt-0"
			data-testid="subscription-usage-dashboard"
		>
			<SettingsSection
				caption={
					<CaptionInfo detail={"Each account is checked independently."}>
						{
							"Provider-reported limits for each subscription account on this node."
						}
					</CaptionInfo>
				}
				headerAction={
					onRefresh ? (
						<Button
							disabled={refreshing}
							onClick={onRefresh}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
							Refresh accounts
						</Button>
					) : null
				}
				title="Subscription usage"
			>
				{catalogError ? (
					<SettingsGroup>
						<SettingsItem
							actions={
								onRefresh ? (
									<Button onClick={onRefresh} size="sm" variant="outline">
										Retry
									</Button>
								) : null
							}
							title={
								<span
									className="text-status-destructive"
									data-testid="subscription-usage-error"
									title={catalogError}
								>
									{"Couldn't load connected subscription accounts."}
								</span>
							}
						/>
					</SettingsGroup>
				) : null}

				{catalogLoading && accounts.length === 0 ? (
					<SkeletonRows label="Loading connected subscription accounts…" />
				) : accounts.length === 0 ? (
					<p
						className="py-3 text-muted-foreground text-sm"
						data-testid="subscription-usage-empty"
					>
						Sign in to a provider in Gateway → AI providers to see its plan
						limits here.
					</p>
				) : (
					<StatGrid className="py-3">
						<StatTile label="Accounts" value={String(accounts.length)} />
						<StatTile label="Live now" value={String(liveCount)} />
						<StatTile label="Needs attention" value={String(attentionCount)} />
						<StatTile
							label="On pace to hit limit"
							value={
								pool.forecastable > 0
									? `${pool.atRisk} of ${pool.forecastable}`
									: "—"
							}
						/>
					</StatGrid>
				)}
			</SettingsSection>

			{groups.size > 0 ? (
				<SettingsSection title="Connected accounts">
					<div className="flex flex-col gap-6">
						{[...groups.entries()].map(([providerId, providerAccounts]) => {
							const account = providerAccounts[0] ?? firstAccount;
							if (!account) {
								return null;
							}
							return (
								<div
									data-testid={`subscription-usage-provider-${providerId}`}
									key={providerId}
								>
									<SettingsGroup>
										<SettingsItem
											actions={
												<span className="text-muted-foreground text-xs">
													{tl(
														"{count, plural, one {# connected account} other {# connected accounts}}",
														{ count: providerAccounts.length }
													)}
												</span>
											}
											title={
												<span className="flex min-w-0 items-center gap-2">
													<ProviderMark account={account} />
													<span className="truncate font-medium">
														{account.category}
													</span>
												</span>
											}
										/>
										{/* Only when there is a pooled forecast: a group child that
										    renders nothing would still get hairlines around it. */}
										{providerAccounts.length > 1 &&
										hasPoolForecast(providerAccounts, now) ? (
											<PoolForecast accounts={providerAccounts} now={now} />
										) : null}
										{providerAccounts.map((providerAccount) => (
											<AccountRow
												account={providerAccount}
												key={providerAccount.accountId}
												now={now}
											/>
										))}
									</SettingsGroup>
								</div>
							);
						})}
					</div>
				</SettingsSection>
			) : null}

			<SubscriptionCostBreakdown
				accounts={accounts}
				error={costUsageError}
				loading={costUsageLoading}
				onRetry={onRefresh}
				onSetTracking={onSetCostTracking}
				trackingError={costTrackingError}
				trackingUpdating={costTrackingUpdating}
				usage={costUsage}
			/>

			<p
				className="text-(length:--text-detail) text-muted-foreground leading-(--text-detail--line-height)"
				data-testid="subscription-usage-cost-note"
			>
				<CaptionInfo detail="The opt-in API-equivalent estimate uses models.dev list prices for reported managed-Pi token counts; it is not what the provider charged. Token activity and any Ryu-billed spend stay in the Usage analytics below; direct subscription traffic does not debit Ryu credits.">
					Live limits and provider-reported meters, not an invoice.
				</CaptionInfo>
			</p>
		</section>
	);
}
