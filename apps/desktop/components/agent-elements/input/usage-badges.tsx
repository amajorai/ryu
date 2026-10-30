"use client";

import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { memo } from "react";
import { useAgentUsage } from "@/src/hooks/useAgentUsage.ts";
import { useProviderCredits } from "@/src/hooks/useProviderCredits.ts";
import { useSubscriptions } from "@/src/hooks/useSubscriptions.ts";
import {
	type SubscriptionAccount,
	type UsageWindow,
	usageSnapshotFromReading,
} from "@/src/lib/api/usage.ts";
import { formatMeter, formatReset, windowKey } from "./usage-bar-helpers.tsx";
import { MeterTooltipRow, WindowTooltipRow } from "./usage-bar-meters.tsx";

/**
 * The agent picker's per-row usage indicator: the tightest possible read of an
 * agent's subscription headroom, for the row you are about to pick.
 *
 * Shows the single most-consumed window as `NN%` (the one that will bite first),
 * coloured by the same calm → amber → red danger scale as the composer bar, with
 * the full breakdown — every window, every non-percent row, the plan — in its
 * tooltip. Deliberately not the full `UsageBar`: a picker row already carries a
 * logo, a name and a checkmark, and a meter per window would not fit.
 *
 * Renders nothing whenever there is nothing real to show, so a row for an agent
 * with no subscription window (or one that is signed out) looks exactly as it did
 * before this existed.
 *
 * Cost note: one of these mounts per installed subscription-agent row, so opening
 * the picker can touch several vendor endpoints. They share `useAgentUsage`'s
 * query key and its 5-minute `staleTime` with the composer bar, and TanStack's
 * `refetchOnWindowFocus` is stale-gated (`shouldFetchOn` → `isStale`), so a focus
 * cannot fan out a burst — a given agent is polled at most once per 5 minutes no
 * matter how many badges are mounted.
 */
export const AgentUsageBadge = memo(function AgentUsageBadge({
	agentId,
	className,
}: {
	agentId: string;
	className?: string;
}) {
	const tl = useLiteralMessages();
	const usage = useAgentUsage(agentId);
	if (!usage?.available) {
		return null;
	}
	// The ACCOUNT-WIDE window closest to its cap. Model-scoped windows are excluded
	// deliberately: they have their own badges on their own model rows, and folding
	// them in here would read as "this agent is nearly out" when only one model's
	// weekly limit is exhausted — sending the user to a different agent when
	// switching model was free.
	const worst = worstWindow(
		usage.windows.filter((usageWindow) => usageWindow.model === null)
	);
	if (!(worst || usage.meters.length > 0)) {
		return null;
	}
	const used = worst ? Math.max(0, Math.min(100, worst.usedPercent)) : 0;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={
							worst
								? tl("{label}: {percent}% used", {
										label: worst.label,
										percent: String(Math.round(used)),
									})
								: "Subscription usage"
						}
						className={cn(
							"shrink-0 text-xs tabular-nums",
							worst ? usageTextClass(used) : "text-muted-foreground/70",
							className
						)}
					/>
				}
			>
				{worst ? `${Math.round(used)}%` : formatMeter(usage.meters[0])}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					{usage.windows.map((usageWindow) => (
						<WindowTooltipRow
							key={windowKey(usageWindow)}
							mode="used"
							window={usageWindow}
						/>
					))}
					{usage.meters.map((meter) => (
						<MeterTooltipRow key={meter.label} meter={meter} />
					))}
					{usage.plan ? (
						<span className="text-muted-foreground">
							{tl("Plan: {plan}", { plan: usage.plan })}
						</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
});

/**
 * The worst account-wide window of one saved account's reading, as the picker's
 * one-number read. `null` when there is no live account-wide window.
 */
function accountWorstWindow(account: SubscriptionAccount): UsageWindow | null {
	if (!account.usage?.available) {
		return null;
	}
	return worstWindow(
		usageSnapshotFromReading(account.usage).windows.filter(
			(usageWindow) => usageWindow.model === null
		)
	);
}

/** Why an account has no number, in the words the tooltip uses. */
function accountStateText(account: SubscriptionAccount): string {
	switch (account.state) {
		case "needs_reauth":
			return "needs a new sign-in";
		case "pool_disabled":
			return "off in account routing";
		case "unsupported":
			return "no usage reported";
		case "pending":
			return "checking…";
		default:
			return account.usage?.available === false
				? "usage unavailable"
				: "no reading yet";
	}
}

/** One account's line in a provider tooltip: "Work (active): 61% used". */
function AccountTooltipRow({ account }: { account: SubscriptionAccount }) {
	const tlRich = useRichLiteralMessages();
	const worst = accountWorstWindow(account);
	const name = account.label ?? "Saved account";
	return (
		<span className="font-medium">
			{name}
			{account.active ? (
				<span className="font-normal text-muted-foreground"> (active)</span>
			) : null}
			:{" "}
			{worst ? (
				<span className="tabular-nums">
					{tlRich(
						"{percent}% used<span>· {label}</span>",
						{
							percent: String(
								Math.round(Math.max(0, Math.min(100, worst.usedPercent)))
							),
							label: worst.label,
						},
						{
							span: (children) => (
								<span className="ml-1 font-normal text-muted-foreground">
									{children}
								</span>
							),
						}
					)}
				</span>
			) : (
				<span className="font-normal text-muted-foreground">
					{accountStateText(account)}
				</span>
			)}
		</span>
	);
}

/**
 * The picker badge for a Ryu subscription provider logged in through the
 * managed Pi: the ACTIVE account's tightest account-wide window as `NN%`, with a
 * tooltip listing every saved account. Shares the ACP badge's colour scale.
 *
 * Reads Core's subscriptions snapshot for this provider, so every account's
 * number comes from one request and the same cached readings the usage page and
 * account-routing settings show. Renders nothing when Core reports no
 * per-account usage for the provider.
 */
export const ProviderUsageBadge = memo(function ProviderUsageBadge({
	className,
	providerId,
}: {
	className?: string;
	providerId: string;
}) {
	const tl = useLiteralMessages();
	const { data } = useSubscriptions({ providerId, usage: "refresh" });
	const provider = data?.providers.find(
		(entry) => entry.providerId === providerId
	);
	if (!(provider?.capabilities.accountUsage && provider.accounts.length > 0)) {
		return null;
	}
	const activeAccount =
		provider.accounts.find((account) => account.active) ?? null;
	const worst = activeAccount ? accountWorstWindow(activeAccount) : null;
	const used = worst ? Math.max(0, Math.min(100, worst.usedPercent)) : 0;
	const label = activeAccount?.label ?? provider.label;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={
							worst
								? tl("{name}: {window} {percent}% used", {
										name: label,
										window: worst.label,
										percent: String(Math.round(used)),
									})
								: tl("{label} account usage", { label: provider.label })
						}
						className={cn(
							"shrink-0 text-xs tabular-nums",
							worst ? usageTextClass(used) : "text-muted-foreground/70",
							className
						)}
					/>
				}
			>
				{worst ? `${Math.round(used)}%` : "—"}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					{provider.accounts.map((account) => (
						<AccountTooltipRow account={account} key={account.accountId} />
					))}
				</div>
			</TooltipContent>
		</Tooltip>
	);
});

