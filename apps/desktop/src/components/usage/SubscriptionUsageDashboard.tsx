"use client";

import {
	Alert02Icon,
	Refresh01Icon,
	Timer02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@ryu/ui/components/alert";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { Spinner } from "@ryu/ui/components/spinner";
import { formatCount, formatCurrency } from "@ryu/ui/lib/number-format.ts";
import type { SubscriptionUsageAccount } from "@/src/hooks/useSubscriptionUsage.ts";
import type {
	UsageMeter,
	UsageValue,
	UsageWindow,
} from "@/src/lib/api/usage.ts";
import { formatCountdown, formatExpiryDate } from "@/src/lib/expiry.ts";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";

const CARD_CLASS = "border border-border/60 bg-card/80 shadow-sm";

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

function usageStatus(account: SubscriptionUsageAccount): {
	detail: string;
	label: string;
	variant: "default" | "destructive" | "outline" | "secondary";
} {
	if (account.error) {
		return {
			detail: account.error,
			label: "Unavailable",
			variant: "destructive",
		};
	}
	if (account.kind !== "oauth") {
		return {
			detail: "This account type does not expose subscription usage.",
			label: "Not tracked",
			variant: "secondary",
		};
	}
	if (account.loading) {
		return {
			detail: "Refreshing the provider's usage endpoint…",
			label: "Checking",
			variant: "outline",
		};
	}
	const snapshot = account.snapshot;
	if (!snapshot) {
		return {
			detail: "No usage response was received yet.",
			label: "Unavailable",
			variant: "destructive",
		};
	}
	if (snapshot.available) {
		return {
			detail:
				snapshot.windows.length > 0 || snapshot.meters.length > 0
					? "Provider-reported limits"
					: "The provider returned no metered limits.",
			label: "Live",
			variant: "default",
		};
	}
	const details: Record<string, string> = {
		error: "The provider could not be reached. Try refresh again later.",
		missing_scope: "Reconnect this subscription to grant usage access.",
		no_plan: "This account has no metered subscription limit to show.",
		not_logged_in: "Reconnect this account in Gateway → LLM Providers.",
		rate_limited: "The provider rate-limited this refresh. Try again later.",
		token_expired: "Reconnect this subscription to refresh its access token.",
		unsupported: "This provider does not expose a readable usage window.",
	};
	const reason = snapshot.reason ?? "error";
	return {
		detail: details[reason] ?? "Usage is not available for this account.",
		label: reason === "no_plan" ? "No plan" : "Needs attention",
		variant: reason === "no_plan" ? "secondary" : "destructive",
	};
}

function usedPercent(window: UsageWindow): number {
	return Math.max(0, Math.min(100, window.usedPercent));
}

function windowTone(used: number): string {
	if (used >= 90) {
		return "bg-red-500";
	}
	if (used >= 70) {
		return "bg-amber-500";
	}
	return "bg-emerald-500";
}

function WindowRow({ window }: { window: UsageWindow }) {
	const used = usedPercent(window);
	const remaining = Math.round(100 - used);
	const reset = formatReset(window.resetsAt);
	return (
		<div
			className="flex flex-col gap-1.5"
			data-testid="subscription-usage-window"
		>
			<div className="flex items-center justify-between gap-3 text-xs">
				<span className="flex min-w-0 items-center gap-1.5">
					<span className="truncate font-medium">{window.label}</span>
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
				aria-label={`${window.label}: ${remaining}% left`}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={remaining}
				className="h-2 overflow-hidden rounded-full bg-muted"
				role="progressbar"
			>
				<div
					className={`h-full rounded-full ${windowTone(used)}`}
					style={{ width: `${remaining}%` }}
				/>
			</div>
			{reset ? (
				<time
					className="flex items-center gap-1 text-[11px] text-muted-foreground"
					dateTime={window.resetsAt ?? undefined}
					title={
						window.resetsAt ? formatExpiryDate(window.resetsAt) : undefined
					}
				>
					<HugeiconsIcon icon={Timer02Icon} size={12} />
					{reset}
				</time>
			) : null}
		</div>
	);
}

function MeterRow({ meter }: { meter: UsageMeter }) {
	const value = formatMeter(meter);
	return (
		<div className="flex items-center justify-between gap-3 rounded-xl bg-muted/35 px-2.5 py-2 text-xs">
			<span className="min-w-0 truncate text-muted-foreground">
				{meter.label}
			</span>
			<span className="shrink-0 font-medium tabular-nums">{value}</span>
		</div>
	);
}

function AccountRow({ account }: { account: SubscriptionUsageAccount }) {
	const status = usageStatus(account);
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
			className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-background/40 p-3"
			data-testid={`subscription-usage-account-${account.accountId}`}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<span className="truncate font-medium text-sm">
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
					</div>
				</div>
				<Badge variant={status.variant}>{status.label}</Badge>
			</div>

			{account.loading && !snapshot ? (
				<div className="flex items-center gap-2 text-muted-foreground text-xs">
					<Spinner className="size-3" />
					{status.detail}
				</div>
			) : snapshot?.available ? (
				<div className="flex flex-col gap-3">
					{snapshot.windows.length > 0 ? (
						<div className="flex flex-col gap-3">
							{snapshot.windows.map((window) => (
								<WindowRow
									key={`${window.label}:${window.windowSeconds ?? "unknown"}`}
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
		<span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted">
			{logo ?? (
				<span className="font-medium text-muted-foreground text-xs uppercase">
					{account.category.slice(0, 1)}
				</span>
			)}
		</span>
	);
}

function SummaryTile({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-2xl border border-border/50 bg-muted/30 px-3 py-2.5">
			<div className="text-[11px] text-muted-foreground uppercase tracking-wide">
				{label}
			</div>
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

export function SubscriptionUsageDashboard({
	accounts,
	catalogError,
	catalogLoading,
	onRefresh,
	refreshing = false,
}: {
	accounts: SubscriptionUsageAccount[];
	catalogError?: string | null;
	catalogLoading: boolean;
	onRefresh?: () => void;
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

	return (
		<section
			aria-label="Subscription usage"
			className="flex flex-col gap-4"
			data-testid="subscription-usage-dashboard"
		>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex min-w-0 flex-col gap-1">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="font-medium text-base">Subscription usage</h3>
						<Badge variant="outline">Live account view</Badge>
					</div>
					<p className="max-w-2xl text-muted-foreground text-sm">
						See the provider-reported limits for every subscription account
						connected through Ryu on this node. Each account is checked
						independently.
					</p>
				</div>
				{onRefresh ? (
					<Button
						disabled={refreshing}
						onClick={onRefresh}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon icon={Refresh01Icon} size={16} />
						Refresh accounts
					</Button>
				) : null}
			</div>

			{catalogError ? (
				<Alert data-testid="subscription-usage-error" variant="destructive">
					<HugeiconsIcon icon={Alert02Icon} size={16} />
					<AlertDescription>{catalogError}</AlertDescription>
				</Alert>
			) : null}

			{catalogLoading && accounts.length === 0 ? (
				<Card className={`${CARD_CLASS} flex items-center gap-2 p-6`}>
					<Spinner className="size-4" />
					<span className="text-muted-foreground text-sm">
						Loading connected subscription accounts…
					</span>
				</Card>
			) : accounts.length === 0 ? (
				<Card
					className={`${CARD_CLASS} p-5`}
					data-testid="subscription-usage-empty"
				>
					<div className="flex items-start gap-3">
						<div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-muted">
							<HugeiconsIcon
								className="text-muted-foreground"
								icon={Timer02Icon}
								size={18}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<span className="font-medium text-sm">
								No connected subscription accounts
							</span>
							<p className="text-muted-foreground text-xs">
								Sign in to a provider from Gateway → LLM Providers. Once
								connected, its plan limits and reset windows will appear here.
							</p>
						</div>
					</div>
				</Card>
			) : (
				<>
					<div className="grid grid-cols-3 gap-2">
						<SummaryTile label="Accounts" value={String(accounts.length)} />
						<SummaryTile label="Live now" value={String(liveCount)} />
						<SummaryTile
							label="Needs attention"
							value={String(attentionCount)}
						/>
					</div>
					<div className="grid gap-3 lg:grid-cols-2">
						{[...groups.entries()].map(([providerId, providerAccounts]) => {
							const account = providerAccounts[0] ?? firstAccount;
							if (!account) {
								return null;
							}
							return (
								<Card
									className={CARD_CLASS}
									data-testid={`subscription-usage-provider-${providerId}`}
									key={providerId}
								>
									<CardHeader className="gap-3 p-4 pb-3">
										<div className="flex items-center gap-3">
											<ProviderMark account={account} />
											<div className="min-w-0">
												<CardTitle className="text-sm">
													{account.category}
												</CardTitle>
												<CardDescription>
													{providerAccounts.length} connected account
													{providerAccounts.length === 1 ? "" : "s"}
												</CardDescription>
											</div>
										</div>
									</CardHeader>
									<CardContent className="flex flex-col gap-2 p-4 pt-0">
										{providerAccounts.map((providerAccount) => (
											<AccountRow
												account={providerAccount}
												key={providerAccount.accountId}
											/>
										))}
									</CardContent>
								</Card>
							);
						})}
					</div>
				</>
			)}

			<Card
				className={`${CARD_CLASS} p-4`}
				data-testid="subscription-usage-cost-note"
			>
				<div className="flex flex-col gap-1.5">
					<span className="font-medium text-sm">How to read this</span>
					<p className="text-muted-foreground text-xs">
						These are live limits and provider-reported balance or extra-usage
						meters, not an invoice. Token activity and any Ryu-billed spend stay
						in the Usage analytics below; direct subscription traffic does not
						debit Ryu credits.
					</p>
				</div>
			</Card>
		</section>
	);
}
