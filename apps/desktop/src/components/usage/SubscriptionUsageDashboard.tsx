"use client";

import { Refresh01Icon, Timer02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	projectPeriodTotal,
	utcMonthBounds,
} from "@ryu/blocks/desktop/usage-forecast.ts";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { formatCount, formatCurrency } from "@ryu/ui/lib/number-format.ts";
import type { ComponentProps } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { useSubscriptionCostUsage } from "@/src/hooks/useSubscriptionCostUsage.ts";
import type { SubscriptionUsageAccount } from "@/src/hooks/useSubscriptionUsage.ts";
import type { SubscriptionCostUsageSummary } from "@/src/lib/api/subscription-costs.ts";
import type {
	UsageMeter,
	UsageReason,
	UsageValue,
	UsageWindow,
} from "@/src/lib/api/usage.ts";
import { formatCountdown, formatExpiryDate } from "@/src/lib/expiry.ts";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";
import {
	forecastAccountQuota,
	forecastQuotaPool,
	formatTimeUntil,
	projectWindow,
	type WindowProjection,
} from "./quota-forecast.ts";
import usageVisualStyles from "./usage-visual-indicators.module.css";
import type { UsageVisualStyle } from "./usage-visual-style.ts";

function formatReset(resetAt: string | null): string | null {
	if (!resetAt) {
		return null;
	}
	const countdown = formatCountdown(resetAt);
	if (!countdown) {
		return null;
	}
	return countdown === "expired" ? "resets soon" : `resets in ${countdown}`;
}

function formatValue(value: UsageValue): string {
	if (value.kind === "dollars") {
		return formatCurrency(value.number, value.currency ?? "USD", {
			maximumFractionDigits: 2,
			minimumFractionDigits: 2,
		});
	}
	if (value.kind === "percent") {
		return `${Math.round(value.number)}%`;
	}
	const count = formatCount(value.number) ?? "—";
	return value.unit ? `${count} ${value.unit}` : count;
}

function formatMeter(meter: UsageMeter): string {
	const [first, second] = meter.values;
	if (!first) {
		return "—";
	}
	return second && second.kind === first.kind
		? `${formatValue(first)} / ${formatValue(second)}`
		: formatValue(first);
}

interface UsageStatusPresentation {
	detail: string;
	label: string;
	variant: NonNullable<ComponentProps<typeof Badge>["variant"]>;
}

function usageStatus(account: SubscriptionUsageAccount) {
	if (account.error) {
		return {
			detail: account.error,
			label: "Unavailable",
			variant: "destructive",
		} satisfies UsageStatusPresentation;
	}
	if (account.kind !== "oauth") {
		return {
			detail: "This account type does not expose subscription usage.",
			label: "Not tracked",
			variant: "secondary",
		} satisfies UsageStatusPresentation;
	}
	if (account.loading) {
		return {
			detail: "Refreshing the provider's usage endpoint…",
			label: "Checking",
			variant: "outline",
		} satisfies UsageStatusPresentation;
	}
	const snapshot = account.snapshot;
	if (!snapshot) {
		return {
			detail: "No usage response was received yet.",
			label: "Unavailable",
			variant: "destructive",
		} satisfies UsageStatusPresentation;
	}
	if (snapshot.available) {
		return {
			detail:
				snapshot.windows.length > 0 || snapshot.meters.length > 0
					? "Provider-reported limits"
					: "The provider returned no metered limits.",
			label: "Live",
			variant: "default",
		} satisfies UsageStatusPresentation;
	}
	const details = {
		error: "Usage could not be read. Try refresh again later.",
		missing_scope: "Reconnect this subscription to grant usage access.",
		no_plan: "This account has no metered subscription limit to show.",
		not_logged_in:
			"Start or sign in to this provider on the active node, then refresh usage.",
		rate_limited: "The provider rate-limited this refresh. Try again later.",
		token_expired: "Reconnect this subscription to refresh its access token.",
		unsupported: "This provider does not expose a readable usage window.",
	} satisfies Record<UsageReason, string>;
	const reason = snapshot.reason ?? "error";
	return {
		detail: details[reason] ?? "Usage is not available for this account.",
		label: reason === "no_plan" ? "No plan" : "Needs attention",
		variant: reason === "no_plan" ? "secondary" : "destructive",
	} satisfies UsageStatusPresentation;
}

function usedPercent(window: UsageWindow): number {
	return Math.max(0, Math.min(100, window.usedPercent));
}

