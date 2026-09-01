"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatMicroUsd } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Info } from "lucide-react";

/** A provider-specific credit allocation ready for display. */
export interface CreditAllocationView {
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
	className?: string;
	/** Use the denser settings-card presentation. */
	compact?: boolean;
	currency?: string;
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

function finiteAmount(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return value;
}

function amountLabel(
	value: number | null | undefined,
	currency: string
): string {
	const amount = finiteAmount(value);
	return amount === null ? "—" : formatMicroUsd(amount, currency);
}

function InfoTooltip({ label, children }: { label: string; children: string }) {
	return (
		<Tooltip>
			<TooltipTrigger
				aria-label={label}
				className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				type="button"
			>
				<Info aria-hidden="true" className="size-3.5" />
			</TooltipTrigger>
			<TooltipContent className="max-w-80 whitespace-normal leading-relaxed">
				<p>{children}</p>
			</TooltipContent>
		</Tooltip>
	);
}

function BucketCard({
	amount,
	detail,
	label,
	tooltip,
}: {
	amount: string;
	detail: string;
	label: string;
	tooltip: string;
}) {
	return (
		<div className="rounded-lg border bg-background/60 p-3">
			<div className="flex items-start justify-between gap-2">
				<p className="font-medium text-sm">{label}</p>
				<InfoTooltip label={`About ${label.toLowerCase()}`}>
					{tooltip}
				</InfoTooltip>
			</div>
			<p className="mt-2 font-mono font-semibold text-xl tabular-nums">
				{amount}
			</p>
			<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
				{detail}
			</p>
		</div>
	);
}

function AllocationRow({
	allocation,
	currency,
}: {
	allocation: CreditAllocationView;
	currency: string;
}) {
	const restrictions = [
		allocation.isFreeProvider
			? "Allocated free provider only"
			: "Allocated provider only",
		allocation.spendableOn,
		allocation.expiresAtLabel,
	].filter(Boolean);

	return (
		<div className="flex items-start justify-between gap-3 rounded-lg border bg-background/50 px-3 py-2.5">
			<div className="min-w-0">
				<p className="break-words font-medium text-sm">{allocation.label}</p>
				<p className="text-muted-foreground text-xs leading-relaxed">
					{restrictions.join(" · ")}
				</p>
			</div>
			<span className="shrink-0 font-medium font-mono text-sm tabular-nums">
				{amountLabel(allocation.remainingMicroUsd, currency)}
			</span>
		</div>
	);
}

export function CreditBalanceBreakdown({
	currency = "usd",
	totalMicroUsd,
	planCreditsMicroUsd,
	planAllowanceMicroUsd = null,
	onDemandCreditsMicroUsd,
	providerAllocations = [],
	compact = false,
	className,
}: CreditBalanceBreakdownProps) {
	const allocations = (providerAllocations ?? []).filter(
		(allocation) => (finiteAmount(allocation.remainingMicroUsd) ?? 0) > 0
	);
	const freeAllocations = allocations.filter(
		(allocation) => allocation.isFreeProvider
	);
	const otherAllocations = allocations.filter(
		(allocation) => !allocation.isFreeProvider
	);
	const freeProviderCredits = freeAllocations.reduce(
		(total, allocation) =>
			total + (finiteAmount(allocation.remainingMicroUsd) ?? 0),
		0
	);
	const planAmount = finiteAmount(planCreditsMicroUsd);
	const planAllowance = finiteAmount(planAllowanceMicroUsd);
	const providerDataAvailable = providerAllocations !== null;
	const planDetail =
		planAmount === null
			? "Remaining plan balance is not available yet."
			: planAllowance !== null && planAllowance > 0
				? `${amountLabel(planAmount, currency)} left of ${amountLabel(planAllowance, currency)} this billing period`
				: "Resets each billing period · unused credit does not roll over";

	return (
		<TooltipProvider delay={0}>
			<div
				className={cn("space-y-4", className)}
				data-slot="credit-balance-breakdown"
			>
				<div
					className={cn(
						"rounded-xl border border-primary/20 bg-primary/[0.035]",
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
									Available now is the total of your remaining plan credits,
									on-demand credits, and provider-specific allocations. A
									provider-specific allocation only pays for its assigned
									provider.
								</InfoTooltip>
							</div>
							<p className="mt-1 font-mono font-semibold text-3xl tabular-nums">
								{amountLabel(totalMicroUsd, currency)}
							</p>
						</div>
						<span className="rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary text-xs">
							Shared wallet
						</span>
					</div>
					<p className="mt-2 max-w-2xl text-muted-foreground text-xs leading-relaxed">
						Matching provider-specific credit is spent first. Plan credit is
						next, then on-demand credit.
					</p>

					<div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<BucketCard
							amount={
								providerDataAvailable
									? amountLabel(freeProviderCredits, currency)
									: "—"
							}
							detail={
								providerDataAvailable
									? freeAllocations.length > 0
										? `${freeAllocations.length} allocation${freeAllocations.length === 1 ? "" : "s"} listed below`
										: "No active free-provider allocation"
									: "Allocation details are unavailable"
							}
							label="Free-provider credits"
							tooltip="Free-provider credits are separate allocations. Each allocation can only be used with its assigned free provider; it cannot pay for another provider."
						/>
						<BucketCard
							amount={amountLabel(planCreditsMicroUsd, currency)}
							detail={planDetail}
							label="Plan credits"
							tooltip="Plan credits come from the active plan. Use them for managed provider usage beyond a free-provider allocation. They reset at the next billing period and unused plan credit does not roll over."
						/>
						<BucketCard
							amount={amountLabel(onDemandCreditsMicroUsd, currency)}
							detail="Purchased balance · rolls over between billing periods"
							label="On-demand credits"
							tooltip="On-demand credits are purchased by an organization owner or admin. Use them for managed provider usage beyond a free-provider allocation. They roll over and are not tied to one provider."
						/>
					</div>
				</div>

				<div className="space-y-3 border-t pt-4">
					<div className="flex items-start justify-between gap-3">
						<div>
							<p className="font-medium text-sm">Free-provider allocations</p>
							<p className="text-muted-foreground text-xs leading-relaxed">
								Each row shows how much remains for that allocated free
								provider.
							</p>
						</div>
						<InfoTooltip label="How free-provider allocations work">
							These balances stay separate because free-provider credit is
							reserved for the allocated provider. Plan and on-demand credit are
							the flexible managed balance for managed usage beyond that
							allocation; matching free-provider credit is spent first when it
							is available.
						</InfoTooltip>
					</div>
					{providerDataAvailable ? (
						freeAllocations.length > 0 ? (
							<div className="grid gap-2 sm:grid-cols-2">
								{freeAllocations.map((allocation) => (
									<AllocationRow
										allocation={allocation}
										currency={currency}
										key={allocation.id}
									/>
								))}
							</div>
						) : (
							<p className="text-muted-foreground text-sm">
								No free-provider credits are currently allocated.
							</p>
						)
					) : (
						<p className="text-muted-foreground text-sm">
							Free-provider allocations are temporarily unavailable.
						</p>
					)}

					{otherAllocations.length > 0 ? (
						<div className="space-y-2 pt-1">
							<div className="flex items-center gap-2">
								<p className="font-medium text-sm">
									Other provider-specific allocations
								</p>
								<InfoTooltip label="About other provider-specific allocations">
									These credits are also restricted to the provider allocation
									named by each row. They are included in the total but cannot
									be used by a different provider.
								</InfoTooltip>
							</div>
							<div className="grid gap-2 sm:grid-cols-2">
								{otherAllocations.map((allocation) => (
									<AllocationRow
										allocation={allocation}
										currency={currency}
										key={allocation.id}
									/>
								))}
							</div>
						</div>
					) : null}
				</div>
			</div>
		</TooltipProvider>
	);
}
