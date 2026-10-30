"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	amountLabel,
	BucketCard,
	FREE_CREDIT_USAGE_LINE,
	FreeCreditRow,
	finiteAmount,
	GROUPED_CAPTION_CLASS,
	GroupedCard,
	GroupedRow,
	InfoTooltip,
	nearestExpiryLabel,
} from "./credit-balance-breakdown-parts.tsx";

export { FREE_CREDIT_USAGE_LINE } from "./credit-balance-breakdown-parts.tsx";

/**
 * One free-credit grant balance ready for display. The breakdown folds every
 * allocation into ONE "Free credit" figure: free credit is spent automatically
 * on models marked Free, whichever campaign issued it.
 */
export interface CreditAllocationView {
	/** ISO expiry, used to pick the nearest one when allocations are folded. */
	expiresAt?: string | null;
	/** Pre-formatted expiry text, or null when the allocation does not expire. */
	expiresAtLabel?: string | null;
	id: string;
	/** True when this allocation is limited to an allocated free provider. */
	isFreeProvider: boolean;
	/** Ryu's user-facing capability label, never a provider vendor name. */
	label: string;
	remainingMicroUsd: number;
	/** Optional capability text such as "Fast, everyday models". */
	spendableOn?: string;
}

export interface CreditBalanceBreakdownProps {
	/**
	 * `settings`: the flat muted surface of the web settings pages (no outlines
	 * or tinted frame). `default` keeps the bordered card used on desktop.
	 * `grouped`: iOS-style grouped rows for a desktop Settings pane — one card
	 * level, buckets as hairline-separated rows instead of tiles in a panel.
	 */
	appearance?: "default" | "grouped" | "settings";
	/** False when the provider exposes one authoritative aggregate meter balance. */
	balanceBreakdownAvailable?: boolean;
	className?: string;
	/** Use the denser settings-card presentation. */
	compact?: boolean;
	currency?: string;
	/** Remaining redeemed gift balance; credit gifts expire and cards do not. */
	giftCreditsMicroUsd?: number | null;
	/** Remaining purchased credit; this balance rolls over. */
	onDemandCreditsMicroUsd: number | null;
	/** Full included plan allowance for the current billing period. */
	planAllowanceMicroUsd?: number | null;
	/** Remaining included plan credit for the current billing period. */
	planCreditsMicroUsd: number | null;
	/** Provider-specific allocations, or null while that read is unavailable. */
	providerAllocations?: CreditAllocationView[] | null;
	/** Current total, including every provider-specific allocation. */
	totalMicroUsd: number | null;
}