function windowTone(used: number): string {
	if (used >= 90) {
		return "bg-destructive";
	}
	if (used >= 70) {
		return "bg-warning";
	}
	return "bg-success";
}

function PaceNote({
	now,
	projection,
}: {
	now: number;
	projection: WindowProjection;
}) {
	const { estimate } = projection;
	switch (estimate.kind) {
		case "at-limit":
			return (
				<span className="type-caption text-status-destructive">
					Limit reached
				</span>
			);
		case "before-reset":
			return (
				<time
					className="type-caption text-status-warning"
					data-testid="subscription-usage-pace"
					dateTime={new Date(estimate.limitAt).toISOString()}
					title={formatExpiryDate(new Date(estimate.limitAt).toISOString())}
				>
					At this pace, runs out in {formatTimeUntil(estimate.limitAt, now)}
				</time>
			);
		case "reset-first":
			return (
				<span
					className="type-caption text-muted-foreground"
					data-testid="subscription-usage-pace"
				>
					At this pace, ~{Math.round(projection.remainingAtReset ?? 0)}% left at
					reset
				</span>
			);
		case "warming-up":
			return (
				<span className="type-caption text-muted-foreground">
					Pace forecast after a few minutes of use
				</span>
			);
		default:
			return null;
	}
}

function WindowRow({ now, window }: { now: number; window: UsageWindow }) {
	const used = usedPercent(window);
	const remaining = Math.round(100 - used);
	const reset = formatReset(window.resetsAt);
	const projection = projectWindow(window, now);
	const remainingAtReset =
		projection.remainingAtReset === null
			? null
			: Math.min(remaining, Math.round(projection.remainingAtReset));
	const projectedUse =
		remainingAtReset === null ? 0 : remaining - remainingAtReset;
	return (
		<div
			className="flex flex-col gap-1.5"
			data-testid="subscription-usage-window"
		>
			<div className="flex items-center justify-between gap-3 text-xs">
				<span className="flex min-w-0 items-center gap-1.5">
					<span className="truncate font-medium" title={window.label}>
						{window.label}
					</span>
					{window.model ? (
						<span className="truncate text-muted-foreground">
							· {window.model}
						</span>
					) : null}
				</span>
				<span className="shrink-0 text-muted-foreground tabular-nums">
					{remaining}% left
				</span>
			</div>
			<div
				aria-label={`${window.label}: ${remaining}% left${remainingAtReset === null ? "" : `, about ${remainingAtReset}% left at reset at this pace`}`}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={remaining}
				className="relative h-2 overflow-hidden rounded-full bg-muted"
				role="progressbar"
			>
				<div
					className={`h-full rounded-full ${windowTone(used)} ${usageVisualStyles.remainingWidth}`}
					style={
						// SAFETY: The literal satisfies full React CSSProperties and the named native CSS slots.
						// This checked owner assertion only clears fresh-literal metadata for React style.
						{
							"--usage-remaining-width": `${remaining}%`,
						} satisfies UsageVisualStyle as UsageVisualStyle
					}
				/>
				{projectedUse > 0 ? (
					<div
						aria-hidden="true"
						className={`absolute inset-y-0 ${usageVisualStyles.projectedConsumption}`}
						data-testid="subscription-usage-projected-use"
						style={
							// SAFETY: The literal satisfies full React CSSProperties and the named native CSS slots.
							// This checked owner assertion only clears fresh-literal metadata for React style.
							{
								"--usage-projected-left": `${remainingAtReset}%`,
								"--usage-projected-width": `${projectedUse}%`,
							} satisfies UsageVisualStyle as UsageVisualStyle
						}
					/>
				) : null}
			</div>
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
				{reset ? (
					<time
						className="type-caption flex items-center gap-1 text-muted-foreground"
						dateTime={window.resetsAt ?? undefined}
						title={
							window.resetsAt ? formatExpiryDate(window.resetsAt) : undefined
						}
					>
						<HugeiconsIcon icon={Timer02Icon} size={12} />
						{reset}
					</time>
				) : (
					<span />
				)}
				<PaceNote now={now} projection={projection} />
			</div>
		</div>
	);
}

function MeterRow({ meter }: { meter: UsageMeter }) {
	const value = formatMeter(meter);
	return (
		<div className="flex items-center justify-between gap-3 text-xs">
			<span
				className="min-w-0 truncate text-muted-foreground"
				title={meter.label}
			>
				{meter.label}
			</span>
			<span className="shrink-0 font-medium tabular-nums">{value}</span>
		</div>
	);
}

