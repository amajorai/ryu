// apps/desktop/src/pages/CreditsPage.tsx
//
// Thin container for the desktop Credits (platform wallet) page. Loads the wallet
// via `useCreditsWallet()`, drives Polar top-up checkout, and renders the shared
// presentational `CreditsView` (`@ryu/blocks/desktop/credits`) — the same view
// the storyboard renders with mock data.
//
// The wallet lives in the control-plane server (lib/api/credits.ts -> :3000),
// authed with the Better-Auth session bearer (org-level). Top-up opens a Polar
// checkout URL externally; the wallet is credited the FACE value asynchronously
// by the server webhook, so the balance is re-fetched on focus + the Refresh
// button. Everything degrades cleanly when not signed in, when there is no active
// org, or when billing is not configured.

import { CREDIT_POOLS, type CreditPoolTier } from "@ryu/auth/lib/credit-pools";
import {
	type CreditGrantPoolView,
	type CreditLedgerRow,
	CreditsView,
} from "@ryu/blocks/desktop/credits.tsx";
import { formatMinorCurrency } from "@ryu/ui/lib/number-format.ts";
import { useCallback, useMemo, useState } from "react";
import { sileo } from "sileo";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { OrgBillingContext } from "@/src/components/billing/OrgBillingContext.tsx";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { CreditTransferCard } from "@/src/components/settings/CreditTransferCard.tsx";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import {
	CREDIT_LEDGER_REASONS,
	CREDIT_PACKS,
	type CreditPack,
	type CreditsError,
	createTopup,
	LEDGER_REASON_LABELS,
	MAX_TOPUP_DOLLARS,
	MIN_TOPUP_DOLLARS,
} from "@/src/lib/api/credits.ts";
import { formatDate, formatDateTime } from "@/src/lib/timezone.ts";

/** A plan id → human label, for the included-pool line. */
const PLAN_LABELS: Record<string, string> = {
	"desktop-license": "Ryu Desktop",
	pro: "Ryu Pro",
	max: "Ryu Max",
	teams: "Ryu Teams",
};

const LEDGER_PAGE_SIZE = 10;

/**
 * What a pool's granted credit buys, in the user's language.
 *
 * Written HERE and not read from `CreditPool.description`, which is explicitly
 * operator-facing and names the vendor behind each pool (Cloudflare, Llama, AWS
 * Bedrock, Claude). The pool catalog's headline invariant is that a user never
 * sees a provider — the pool's `label` plus a capability phrase is the whole
 * vocabulary. An unrecognized pool id gets no phrase at all rather than a
 * guessed one; the label and the amount are still truthful on their own.
 *
 * The residual `default` tier is deliberately absent. It has no capability story
 * to tell — and the obvious phrase ("any model Ryu offers") would be a lie about
 * money: a grant against that pool is restricted to its own supply exactly like
 * every other grant.
 */
const POOL_SPENDABLE_ON: Partial<Record<CreditPoolTier, string>> = {
	free: "Fast, everyday models",
	frontier: "The most capable models",
};

/** `null` for a missing or unparseable timestamp — a grant with no readable
 *  expiry renders as one with no expiry, never as "Invalid Date". */
function formatExpiry(iso: string | null): string | null {
	if (!iso) {
		return null;
	}
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) {
		return null;
	}
	return `Expires ${formatDate(at, {
		year: "numeric",
		month: "short",
		day: "numeric",
	})}`;
}

/** Where a solo user goes to create or pick an organization. */
const ORGANIZATIONS_URL = `${FRONTEND_URL.replace(/\/$/, "")}/organizations`;