export function CreditBalanceBreakdown({
	balanceBreakdownAvailable = true,
	currency = "usd",
	totalMicroUsd,
	planCreditsMicroUsd,
	planAllowanceMicroUsd = null,
	onDemandCreditsMicroUsd,
	giftCreditsMicroUsd = null,
	providerAllocations = [],
	compact = false,
	appearance = "default",
	className,
}: CreditBalanceBreakdownProps) {
	const tl = useLiteralMessages();
	const flat = appearance === "settings";
	const allocations = (providerAllocations ?? []).filter(
		(allocation) => (finiteAmount(allocation.remainingMicroUsd) ?? 0) > 0
	);
	// ONE free-credit figure: every grant pays for any model marked Free, so a
	// per-allocation split would only invent distinctions for the user.
	const freeCreditMicroUsd = allocations.reduce(
		(total, allocation) =>
			total + (finiteAmount(allocation.remainingMicroUsd) ?? 0),
		0
	);
	const freeCreditExpiry = nearestExpiryLabel(allocations);
	const planAmount = finiteAmount(planCreditsMicroUsd);
	const planAllowance = finiteAmount(planAllowanceMicroUsd);
	const providerDataAvailable = providerAllocations !== null;
	const planDetail =
		planAmount === null
			? "Remaining plan balance is not available yet."
			: planAllowance !== null && planAllowance > 0
				? tl("{remaining} left of {allowance} this billing period", {
						remaining: amountLabel(planAmount, currency),
						allowance: amountLabel(planAllowance, currency),
					})
				: "Resets each billing period · unused credit does not roll over";

	if (appearance === "grouped") {
		const freeCreditAmount = providerDataAvailable
			? amountLabel(freeCreditMicroUsd, currency)
			: "—";
		const freeCreditDetail = providerDataAvailable
			? freeCreditMicroUsd > 0
				? (freeCreditExpiry ?? FREE_CREDIT_USAGE_LINE)
				: "No free credit right now"
			: "Free credit is unavailable right now";
		const freeCreditRow = {
			key: "free",
			node: (
				<GroupedRow
					amount={freeCreditAmount}
					detail={freeCreditDetail}
					label="Free credit"
					tooltip="Free credit comes from offers and referrals. It is used automatically, before your other credit, on models marked Free in the Ryu Router model list."
				/>
			),
		};
		return (
			<TooltipProvider delay={0}>
				<div
					className={cn("space-y-1.5", className)}
					data-slot="credit-balance-breakdown"
				>
					<GroupedCard
						rows={[
							{
								key: "total",
								node: (
									<GroupedRow
										amount={amountLabel(totalMicroUsd, currency)}
										amountClassName="text-xl"
										label="Available now"
										tooltip={
											balanceBreakdownAvailable
												? "Available now is the total of your free credit, plan credits, gift credits, and on-demand credits. Free credit is used first, automatically, on models marked Free."
												: "Available now is the total of Polar's shared meter and your free credit. Free credit is used first, automatically, on models marked Free."
										}
										tooltipLabel="About available credits"
										trailing={
											<span className="text-muted-foreground text-xs">
												{balanceBreakdownAvailable
													? "Shared wallet"
													: "Polar balance"}
											</span>
										}
									/>
								),
							},
						]}
					/>
					{balanceBreakdownAvailable ? (
						<>
							<p className={GROUPED_CAPTION_CLASS}>
								Free credit is spent first on models marked Free. Plan credit is
								next, then gift balance, then on-demand credit.
							</p>
							<GroupedCard
								rows={[
									freeCreditRow,
									{
										key: "plan",
										node: (
											<GroupedRow
												amount={amountLabel(planCreditsMicroUsd, currency)}
												detail={planDetail}
												label="Plan credits"
												tooltip="Plan credits come from the active plan and pay for any Ryu Router model once free credit is used or does not apply. They reset at the next billing period and unused plan credit does not roll over."
											/>
										),
									},
									{
										key: "gift",
										node: (
											<GroupedRow
												amount={amountLabel(giftCreditsMicroUsd, currency)}
												detail="Redeemed gift balance · expires on its gift window"
												label="Gift balance"
												tooltip="Gift balance is redeemed to your personal workspace. Credit gifts expire on their stated date; gift cards do not. It is spent before paid rollover credits."
											/>
										),
									},
									{
										key: "on-demand",
										node: (
											<GroupedRow
												amount={amountLabel(onDemandCreditsMicroUsd, currency)}
												detail="Purchased balance · rolls over between billing periods"
												label="On-demand credits"
												tooltip="On-demand credits are purchased by an organization owner or admin. They pay for any Ryu Router model once free and plan credit are used, and they roll over."
											/>
										),
									},
								]}
							/>
						</>
					) : (
						<>
							<p className={GROUPED_CAPTION_CLASS}>
								Polar maintains this aggregate credit meter. The balance above
								is the current provider-authoritative amount; Ryu does not split
								it into parallel local buckets.
							</p>
							{allocations.length > 0 ? (
								<GroupedCard rows={[freeCreditRow]} />
							) : null}
						</>
					)}
				</div>
			</TooltipProvider>
		);
	}

	return (
		<TooltipProvider delay={0}>
			<div
				className={cn("space-y-4", className)}
				data-slot="credit-balance-breakdown"
			>
				<div
					className={cn(
						flat
							? "rounded-lg bg-muted/40"
							: "rounded-xl border border-primary/20 bg-primary/[0.035]",
						compact ? "p-3" : "p-4"
					)}
				>
					<div className="flex items-start justify-between gap-3">
						<div>
							<div className="flex items-center gap-2">
								<p className="font-medium text-muted-foreground text-sm">
									Available now
								</p>
								<InfoTooltip label="About available credits">
									{balanceBreakdownAvailable
										? "Available now is the total of your free credit, plan credits, gift credits, and on-demand credits. Free credit is used first, automatically, on models marked Free."
										: "Available now is the total of Polar's shared meter and your free credit. Free credit is used first, automatically, on models marked Free."}
								</InfoTooltip>
							</div>
							<p className="mt-1 font-medium font-mono text-3xl tabular-nums">
								{amountLabel(totalMicroUsd, currency)}
							</p>
						</div>
						<span className="rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary text-xs">
							{balanceBreakdownAvailable ? "Shared wallet" : "Polar balance"}
						</span>
					</div>
					{balanceBreakdownAvailable ? (
						<>
							<p className="mt-2 max-w-2xl text-muted-foreground text-xs leading-relaxed">
								Free credit is spent first on models marked Free. Plan credit is
								next, then gift balance, then on-demand credit.
							</p>

							<div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
								<BucketCard
									amount={
										providerDataAvailable
											? amountLabel(freeCreditMicroUsd, currency)
											: "—"
									}
									detail={
										providerDataAvailable
											? freeCreditMicroUsd > 0
												? (freeCreditExpiry ?? FREE_CREDIT_USAGE_LINE)
												: "No free credit right now"
											: "Free credit is unavailable right now"
									}
									flat={flat}
									label="Free credit"
									tooltip="Free credit comes from offers and referrals. It is used automatically, before your other credit, on models marked Free in the Ryu Router model list."
								/>
								<BucketCard
									amount={amountLabel(planCreditsMicroUsd, currency)}
									detail={planDetail}
									flat={flat}
									label="Plan credits"
									tooltip="Plan credits come from the active plan and pay for any Ryu Router model once free credit is used or does not apply. They reset at the next billing period and unused plan credit does not roll over."
								/>
								<BucketCard
									amount={amountLabel(giftCreditsMicroUsd, currency)}
									detail="Redeemed gift balance · expires on its gift window"
									flat={flat}
									label="Gift balance"
									tooltip="Gift balance is redeemed to your personal workspace. Credit gifts expire on their stated date; gift cards do not. It is spent before paid rollover credits."
								/>
								<BucketCard
									amount={amountLabel(onDemandCreditsMicroUsd, currency)}
									detail="Purchased balance · rolls over between billing periods"
									flat={flat}
									label="On-demand credits"
									tooltip="On-demand credits are purchased by an organization owner or admin. They pay for any Ryu Router model once free and plan credit are used, and they roll over."
								/>
							</div>
						</>
					) : (
						<p className="mt-2 max-w-2xl text-muted-foreground text-xs leading-relaxed">
							Polar maintains this aggregate credit meter. The balance above is
							the current provider-authoritative amount; Ryu does not split it
							into parallel local buckets.
						</p>
					)}
				</div>

				{balanceBreakdownAvailable || allocations.length > 0 ? (
					<div
						className={cn(
							"space-y-3",
							flat ? "rounded-lg bg-muted/40 p-4" : "border-t pt-4"
						)}
					>
						<div className="flex items-start justify-between gap-3">
							<div>
								<p className="font-medium text-sm">Free credit</p>
								<p className="text-muted-foreground text-xs leading-relaxed">
									{FREE_CREDIT_USAGE_LINE}.
								</p>
							</div>
							<InfoTooltip label="How free credit works">
								Free credit is spent first, automatically, whenever you pick a
								model marked Free. Other models use your plan and on-demand
								credit.
							</InfoTooltip>
						</div>
						{providerDataAvailable ? (
							freeCreditMicroUsd > 0 ? (
								<FreeCreditRow
									amountMicroUsd={freeCreditMicroUsd}
									currency={currency}
									expiresAtLabel={freeCreditExpiry}
									flat={flat}
								/>
							) : (
								<p className="text-muted-foreground text-sm">
									No free credit right now.
								</p>
							)
						) : (
							<p className="text-muted-foreground text-sm">
								Free credit is temporarily unavailable.
							</p>
						)}
					</div>
				) : null}
			</div>
		</TooltipProvider>
	);
}
