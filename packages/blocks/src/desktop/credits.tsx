"use client";

// Presentational layer of the desktop Credits page. The live app
// (`apps/desktop/src/pages/CreditsPage.tsx`) is a thin container that loads the
// wallet via `useCreditsWallet()` and drives top-up checkout; the storyboard
// renders the same component with mock data and no-op handlers. One source of
// truth, so editing this block changes the real desktop too.

import {
	Add01Icon,
	Alert02Icon,
	DollarCircleIcon,
	Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { BeforeAfterSummary } from "@ryu/ui/components/before-after-summary.tsx";
import { Button } from "@ryu/ui/components/button";
import {
	type CreditAllocationView,
	CreditBalanceBreakdown,
} from "@ryu/ui/components/credit-balance-breakdown.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Separator } from "@ryu/ui/components/separator";
import { Spinner } from "@ryu/ui/components/spinner";
import { formatMicroUsd as formatSharedMicroUsd } from "@ryu/ui/lib/number-format.ts";
import { useState } from "react";

/** Pure micro-USD → currency formatter, copied from `@/src/lib/api/credits`
 *  so the block stays free of app imports. */
export function formatMicroUsd(microUsd: number, currency = "usd"): string {
	return formatSharedMicroUsd(microUsd, currency);
}

export interface CreditWalletView {
	balanceBreakdownAvailable?: boolean;
	balanceMicroUsd: number;
	currency: string;
	providerAllocations?: CreditGrantPoolView[];
	source?: "local" | "polar";
	subscriptionBalanceMicroUsd: number | null;
	topupBalanceMicroUsd: number | null;
}

export interface CreditEntitlementView {
	managedInference: boolean;
	monthlyCreditPoolMicroUsd: number;
	plan: string | null;
	planLabel?: string;
	seats: number;
}

/**
 * One pool-restricted grant balance, as the Credits page renders it.
 *
 * This is a DECOMPOSITION of the wallet total, not an addition to it: granted
 * money already sits inside `CreditWalletView.balanceMicroUsd`. The view never
 * sums these and never subtracts them — it only explains which part of the total
 * is spendable on what.
 *
 * The container supplies every string. `label` is the pool's user-facing tier
 * name and is the ONLY name a user may read for a pool (pools are named for
 * speed/capability, never for the vendor behind them); `spendableOn` is
 * user-facing copy the container derives from the pool catalog, and is omitted
 * for a pool id this build does not recognize rather than guessed at.
 */
export interface CreditGrantPoolView {
	/** Pre-formatted expiry ("Expires 12 Aug 2026"), or null when it never lapses. */
	expiresAtLabel?: string | null;
	id: string;
	isFreeProvider: boolean;
	label: string;
	remainingMicroUsd: number;
	spendableOn?: string;
}

export interface CreditLedgerRow {
	balanceAfter: number;
	createdAtLabel: string;
	delta: number;
	id: string;
	isCredit: boolean;
	reasonLabel: string;
}

type PendingTopup = number | "custom";

function pendingTopupDollars(
	pendingTopup: PendingTopup | null,
	customAmount: string
): number | null {
	if (pendingTopup === null) {
		return null;
	}
	if (pendingTopup === "custom") {
		const parsed = Number.parseFloat(customAmount);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return pendingTopup;
}

export interface CreditsViewProps {
	authed?: boolean;
	billingUnavailable?: boolean;
	busyPack?: number | "custom" | null;
	customAmount?: string;
	entitlement?: CreditEntitlementView | null;
	/** Generic balance-load error message. */
	errorMessage?: string | null;
	/**
	 * Pool-restricted grant balances that make up part of the total. Empty or
	 * absent for the overwhelming majority of accounts, which must then see
	 * EXACTLY the pre-grant page — no header, no placeholder, no empty state.
	 */
	grantPools?: CreditGrantPoolView[];
	/** True while the optional provider-allocation read is in flight. */
	grantPoolsLoading?: boolean;
	ledger?: CreditLedgerRow[];
	ledgerPage?: number;
	loading?: boolean;
	maxTopupDollars?: number;
	minTopupDollars?: number;
	/** Set when the org is missing (409). */
	noOrgMessage?: string | null;
	/** Opens the web app's organizations page (create/select an org). */
	onCreateOrganization?: () => void;
	onCustomAmountChange?: (value: string) => void;
	onNextPage?: () => void;
	onPrevPage?: () => void;
	onRefresh?: () => void;
	onSignIn?: () => void;
	onTopupCustom?: () => void;
	onTopupPack?: (pack: number) => void;
	packs?: number[];
	totalPages?: number;
	wallet?: CreditWalletView | null;
	walletEmpty?: boolean;
}

function LedgerAmount({
	row,
	currency,
}: {
	row: CreditLedgerRow;
	currency: string;
}) {
	const formatted = formatMicroUsd(Math.abs(row.delta), currency);
	return (
		<span
			className={`font-heading font-medium text-sm tabular-nums ${
				row.isCredit ? "text-green-600 dark:text-green-400" : "text-foreground"
			}`}
		>
			{row.isCredit ? "+" : "−"}
			{formatted}
		</span>
	);
}

export function CreditsView({
	authed = true,
	loading,
	noOrgMessage,
	onCreateOrganization,
	errorMessage,
	wallet,
	walletEmpty,
	entitlement,
	grantPools = [],
	grantPoolsLoading = false,
	ledger = [],
	packs = [10, 25, 100],
	minTopupDollars = 5,
	maxTopupDollars = 1000,
	customAmount = "",
	billingUnavailable,
	busyPack = null,
	ledgerPage = 0,
	totalPages = 1,
	onRefresh,
	onTopupPack,
	onTopupCustom,
	onCustomAmountChange,
	onPrevPage,
	onNextPage,
	onSignIn,
}: CreditsViewProps) {
	const currency = wallet?.currency ?? "usd";
	const [pendingTopup, setPendingTopup] = useState<PendingTopup | null>(null);
	const pendingDollars = pendingTopupDollars(pendingTopup, customAmount);
	const pendingMicroUsd =
		pendingDollars === null ? null : Math.round(pendingDollars * 1_000_000);
	const pendingAmountLabel =
		pendingDollars === null ? "—" : `$${pendingDollars.toFixed(2)}`;
	const currentBalance = wallet
		? formatMicroUsd(wallet.balanceMicroUsd, currency)
		: "—";
	const balanceAfterTopup =
		wallet && pendingMicroUsd !== null
			? formatMicroUsd(wallet.balanceMicroUsd + pendingMicroUsd, currency)
			: pendingMicroUsd === null
				? "—"
				: "Pending";

	const openTopupReview = (value: PendingTopup) => {
		if (pendingTopupDollars(value, customAmount) === null) {
			return;
		}
		setPendingTopup(value);
	};

	const confirmTopup = () => {
		if (pendingTopup === null) {
			return;
		}
		setPendingTopup(null);
		if (pendingTopup === "custom") {
			onTopupCustom?.();
			return;
		}
		onTopupPack?.(pendingTopup);
	};

	if (!authed) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={DollarCircleIcon} />
					</EmptyMedia>
					<EmptyTitle>Sign in to view credits</EmptyTitle>
					<EmptyDescription>
						Ryu credits are a prepaid balance on your organization. Sign in to
						see your balance and top up.
					</EmptyDescription>
				</EmptyHeader>
				{onSignIn ? (
					<EmptyContent>
						<Button onClick={onSignIn} size="sm">
							Sign in
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}

	if (noOrgMessage) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={DollarCircleIcon} />
					</EmptyMedia>
					<EmptyTitle>No organization selected</EmptyTitle>
					<EmptyDescription>{noOrgMessage}</EmptyDescription>
				</EmptyHeader>
				{onCreateOrganization ? (
					<EmptyContent>
						<Button onClick={onCreateOrganization} size="sm">
							Create or select an organization
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}

	return (
		<div className="mx-auto max-w-2xl px-6 py-8">
			<div className="mb-8 flex items-center justify-between">
				<h1 className="font-medium text-xl">Credits</h1>
				<Button
					aria-label="Refresh balance"
					onClick={onRefresh}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="mr-2 size-3.5" icon={Refresh01Icon} />
					Refresh
				</Button>
			</div>

			{walletEmpty ? (
				<div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
					<HugeiconsIcon
						className="mt-0.5 size-5 shrink-0 text-amber-500"
						icon={Alert02Icon}
					/>
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm">Your credit balance is empty</p>
						<p className="mt-0.5 text-muted-foreground text-xs">
							Managed (Ryu Cloud) inference is paused until you top up. Your
							included plan pool refills at the start of each billing period.
						</p>
						<Button
							className="mt-2"
							loading={busyPack === packs[0]}
							onClick={() => openTopupReview(packs[0])}
							size="sm"
						>
							{busyPack !== packs[0] && (
								<HugeiconsIcon className="mr-2 size-3.5" icon={Add01Icon} />
							)}
							Add <span className="font-heading">${packs[0]}</span> credits
						</Button>
					</div>
				</div>
			) : null}

			<section className="mb-8">
				<h2 className="mb-3 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Credit balances
				</h2>
				{!(loading || wallet) && errorMessage ? (
					<p className="mb-3 text-destructive text-xs">
						Could not load your balance: {errorMessage}
					</p>
				) : null}
				<CreditBalanceBreakdown
					balanceBreakdownAvailable={wallet?.balanceBreakdownAvailable}
					currency={currency}
					onDemandCreditsMicroUsd={wallet?.topupBalanceMicroUsd ?? null}
					planAllowanceMicroUsd={entitlement?.monthlyCreditPoolMicroUsd ?? null}
					planCreditsMicroUsd={wallet?.subscriptionBalanceMicroUsd ?? null}
					providerAllocations={
						wallet?.balanceBreakdownAvailable === false
							? (wallet.providerAllocations ?? null)
							: wallet && !grantPoolsLoading
								? grantPools.map<CreditAllocationView>((pool) => ({
										expiresAtLabel: pool.expiresAtLabel,
										id: pool.id,
										isFreeProvider: pool.isFreeProvider,
										label: pool.label,
										remainingMicroUsd: pool.remainingMicroUsd,
										spendableOn: pool.spendableOn,
									}))
								: null
					}
					totalMicroUsd={wallet?.balanceMicroUsd ?? null}
				/>
			</section>

			<section className="mb-8">
				<h2 className="mb-3 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Add credits
				</h2>
				{billingUnavailable ? (
					<div className="rounded-lg border bg-card p-4 text-muted-foreground text-sm">
						Credit top-up is unavailable: billing is not configured.
					</div>
				) : (
					<div className="space-y-3 rounded-lg border bg-card p-4">
						<div className="flex flex-wrap gap-2">
							{packs.map((pack) => (
								<Button
									key={pack}
									loading={busyPack === pack}
									onClick={() => openTopupReview(pack)}
									variant="outline"
								>
									{busyPack !== pack && (
										<HugeiconsIcon className="mr-2 size-3.5" icon={Add01Icon} />
									)}
									<span className="font-heading">${pack}</span>
								</Button>
							))}
						</div>

						<Separator />

						<div className="space-y-1.5">
							<Label htmlFor="credits-custom">Custom amount (USD)</Label>
							<div className="flex items-center gap-2">
								<Input
									className="max-w-40"
									id="credits-custom"
									inputMode="decimal"
									max={maxTopupDollars}
									min={minTopupDollars}
									onChange={(e) => onCustomAmountChange?.(e.target.value)}
									placeholder={`${minTopupDollars}–${maxTopupDollars}`}
									type="number"
									value={customAmount}
								/>
								<Button
									disabled={
										!customAmount.trim() ||
										(busyPack !== null && busyPack !== "custom")
									}
									loading={busyPack === "custom"}
									onClick={() => openTopupReview("custom")}
								>
									Top up
								</Button>
							</div>
							<p className="text-muted-foreground text-xs">
								You'll complete payment in your browser via Polar. The exact
								plan percentage or $2.75 minimum deposit fee is shown before
								payment; your wallet is credited the face value. Your balance
								updates here once it clears.
							</p>
						</div>
					</div>
				)}
			</section>

			<section className="mb-8">
				<h2 className="mb-3 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Activity
				</h2>
				{loading && ledger.length === 0 ? (
					<Spinner className="size-4" />
				) : ledger.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No activity yet. Top up to add credits.
					</p>
				) : (
					<div className="overflow-hidden rounded-lg border bg-card">
						<div className="divide-y">
							{ledger.map((entry) => (
								<div
									className="flex items-center justify-between px-4 py-3"
									key={entry.id}
								>
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<span className="font-medium text-sm">
												{entry.reasonLabel}
											</span>
											{entry.isCredit ? (
												<Badge className="text-[9px]" variant="secondary">
													Credit
												</Badge>
											) : null}
										</div>
										<p className="text-muted-foreground text-xs">
											{entry.createdAtLabel}
										</p>
									</div>
									<div className="flex flex-col items-end">
										<LedgerAmount currency={currency} row={entry} />
										<span className="font-heading text-muted-foreground text-xs tabular-nums">
											{formatMicroUsd(entry.balanceAfter, currency)}
										</span>
									</div>
								</div>
							))}
						</div>

						{totalPages > 1 ? (
							<div className="flex items-center justify-between border-t px-4 py-2">
								<span className="text-muted-foreground text-xs">
									Page {ledgerPage + 1} of {totalPages}
								</span>
								<div className="flex gap-1">
									<Button
										disabled={ledgerPage === 0}
										onClick={onPrevPage}
										size="sm"
										variant="ghost"
									>
										Previous
									</Button>
									<Button
										disabled={ledgerPage >= totalPages - 1}
										onClick={onNextPage}
										size="sm"
										variant="ghost"
									>
										Next
									</Button>
								</div>
							</div>
						) : null}
					</div>
				)}
				{ledger.length > 0 ? (
					<p className="mt-2 text-muted-foreground text-xs">
						Showing the most recent 50 entries.
					</p>
				) : null}
			</section>

			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setPendingTopup(null);
					}
				}}
				open={pendingTopup !== null}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Review credit top-up</DialogTitle>
						<DialogDescription>
							See how your organization balance changes before you leave Ryu for
							payment.
						</DialogDescription>
					</DialogHeader>
					<BeforeAfterSummary
						current={{
							amount: currentBalance,
							detail: "Available before checkout",
							eyebrow: "Current",
							label: "Wallet balance",
						}}
						footer={{
							detail:
								"A deposit fee is added at checkout; the full face value is credited.",
							label: "Credits added",
							value: pendingAmountLabel,
						}}
						next={{
							amount: balanceAfterTopup,
							detail: `${pendingAmountLabel} of prepaid usage credit`,
							eyebrow: "After top-up",
							label: "Wallet balance",
						}}
					/>
					<DialogFooter>
						<DialogClose render={<Button variant="ghost" />}>
							Cancel
						</DialogClose>
						<Button onClick={confirmTopup}>Continue to checkout</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