function AccountRow({
	account,
	now,
}: {
	account: SubscriptionUsageAccount;
	now: number;
}) {
	const status = usageStatus(account);
	const forecast = forecastAccountQuota(account, now);
	const snapshot = account.snapshot;
	const hasExtraUsageMeter = Boolean(
		snapshot?.meters.some((meter) =>
			meter.label.toLowerCase().includes("extra usage")
		)
	);
	const maxUsed =
		snapshot && snapshot.windows.length > 0
			? snapshot.windows.reduce(
					(highest, window) => Math.max(highest, usedPercent(window)),
					0
				)
			: null;
	return (
		<article
			className="flex flex-col gap-3 px-3.5 py-3"
			data-testid={`subscription-usage-account-${account.accountId}`}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<span
							className="truncate font-medium text-sm"
							title={account.accountLabel}
						>
							{account.accountLabel}
						</span>
						{account.active ? <Badge variant="secondary">For you</Badge> : null}
						{account.gatewayActive ? (
							<Badge variant="outline">Gateway</Badge>
						) : null}
					</div>
					<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
						{snapshot?.plan ? <span>{snapshot.plan}</span> : null}
						{snapshot?.plan && maxUsed !== null ? <span>·</span> : null}
						{maxUsed !== null && snapshot?.available ? (
							<span>{Math.round(maxUsed)}% used at peak</span>
						) : null}
						{forecast?.limitAt ? (
							<span className="text-status-warning">
								· on pace to run out in {formatTimeUntil(forecast.limitAt, now)}
							</span>
						) : null}
					</div>
				</div>
				<Badge variant={status.variant}>{status.label}</Badge>
			</div>

			{account.loading && !snapshot ? (
				<SkeletonRows label={status.detail} spacing="comfortable" />
			) : snapshot?.available ? (
				<div className="flex flex-col gap-3">
					{snapshot.windows.length > 0 ? (
						<div className="flex flex-col gap-3">
							{snapshot.windows.map((window) => (
								<WindowRow
									key={`${window.label}:${window.windowSeconds ?? "unknown"}`}
									now={now}
									window={window}
								/>
							))}
						</div>
					) : null}
					{snapshot.meters.length > 0 ? (
						<div className="flex flex-col gap-1.5">
							{snapshot.meters.map((meter) => (
								<MeterRow key={meter.label} meter={meter} />
							))}
						</div>
					) : null}
					{snapshot.extraUsageUsd === null || hasExtraUsageMeter ? null : (
						<div className="flex items-center justify-between gap-3 border-border/50 border-t pt-2 text-xs">
							<span className="text-muted-foreground">
								Extra usage reported
							</span>
							<span className="font-medium font-mono tabular-nums">
								{formatCurrency(snapshot.extraUsageUsd, "USD", {
									maximumFractionDigits: 2,
									minimumFractionDigits: 2,
								})}
							</span>
						</div>
					)}
					{snapshot.windows.length === 0 && snapshot.meters.length === 0 ? (
						<p className="text-muted-foreground text-xs">{status.detail}</p>
					) : null}
				</div>
			) : (
				<p className="text-muted-foreground text-xs">{status.detail}</p>
			)}
		</article>
	);
}