/**
 * One saved account's usage as the same `NN%` badge, for a per-account list.
 * Purely presentational: it renders the reading Core put in the subscriptions
 * snapshot and never asks for one itself, so an account Core will not read (a
 * login that needs a new sign-in, one switched off in routing) stays unread.
 */
export const AccountUsageBadge = memo(function AccountUsageBadge({
	account,
	className,
}: {
	account: SubscriptionAccount;
	className?: string;
}) {
	const tl = useLiteralMessages();
	const worst = accountWorstWindow(account);
	const snapshot =
		account.usage?.available === true
			? usageSnapshotFromReading(account.usage)
			: null;
	const name = account.label ?? "Saved account";
	if (!(worst && snapshot)) {
		return (
			<span
				className={cn("shrink-0 text-muted-foreground/70 text-xs", className)}
			>
				{accountStateText(account)}
			</span>
		);
	}
	const used = Math.max(0, Math.min(100, worst.usedPercent));
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={tl("{name}: {window} {percent}% used", {
							name,
							window: worst.label,
							percent: String(Math.round(used)),
						})}
						className={cn(
							"shrink-0 text-xs tabular-nums",
							usageTextClass(used),
							className
						)}
					/>
				}
			>
				{Math.round(used)}%
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					{snapshot.windows.map((usageWindow) => (
						<WindowTooltipRow
							key={windowKey(usageWindow)}
							mode="used"
							window={usageWindow}
						/>
					))}
					{snapshot.meters.map((meter) => (
						<MeterTooltipRow key={meter.label} meter={meter} />
					))}
					{snapshot.plan ? (
						<span className="text-muted-foreground">
							{tl("Plan: {plan}", { plan: snapshot.plan })}
						</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
});

/**
 * The window closest to its cap — the one that stops the next turn, which is the
 * only thing a one-number badge can usefully say. `null` for an empty list.
 */
function worstWindow(windows: UsageWindow[]): UsageWindow | null {
	return windows.reduce<UsageWindow | null>(
		(peak, candidate) =>
			peak === null || candidate.usedPercent > peak.usedPercent
				? candidate
				: peak,
		null
	);
}

/** Text-colour counterpart of `fillClass`, for the picker badge's bare number. */
function usageTextClass(usedPercent: number): string {
	if (usedPercent >= 90) {
		return "text-status-destructive";
	}
	if (usedPercent >= 70) {
		return "text-status-warning";
	}
	return "text-muted-foreground/70";
}

/**
 * Normalize a model name for matching: lowercase, strip everything that isn't a
 * letter or digit. `"GPT-5.3-Codex-Spark"` and `"gpt_5_3_codex_spark"` collapse
 * to the same token, so punctuation drift between the vendor's limit name and
 * the model id in the picker can't break the match.
 */
function normalizeModel(value: string): string {
	return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

/**
 * The per-model quota badge for a model row inside an agent's submenu: Claude's
 * weekly Sonnet / Opus limits, Codex's Spark pair.
 *
 * Matched on `UsageWindow.model` — which Core reports explicitly — rather than on
 * the window's label. Inferring "a label that isn't Session or Weekly names a
 * model" would need a closed set of non-model labels, and Copilot's `Chat` /
 * `Completions` and Z.ai's `Daily` are exactly what such a set misses; hanging an
 * account-wide quota off a model row because they shared a word is worse than
 * showing nothing.
 *
 * Renders nothing when this model has no window of its own, which is the common
 * case — most models draw on the account-wide pool the row's agent badge shows.
 */
export const ModelUsageBadge = memo(function ModelUsageBadge({
	agentId,
	modelId,
	modelName,
}: {
	agentId: string;
	modelId: string;
	modelName?: string;
}) {
	const tl = useLiteralMessages();
	const usage = useAgentUsage(agentId);
	if (!usage?.available) {
		return null;
	}
	const haystack = normalizeModel(`${modelId} ${modelName ?? ""}`);
	// A model can have MORE than one window of its own — Codex meters Spark on both
	// a 5h and a weekly limit — so take the one closest to its cap, exactly as the
	// agent badge does. Taking the first would hide a Spark weekly at 95% behind a
	// session at 3%.
	const scoped = worstWindow(
		usage.windows.filter((usageWindow) => {
			if (!usageWindow.model) {
				return false;
			}
			const needle = normalizeModel(usageWindow.model);
			return needle.length > 0 && haystack.includes(needle);
		})
	);
	if (!scoped) {
		return null;
	}
	const used = Math.max(0, Math.min(100, scoped.usedPercent));
	const reset = formatReset(scoped.resetsAt);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={tl("{label}: {percent}% used", {
							label: scoped.label,
							percent: String(Math.round(used)),
						})}
						className={cn(
							"shrink-0 text-xs tabular-nums",
							usageTextClass(used)
						)}
					/>
				}
			>
				{Math.round(used)}%
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					<WindowTooltipRow mode="used" window={scoped} />
					{reset ? null : (
						<span className="text-muted-foreground">
							This model has its own limit.
						</span>
					)}
				</div>
			</TooltipContent>
		</Tooltip>
	);
});

