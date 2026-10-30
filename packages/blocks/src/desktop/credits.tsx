"use client";

// Presentational layer of the desktop Credits settings tab, built from the
// shared grouped settings primitives (the dialog already renders the "Credits"
// title, so this view has no heading of its own). The live app
// (`apps/desktop/src/pages/CreditsPage.tsx`) is a thin container that loads the
// wallet via `useCreditsWallet()` and drives top-up checkout; the storyboard
// renders the same component with mock data and no-op handlers. One source of
// truth, so editing this block changes the real desktop too.

import {
	Add01Icon,
	Alert02Icon,
	Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
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
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Spinner } from "@ryu/ui/components/spinner";
import { formatCurrency } from "@ryu/ui/lib/number-format.ts";
import { useState } from "react";
import { LedgerAmount } from "./credits-ledger-amount.tsx";
import {
	type CreditsViewProps,
	formatMicroUsd,
	type PendingTopup,
	pendingTopupDollars,
} from "./credits-model.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";

export type {
	CreditEntitlementView,
	CreditGrantPoolView,
	CreditLedgerRow,
	CreditsViewProps,
	CreditWalletView,
} from "./credits-model.ts";
export { formatMicroUsd } from "./credits-model.ts";

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
	packs = [100, 250, 1000],
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
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
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
			<SettingsSection title="Credits">
				<SettingsCard className="flex flex-col items-center gap-3 py-6 text-center">
					<p className="text-muted-foreground text-sm">
						Sign in to view credits. Ryu credits are a prepaid balance on your
						organization.
					</p>
					{onSignIn ? (
						<Button onClick={onSignIn} size="sm">
							Sign in
						</Button>
					) : null}
				</SettingsCard>
			</SettingsSection>
		);
	}

	if (noOrgMessage) {
		return (
			<SettingsSection title="No organization selected">
				<SettingsCard className="flex flex-col items-center gap-3 py-6 text-center">
					<p className="text-muted-foreground text-sm">{noOrgMessage}</p>
					{onCreateOrganization ? (
						<Button onClick={onCreateOrganization} size="sm">
							Create or select an organization
						</Button>
					) : null}
				</SettingsCard>
			</SettingsSection>
		);
	}

	const primaryPack = packs[0];
	return (
		<div className="space-y-6">
			{walletEmpty ? (
				<SettingsGroup>
					<SettingsItem
						actions={
							primaryPack === undefined ? null : (
								<Button
									loading={busyPack === primaryPack}
									onClick={() => openTopupReview(primaryPack)}
									size="sm"
								>
									{busyPack !== primaryPack && (
										<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
									)}
									{tlRich(
										// biome-ignore lint/suspicious/noTemplateCurlyInString: ICU message with a literal dollar sign before the {primaryPack} placeholder.
										"Add <span>${primaryPack}</span> credits",
										{ primaryPack: String(primaryPack) },
										{ span: (c) => <span className="font-heading">{c}</span> }
									)}
								</Button>
							)
						}
						description="Managed (Ryu Cloud) inference is paused until you top up. Your included plan pool refills at the start of each billing period."
						title={
							<span className="flex items-center gap-2">
								<HugeiconsIcon
									className="size-4 shrink-0 text-status-warning"
									icon={Alert02Icon}
								/>
								Your credit balance is empty
							</span>
						}
					/>
				</SettingsGroup>
			) : null}

			<SettingsSection
				headerAction={
					<Button
						aria-label="Refresh balance"
						onClick={onRefresh}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-3.5" icon={Refresh01Icon} />
						Refresh
					</Button>
				}
				title="Balance"
			>
				{!(loading || wallet) && errorMessage ? (
					// A plain sentence; the loader's own message (which can be a
					// schema dump) stays in the tooltip.
					<SettingsCard className="flex items-center justify-between gap-3">
						<p className="text-muted-foreground text-sm" title={errorMessage}>
							Couldn't load your balance.
						</p>
						{onRefresh ? (
							<Button
								className="shrink-0"
								onClick={onRefresh}
								size="sm"
								variant="outline"
							>
								Retry
							</Button>
						) : null}
					</SettingsCard>
				) : null}
				<CreditBalanceBreakdown
					appearance="grouped"
					balanceBreakdownAvailable={wallet?.balanceBreakdownAvailable}
					currency={currency}
					giftCreditsMicroUsd={wallet?.giftBalanceMicroUsd ?? null}
					onDemandCreditsMicroUsd={wallet?.topupBalanceMicroUsd ?? null}
					planAllowanceMicroUsd={entitlement?.monthlyCreditPoolMicroUsd ?? null}
					planCreditsMicroUsd={wallet?.subscriptionBalanceMicroUsd ?? null}
					providerAllocations={
						wallet?.balanceBreakdownAvailable === false
							? (wallet.providerAllocations ?? null)
							: wallet && !grantPoolsLoading
								? grantPools.map<CreditAllocationView>((pool) => ({
										expiresAt: pool.expiresAt,
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
			</SettingsSection>

			<SettingsSection
				caption={
					billingUnavailable
						? undefined
						: "You'll complete payment in your browser via Polar. The exact plan percentage or $5 minimum deposit fee is shown before payment, and Ryu keeps at most $10 of it; your wallet is credited the face value. Your balance updates here once it clears."
				}
				title="Add credits"
			>
				{billingUnavailable ? (
					<SettingsCard>
						<p className="text-muted-foreground text-sm">
							Credit top-up is unavailable: billing is not configured.
						</p>
					</SettingsCard>
				) : (
					<SettingsGroup>
						<SettingsItem
							actions={
								<div className="flex flex-wrap justify-end gap-2">
									{packs.map((pack) => (
										<Button
											key={pack}
											loading={busyPack === pack}
											onClick={() => openTopupReview(pack)}
											size="sm"
											variant="outline"
										>
											{busyPack !== pack && (
												<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
											)}
											<span className="font-heading">
												{formatCurrency(pack, currency, {
													maximumFractionDigits: 0,
													minimumFractionDigits: 0,
												})}
											</span>
										</Button>
									))}
								</div>
							}
							description="Presets add their face value. The server quotes the deposit fee before checkout; eligible plans use their plan-based fee rate."
							title="Presets"
						/>
						<SettingsItem
							actions={
								<div className="flex items-center gap-2">
									<Input
										className="h-8 w-32"
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
										size="sm"
									>
										Top up
									</Button>
								</div>
							}
							title={
								<Label className="font-normal" htmlFor="credits-custom">
									Custom amount (USD)
								</Label>
							}
						/>
					</SettingsGroup>
				)}
			</SettingsSection>

			<SettingsSection
				caption={
					ledger.length > 0 ? "Showing the most recent 50 entries." : undefined
				}
				title="Activity"
			>
				{loading && ledger.length === 0 ? (
					<SettingsCard className="flex justify-center">
						<Spinner className="size-4" />
					</SettingsCard>
				) : ledger.length === 0 ? (
					<SettingsCard>
						<p className="text-center text-muted-foreground text-sm">
							No activity yet. Top up to add credits.
						</p>
					</SettingsCard>
				) : (
					<SettingsGroup>
						{ledger.map((entry) => (
							<SettingsItem
								actions={
									<div className="flex flex-col items-end">
										<LedgerAmount currency={currency} row={entry} />
										<span className="font-heading text-muted-foreground text-xs tabular-nums">
											{formatMicroUsd(entry.balanceAfter, currency)}
										</span>
									</div>
								}
								key={entry.id}
								title={
									<span className="flex min-w-0 items-center gap-2">
										<span className="truncate">{entry.reasonLabel}</span>
										{entry.isCredit ? (
											<Badge typography="micro" variant="secondary">
												Credit
											</Badge>
										) : null}
									</span>
								}
							>
								<p className="text-muted-foreground text-xs">
									{entry.createdAtLabel}
								</p>
							</SettingsItem>
						))}
						{totalPages > 1 ? (
							<SettingsItem
								actions={
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
								}
								key="pagination"
								title={
									<span className="text-muted-foreground text-xs">
										{tl("Page {page} of {totalPages}", {
											page: String(ledgerPage + 1),
											totalPages: String(totalPages),
										})}
									</span>
								}
							/>
						) : null}
					</SettingsGroup>
				)}
			</SettingsSection>

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
							detail: tl("{pendingAmountLabel} of prepaid usage credit", {
								pendingAmountLabel,
							}),
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
