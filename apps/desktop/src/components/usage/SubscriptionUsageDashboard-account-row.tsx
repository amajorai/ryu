"use client";

import { Timer02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { Badge } from "@ryu/ui/components/badge.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { formatCount, formatCurrency } from "@ryu/ui/lib/number-format.ts";
import type { ComponentProps } from "react";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import {
	StatusText,
	type StatusTone,
} from "@/src/components/gateway/quiet.tsx";
import type { SubscriptionUsageAccount } from "@/src/hooks/useSubscriptionUsage.ts";
import type {
	UsageMeter,
	UsageReason,
	UsageValue,
	UsageWindow,
} from "@/src/lib/api/usage.ts";
import { formatCountdown, formatExpiryDate } from "@/src/lib/expiry.ts";
import {
	forecastAccountQuota,
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

export function usedPercent(window: UsageWindow): number {
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
	const tl = useLiteralMessages();
	const { estimate } = projection;
	switch (estimate.kind) {
		case "at-limit":
			return (
				<span className="text-status-destructive text-xs">Limit reached</span>
			);
		case "before-reset":
			return (
				<time
					className="text-status-warning text-xs"
					data-testid="subscription-usage-pace"
					dateTime={new Date(estimate.limitAt).toISOString()}
					title={formatExpiryDate(new Date(estimate.limitAt).toISOString())}
				>
					{tl("At this pace, runs out in {duration}", {
						duration: formatTimeUntil(estimate.limitAt, now),
					})}
				</time>
			);
		case "reset-first":
			return (
				<span
					className="text-muted-foreground text-xs"
					data-testid="subscription-usage-pace"
				>
					{tl("At this pace, ~{percent}% left at reset", {
						percent: Math.round(projection.remainingAtReset ?? 0),
					})}
				</span>
			);
		case "warming-up":
			return (
				<span className="text-muted-foreground text-xs">
					Pace forecast after a few minutes of use
				</span>
			);
		default:
			return null;
	}
}

function WindowRow({ now, window }: { now: number; window: UsageWindow }) {
	const tl = useLiteralMessages();
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
					{tl("{remaining}% left", { remaining })}
				</span>
			</div>
			<div
				aria-label={
					remainingAtReset === null
						? tl("{label}: {remaining}% left", {
								label: window.label,
								remaining,
							})
						: tl(
								"{label}: {remaining}% left, about {remainingAtReset}% left at reset at this pace",
								{ label: window.label, remaining, remainingAtReset }
							)
				}
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
						className="flex items-center gap-1 text-muted-foreground text-xs"
						dateTime={window.resetsAt ?? undefined}
						title={
							window.resetsAt ? formatExpiryDate(window.resetsAt) : undefined
						}
					>
						<HugeiconsIcon icon={Timer02Icon} size={14} />
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

function statusTone(variant: string): StatusTone {
	if (variant === "default") {
		return "success";
	}
	return variant === "destructive" ? "destructive" : "muted";
}

export function AccountRow({
	account,
	now,
}: {
	account: SubscriptionUsageAccount;
	now: number;
}) {
	const tl = useLiteralMessages();
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
			className="flex flex-col gap-3 py-3"
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
						{account.active || account.gatewayActive ? (
							<span className="text-muted-foreground text-xs">
								{[
									account.active ? "For you" : null,
									account.gatewayActive ? "Gateway" : null,
								]
									.filter(Boolean)
									.join(" · ")}
							</span>
						) : null}
					</div>
					<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
						{snapshot?.plan ? <span>{snapshot.plan}</span> : null}
						{snapshot?.plan && maxUsed !== null ? <span>·</span> : null}
						{maxUsed !== null && snapshot?.available ? (
							<span>
								{tl("{percent}% used at peak", {
									percent: Math.round(maxUsed),
								})}
							</span>
						) : null}
						{forecast?.limitAt ? (
							<span className="text-status-warning">
								{tl("· on pace to run out in {duration}", {
									duration: formatTimeUntil(forecast.limitAt, now),
								})}
							</span>
						) : null}
					</div>
				</div>
				<StatusText tone={statusTone(status.variant)}>
					{status.label}
				</StatusText>
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
						<div className="flex items-center justify-between gap-3 border-border border-t pt-2 text-xs">
							<span className="text-muted-foreground">
								Extra usage reported
							</span>
							<span className="font-medium tabular-nums">
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
			) : account.error ? (
				<InlineErrorRow
					details={account.error}
					message="Couldn't read this account's usage."
				/>
			) : (
				<p className="text-muted-foreground text-xs">{status.detail}</p>
			)}
		</article>
	);
}