/**
 * A BYOK provider's remaining prepaid API credit, on its picker row: "$37.75".
 *
 * Only three providers expose a balance to the inference key you already hold
 * (OpenRouter, DeepSeek, Moonshot) — `useProviderCredits` gates the query on
 * that, so the ~13 that don't cost nothing. Anything unavailable renders
 * nothing: a row that suddenly shows an error chip is worse than one that shows
 * no chip, and `$0.00` for "we couldn't ask" would be a lie about their money.
 */
export const ProviderCreditsBadge = memo(function ProviderCreditsBadge({
	providerId,
	label,
}: {
	providerId: string;
	label: string;
}) {
	const tl = useLiteralMessages();
	const credits = useProviderCredits(providerId);
	const meters = credits?.available ? credits.meters : [];
	const balance = meters.at(0);
	if (!balance) {
		return null;
	}
	// The leading figure only. Core emits granted/voucher money as its OWN meter
	// precisely so it can't be rendered as a "$9.87/$1.23" ratio; the chip shows
	// the balance and the tooltip lists the rest.
	const text = formatMeter(balance);
	if (!text) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={tl("{label}: {text} of API credit left", {
							label,
							text,
						})}
						className="shrink-0 text-muted-foreground/70 text-xs tabular-nums"
					/>
				}
			>
				{text}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					{meters.map((meter) => (
						<MeterTooltipRow key={meter.label} meter={meter} />
					))}
					<span className="text-muted-foreground">
						{tl("Prepaid credit on your {label} key.", { label })}
					</span>
				</div>
			</TooltipContent>
		</Tooltip>
	);
});
