import { formatMicroUsd as formatSharedMicroUsd } from "@ryu/ui/lib/number-format.ts";

/** Pure micro-USD → currency formatter, copied from `@/src/lib/api/credits`
 *  so the block stays free of app imports. */
export function formatMicroUsd(microUsd: number, currency = "usd"): string {
	return formatSharedMicroUsd(microUsd, currency);
}

export interface CreditWalletView {
	balanceBreakdownAvailable?: boolean;
	balanceMicroUsd: number;
	currency: string;
	giftBalanceMicroUsd?: number | null;
	providerAllocations?: CreditGrantPoolView[];
	source?: string;
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
	/** ISO expiry, so the folded free-credit figure can show the nearest one. */
	expiresAt?: string | null;
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

export type PendingTopup = number | "custom";

export function pendingTopupDollars(
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