export default function CreditsPage() {
	const {
		wallet,
		ledger,
		entitlement,
		grantPools,
		loading: grantsLoading,
		walletEmpty,
		loading,
		error,
		authed,
		refresh,
	} = useCreditsWallet();

	const [customAmount, setCustomAmount] = useState("");
	const [busyPack, setBusyPack] = useState<CreditPack | "custom" | null>(null);
	const [ledgerPage, setLedgerPage] = useState(0);
	const [billingUnavailable, setBillingUnavailable] = useState(false);
	const stepUp = useStepUp();

	const totalPages = Math.max(1, Math.ceil(ledger.length / LEDGER_PAGE_SIZE));
	const safeLedgerPage = Math.min(ledgerPage, totalPages - 1);

	const startTopup = useCallback(
		async (input: { pack?: CreditPack; amountCents?: number }) => {
			setBusyPack(input.pack ?? "custom");
			try {
				const topup = await stepUp.guard("billing", () => createTopup(input));
				if (topup === null) {
					return;
				}
				const { url, quote } = topup;
				await openExternal(url);
				const feeNote = quote
					? ` ${formatMinorCurrency(quote.faceCents)} credited, ${formatMinorCurrency(quote.feeCents)} deposit fee (${formatMinorCurrency(quote.chargeCents)} charged).`
					: "";
				sileo.success({
					title: "Opening checkout…",
					description: `Complete payment in your browser.${feeNote} Your balance updates here once it clears.`,
				});
			} catch (e) {
				const isBilling =
					e instanceof Error && (e as CreditsError).kind === "billing";
				if (isBilling) {
					setBillingUnavailable(true);
				}
				sileo.error({
					title: "Couldn't start checkout",
					description: isBilling
						? "Top-ups aren't available right now. Please try again later."
						: "Something went wrong opening the payment page. Please try again.",
				});
			} finally {
				setBusyPack(null);
			}
		},
		[stepUp]
	);

	const handleCustomTopup = useCallback(() => {
		const dollars = Number.parseFloat(customAmount);
		if (!Number.isFinite(dollars) || dollars <= 0) {
			sileo.error({ title: "Enter a valid amount." });
			return;
		}
		if (dollars < MIN_TOPUP_DOLLARS || dollars > MAX_TOPUP_DOLLARS) {
			sileo.error({
				title: `Amount must be between $${MIN_TOPUP_DOLLARS} and $${MAX_TOPUP_DOLLARS}.`,
			});
			return;
		}
		Promise.resolve(
			startTopup({ amountCents: Math.round(dollars * 100) })
		).catch(() => undefined);
	}, [customAmount, startTopup]);

	const pagedLedger = useMemo<CreditLedgerRow[]>(() => {
		const start = safeLedgerPage * LEDGER_PAGE_SIZE;
		return ledger.slice(start, start + LEDGER_PAGE_SIZE).map((entry) => ({
			id: entry.id,
			reasonLabel: LEDGER_REASON_LABELS[entry.reason] ?? entry.reason,
			isCredit: CREDIT_LEDGER_REASONS.includes(entry.reason),
			delta: entry.delta,
			balanceAfter: entry.balanceAfter,
			createdAtLabel: formatDateTime(entry.createdAt, {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			}),
		}));
	}, [ledger, safeLedgerPage]);

	// The server owns the pool label (it may know pools this build does not); the
	// local catalog only contributes the capability phrase, and contributes
	// nothing when the id is unknown here.
	//
	// The label doubles as the row key when the id is unknown, and that is sound
	// rather than lucky: the server AGGREGATES a wallet's grants by pool label
	// (`remainingByPool` in `readMyCampaigns`), so a label appears at most once in
	// a response.
	const grantPoolViews = useMemo<CreditGrantPoolView[]>(
		() =>
			grantPools.map((pool) => ({
				id: pool.poolId ?? pool.label,
				label: pool.label,
				remainingMicroUsd: pool.remainingMicroUsd,
				isFreeProvider: pool.isFreeProvider,
				spendableOn: pool.poolId
					? POOL_SPENDABLE_ON[CREDIT_POOLS[pool.poolId].tier]
					: undefined,
				expiresAtLabel: formatExpiry(pool.expiresAt),
			})),
		[grantPools]
	);

	const noOrgMessage =
		error !== null && (error as CreditsError).kind === "no_org"
			? error.message
			: null;

	return (
		<div className="space-y-4">
			<OrgBillingContext description="Shared credits for managed inference, top-ups, and organization usage." />
			<CreditsView
				authed={authed}
				billingUnavailable={billingUnavailable}
				busyPack={busyPack}
				customAmount={customAmount}
				entitlement={
					entitlement
						? {
								managedInference: entitlement.managedInference,
								monthlyCreditPoolMicroUsd:
									entitlement.monthlyCreditPoolMicroUsd,
								plan: entitlement.plan,
								planLabel: entitlement.plan
									? (PLAN_LABELS[entitlement.plan] ?? entitlement.plan)
									: undefined,
								seats: entitlement.seats,
							}
						: null
				}
				errorMessage={error ? error.message : null}
				grantPools={grantPoolViews}
				grantPoolsLoading={grantsLoading}
				ledger={pagedLedger}
				ledgerPage={safeLedgerPage}
				loading={loading}
				maxTopupDollars={MAX_TOPUP_DOLLARS}
				minTopupDollars={MIN_TOPUP_DOLLARS}
				noOrgMessage={noOrgMessage}
				onCreateOrganization={() => {
					openExternal(ORGANIZATIONS_URL).catch(() => undefined);
				}}
				onCustomAmountChange={setCustomAmount}
				onNextPage={() =>
					setLedgerPage(Math.min(totalPages - 1, safeLedgerPage + 1))
				}
				onPrevPage={() => setLedgerPage(Math.max(0, safeLedgerPage - 1))}
				onRefresh={() => {
					refresh().catch(() => undefined);
				}}
				onSignIn={() => {
					openExternal(`${FRONTEND_URL.replace(/\/$/, "")}/login`).catch(
						() => undefined
					);
				}}
				onTopupCustom={handleCustomTopup}
				onTopupPack={(pack) => {
					void startTopup({ pack: pack as CreditPack }).catch(() => undefined);
				}}
				packs={[...CREDIT_PACKS]}
				totalPages={totalPages}
				wallet={
					wallet
						? {
								balanceMicroUsd: wallet.balanceMicroUsd,
								currency: wallet.currency,
								subscriptionBalanceMicroUsd: wallet.subscriptionBalanceMicroUsd,
								topupBalanceMicroUsd: wallet.topupBalanceMicroUsd,
							}
						: null
				}
				walletEmpty={walletEmpty}
			/>
			{/* Rendered BESIDE `CreditsView` rather than inside it: the view is the
			    shared presentational block the storyboard renders with mock data, and
			    a transfer form needs live org membership and a mutation. Keeping it
			    out preserves the block's "no data fetching" contract. */}
			<CreditTransferCard />
			{stepUp.dialog}
		</div>
	);
}
