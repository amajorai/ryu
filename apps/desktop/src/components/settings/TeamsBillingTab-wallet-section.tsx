import { CreditBalanceBreakdown } from "@ryu/ui/components/credit-balance-breakdown.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
	fetchSubscriptionStatus,
	fetchWallet,
} from "@/src/lib/api/teams-billing.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";
import { formatCreditExpiry } from "./TeamsBillingTab-pricing.ts";

interface ProviderAllocation {
	expiresAtLabel: string | null;
	id: string;
	isFreeProvider: boolean;
	label: string;
	remainingMicroUsd: number;
}

/** The organization's pooled wallet balance, split by credit source. */
export function TeamsBillingWalletSection({
	providerAllocations,
	subQuery,
	walletQuery,
}: {
	providerAllocations: ProviderAllocation[];
	subQuery: UseQueryResult<Awaited<ReturnType<typeof fetchSubscriptionStatus>>>;
	walletQuery: UseQueryResult<Awaited<ReturnType<typeof fetchWallet>>>;
}) {
	return (
		<SettingsSection title="Pooled wallet">
			{walletQuery.isLoading ? (
				<SettingsCard>
					<SkeletonRows />
				</SettingsCard>
			) : (
				// Grouped rows straight on the pane: the breakdown draws its own
				// cards, so wrapping it in another one would nest card in card.
				<CreditBalanceBreakdown
					appearance="grouped"
					balanceBreakdownAvailable={
						walletQuery.data?.wallet.balanceBreakdownAvailable
					}
					currency={walletQuery.data?.wallet.currency}
					giftCreditsMicroUsd={
						walletQuery.data?.wallet.giftBalanceMicroUsd ?? null
					}
					onDemandCreditsMicroUsd={
						walletQuery.data?.wallet.topupBalanceMicroUsd ?? null
					}
					planAllowanceMicroUsd={
						subQuery.data?.entitlement.monthlyCreditPoolMicroUsd ?? null
					}
					planCreditsMicroUsd={
						walletQuery.data?.wallet.subscriptionBalanceMicroUsd ?? null
					}
					providerAllocations={
						walletQuery.data?.wallet.balanceBreakdownAvailable === false
							? (walletQuery.data.wallet.providerAllocations?.map(
									(allocation) => ({
										expiresAtLabel: formatCreditExpiry(allocation.expiresAt),
										id: allocation.poolId,
										isFreeProvider: allocation.isFreeProvider,
										label: allocation.label,
										remainingMicroUsd: allocation.remainingMicroUsd,
									})
								) ?? null)
							: providerAllocations
					}
					totalMicroUsd={walletQuery.data?.wallet.balanceMicroUsd ?? null}
				/>
			)}
		</SettingsSection>
	);
}
