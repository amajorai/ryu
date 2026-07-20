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
import { Button } from "@ryu/ui/components/button";
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

/** Pure micro-USD → currency formatter, copied from `@/src/lib/api/credits`
 *  so the block stays free of app imports. */
export function formatMicroUsd(microUsd: number, currency = "usd"): string {
	return (microUsd / 1_000_000).toLocaleString(undefined, {
		style: "currency",
		currency: currency.toUpperCase(),
		minimumFractionDigits: 2,
		maximumFractionDigits: 4,
	});
}

export interface CreditWalletView {
	balanceMicroUsd: number;
	currency: string;
}

export interface CreditEntitlementView {
	managedInference: boolean;
	monthlyCreditPoolMicroUsd: number;
	plan: string | null;
	planLabel?: string;
	seats: number;
}

export interface CreditLedgerRow {
	balanceAfter: number;
	createdAtLabel: string;
	delta: number;
	id: string;
	isCredit: boolean;
	reasonLabel: string;
}

export interface CreditsViewProps {
	authed?: boolean;
	billingUnavailable?: boolean;
	busyPack?: number | "custom" | null;
	customAmount?: string;
	entitlement?: CreditEntitlementView | null;
	/** Generic balance-load error message. */
	errorMessage?: string | null;
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
			className={`font-medium text-sm tabular-nums ${
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
}: CreditsViewProps) {
	const currency = wallet?.currency ?? "usd";

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
				<h1 className="font-semibold text-xl">Credits</h1>
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
							disabled={busyPack !== null}
							onClick={() => onTopupPack?.(packs[0])}
							size="sm"
						>
							{busyPack === packs[0] ? (
								<Spinner className="mr-2 size-3.5" />
							) : (
								<HugeiconsIcon className="mr-2 size-3.5" icon={Add01Icon} />
							)}
							Add ${packs[0]} credits
						</Button>
					</div>
				</div>
			) : null}

			{entitlement?.managedInference && entitlement.plan ? (
				<section className="mb-8">
					<h2 className="mb-3 font-medium text-muted-foreground text-sm uppercase tracking-wide">
						Plan
					</h2>
					<div className="rounded-lg border bg-card p-5">
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0">
								<p className="font-medium text-sm">
									{entitlement.planLabel ?? entitlement.plan}
								</p>
								<p className="mt-0.5 text-muted-foreground text-xs">
									Includes{" "}
									<span className="font-medium text-foreground tabular-nums">
										{formatMicroUsd(
											entitlement.monthlyCreditPoolMicroUsd,
											currency
										)}
									</span>{" "}
									of credits per month
									{entitlement.seats > 1
										? ` across ${entitlement.seats} seats`
										: ""}
									. Added to your balance each billing period.
								</p>
							</div>
							<Badge className="shrink-0" variant="secondary">
								Managed inference
							</Badge>
						</div>
					</div>
				</section>
			) : null}

			<section className="mb-8">
				<h2 className="mb-3 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Balance
				</h2>
				<div className="rounded-lg border bg-card p-5">
					{loading && !wallet ? (
						<Spinner className="size-5" />
					) : (
						<div className="flex items-baseline gap-2">
							<HugeiconsIcon
								className="size-6 text-muted-foreground"
								icon={DollarCircleIcon}
							/>
							<span className="font-semibold text-3xl tabular-nums">
								{wallet
									? formatMicroUsd(wallet.balanceMicroUsd, currency)
									: "—"}
							</span>
							<span className="text-muted-foreground text-sm uppercase">
								{currency}
							</span>
						</div>
					)}
					{!(loading || wallet) && errorMessage ? (
						<p className="mt-2 text-destructive text-xs">
							Could not load your balance: {errorMessage}
						</p>
					) : null}
					<p className="mt-2 text-muted-foreground text-xs">
						Credits pay for AI usage as you go. They are non-refundable.
					</p>
				</div>
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
									disabled={busyPack !== null}
									key={pack}
									onClick={() => onTopupPack?.(pack)}
									variant="outline"
								>
									{busyPack === pack ? (
										<Spinner className="mr-2 size-3.5" />
									) : (
										<HugeiconsIcon className="mr-2 size-3.5" icon={Add01Icon} />
									)}
									${pack}
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
									disabled={busyPack !== null || !customAmount.trim()}
									onClick={onTopupCustom}
								>
									{busyPack === "custom" ? (
										<Spinner className="mr-2 size-3.5" />
									) : null}
									Top up
								</Button>
							</div>
							<p className="text-muted-foreground text-xs">
								You'll complete payment in your browser via Polar. A 6% + $1.00
								deposit fee is added at checkout; your wallet is credited the
								face value. Your balance updates here once it clears.
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
										<span className="text-muted-foreground text-xs tabular-nums">
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
		</div>
	);
}