function ProviderMark({ account }: { account: SubscriptionUsageAccount }) {
	const logo = (
		<ProviderBrandLogo
			providerKey={`${account.providerId} ${account.providerLabel}`}
			size={20}
		/>
	);
	return (
		<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
			{logo ?? (
				<span className="font-medium text-muted-foreground text-xs uppercase">
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
	const pool = forecastQuotaPool(accounts, now);
	if (pool.remainingNow === null || pool.remainingAtReset === null) {
		return null;
	}
	return (
		<div
			className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2.5 text-xs"
			data-testid="subscription-usage-pool-forecast"
		>
			<span className="text-muted-foreground">
				Pooled headroom across {pool.forecastable} account
				{pool.forecastable === 1 ? "" : "s"}
			</span>
			<span className="tabular-nums">
				{Math.round(pool.remainingNow)}% now → ~
				{Math.round(pool.remainingAtReset)}% at reset
			</span>
			<span
				className={
					pool.atRisk > 0 ? "text-status-warning" : "text-muted-foreground"
				}
			>
				{pool.atRisk > 0
					? `${pool.atRisk} on pace to hit a limit`
					: "All on pace to last until reset"}
			</span>
		</div>
	);
}

function SummaryTile({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<div className="text-muted-foreground text-xs">{label}</div>
			<div className="mt-1 font-medium text-lg tabular-nums">{value}</div>
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

function SubscriptionCostBreakdown({
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
										className="type-compact text-muted-foreground tabular-nums"
										data-testid="subscription-cost-month-end"
									>
										Month-end ≈ {overallMonthEnd}
									</div>
								) : null}
							</div>
						}
						description={`Month to date (${usage?.month ?? "UTC"}) · estimated at models.dev list prices, not provider billing.`}
						title={`Total estimate${overallPartial ? " · partial" : ""}`}
					/>
				</SettingsGroup>
				{trackingError ? (
					<p className="px-3.5 text-destructive text-xs" role="alert">
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
													<div className="type-compact text-muted-foreground">
														API equivalent{partial ? " · partial" : ""}
													</div>
													<div
														className="font-medium text-sm tabular-nums"
														data-testid={`subscription-cost-provider-total-${providerId}`}
													>
														{formatEstimate(knownCost)}
													</div>
													{providerMonthEnd ? (
														<div className="type-compact text-muted-foreground tabular-nums">
															Month-end ≈ {providerMonthEnd}
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
												) ?? `Former account · ${account.accountId.slice(-6)}`;
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
													className="flex flex-col gap-1 px-3.5 py-2.5"
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
													<div className="type-caption text-muted-foreground">
														{formatCount(account.inputTokens) ?? "0"} input ·{" "}
														{formatCount(account.outputTokens) ?? "0"} output
														tokens
														{accountMonthEnd
															? ` · ≈ ${accountMonthEnd} by month end`
															: ""}
													</div>
													{account.unpricedInputTokens +
														account.unpricedOutputTokens >
													0 ? (
														<p className="type-caption text-muted-foreground">
															{formatCount(
																account.unpricedInputTokens +
																	account.unpricedOutputTokens
															)}{" "}
															tokens have no models.dev price.
														</p>
													) : null}
													{account.missingInputTurns +
														account.missingOutputTurns >
													0 ? (
														<p className="type-caption text-muted-foreground">
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
			className="flex flex-col gap-6"
			data-testid="subscription-usage-dashboard"
		>
			<SettingsSection
				caption="See the provider-reported limits for every subscription account connected through Ryu on this node. Each account is checked independently."
				headerAction={
					onRefresh ? (
						<Button
							disabled={refreshing}
							onClick={onRefresh}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon icon={Refresh01Icon} size={16} />
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
					<SettingsCard>
						<SkeletonRows label="Loading connected subscription accounts…" />
					</SettingsCard>
				) : accounts.length === 0 ? (
					<div data-testid="subscription-usage-empty">
						<SettingsCard className="text-center text-muted-foreground text-sm">
							No connected subscription accounts. Sign in to a provider from
							Gateway → AI providers to see its plan limits and reset windows
							here.
						</SettingsCard>
					</div>
				) : (
					<SettingsCard className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
						<SummaryTile label="Accounts" value={String(accounts.length)} />
						<SummaryTile label="Live now" value={String(liveCount)} />
						<SummaryTile
							label="Needs attention"
							value={String(attentionCount)}
						/>
						<SummaryTile
							label="On pace to hit limit"
							value={
								pool.forecastable > 0
									? `${pool.atRisk} of ${pool.forecastable}`
									: "—"
							}
						/>
					</SettingsCard>
				)}
			</SettingsSection>

			{groups.size > 0 ? (
				<SettingsSection title="Connected accounts">
					<div className="flex flex-col gap-3">
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
													{providerAccounts.length} connected account
													{providerAccounts.length === 1 ? "" : "s"}
												</span>
											}
											title={
												<span className="flex min-w-0 items-center gap-2.5">
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

			<div data-testid="subscription-usage-cost-note">
				<SettingsSection title="How to read this">
					<SettingsCard className="text-muted-foreground text-xs">
						These are live limits and provider-reported balance or extra-usage
						meters, not an invoice. The opt-in API-equivalent estimate above
						uses models.dev list prices for reported managed-Pi token counts; it
						is not what the provider charged for your subscription. Token
						activity and any Ryu-billed spend stay in the Usage analytics below;
						direct subscription traffic does not debit Ryu credits.
					</SettingsCard>
				</SettingsSection>
			</div>
		</section>
	);
}
