// apps/desktop/src/lib/api/credits-wallet.ts
//
// Wallet, ledger-entry and usage-statement shapes for the platform-credits
// client (split from credits.ts).

/** The materialized prepaid balance for the caller's active org. */
export interface CreditWallet {
	/** Unrestricted balance less open credit holds (what a new send can use). */
	availableMicroUsd?: number;
	/** False when Polar returns only the aggregate meter balance. */
	balanceBreakdownAvailable?: boolean;
	balanceMicroUsd: number;
	currency: string;
	/** Remaining redeemed gift credit; each gift has its own expiry. */
	giftBalanceMicroUsd?: number | null;
	/** Money held by open credit holds, such as in-flight Messaging sends. */
	heldMicroUsd?: number;
	id: string;
	ownerId: string;
	ownerType: string;
	providerAllocations?: CreditProviderAllocation[];
	/** `polar` means Polar owns the provider balance; `local` is legacy mode. */
	source?: string;
	/** Remaining included plan credit for the current billing period. */
	subscriptionBalanceMicroUsd: number | null;
	/** Remaining purchased credit; this balance rolls over. */
	topupBalanceMicroUsd: number | null;
	/** Polar aggregate meter balance available for any provider. */
	unrestrictedBalanceMicroUsd?: number;
	updatedAt: string;
}

/**
 * Spendable balance for retail managed providers. Pool-restricted grants are
 * deliberately excluded; the provider-specific pool path handles those.
 */
export function unrestrictedCreditBalanceMicroUsd(
	wallet: CreditWallet | null
): number {
	if (!wallet) {
		return 0;
	}
	if (wallet.unrestrictedBalanceMicroUsd !== undefined) {
		return Math.max(0, wallet.unrestrictedBalanceMicroUsd);
	}
	if (wallet.balanceBreakdownAvailable === false) {
		return Math.max(0, wallet.balanceMicroUsd);
	}
	return Math.max(
		0,
		(wallet.subscriptionBalanceMicroUsd ?? 0) +
			(wallet.topupBalanceMicroUsd ?? 0) +
			(wallet.giftBalanceMicroUsd ?? 0)
	);
}

export interface CreditProviderAllocation {
	expiresAt: string | null;
	isFreeProvider: boolean;
	label: string;
	poolId: string;
	remainingMicroUsd: number;
}

/** One append-only ledger entry (credit or debit). */
export interface LedgerEntry {
	balanceAfter: number;
	createdAt: string;
	/** Signed micro-USD change: positive for top-ups, negative for usage. */
	delta: number;
	/** Wall-clock ms the billed work took; null when not measured. */
	durationMs: number | null;
	/** Whether the amount came from a provider/catalog estimate. */
	estimated: boolean | null;
	id: string;
	inputTokens: number | null;
	/** Model or resource id that produced the charge. */
	model: string | null;
	orgId: string | null;
	outputTokens: number | null;
	/** Provider Gateway charged through (for example, `openrouter`). */
	provider: string | null;
	reason: string;
	refId: string | null;
	/** Human-facing label for what the spend was for. */
	taskLabel: string | null;
	/** Provider selected behind OpenRouter when it reported routing metadata. */
	upstreamProvider: string | null;
	userId: string | null;
	walletId: string;
}

/** One grouped row of a usage breakdown. */
export interface UsageBreakdownRow {
	/** Micro-USD SPENT, as a positive number. */
	amountMicroUsd: number;
	count: number;
	key: string | null;
}

/** Aggregates for a usage window. */
export interface UsageStats {
	byModel: UsageBreakdownRow[];
	byProvider: UsageBreakdownRow[];
	byReason: UsageBreakdownRow[];
	creditedMicroUsd: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	spentMicroUsd: number;
	transactions: number;
}

/** The `/usage` response: one keyset page plus the window's aggregates. */
export interface UsageResponse {
	entries: LedgerEntry[];
	/** Pass back as `before` for the next page; null when exhausted. */
	nextCursor: string | null;
	stats: UsageStats;
}

/** Filters accepted by `/usage`. All optional. */
export interface UsageFilters {
	before?: string | null;
	limit?: number;
	model?: string | null;
	provider?: string | null;
	reason?: string | null;
	since?: string | null;
	until?: string | null;
}

/** The `/wallet` response: balance + a newest-first window of the ledger. */
export interface WalletResponse {
	ledger: LedgerEntry[];
	wallet: CreditWallet;
}
