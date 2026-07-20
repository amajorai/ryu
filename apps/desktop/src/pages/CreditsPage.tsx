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

import { type CreditLedgerRow, CreditsView } from "@ryu/blocks/desktop/credits";
import { useCallback, useMemo, useState } from "react";
import { sileo } from "sileo";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
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

/** A plan id → human label, for the included-pool line. */
const PLAN_LABELS: Record<string, string> = {
	"desktop-license": "Ryu Desktop",
	pro: "Ryu Pro",
	max: "Ryu Max",
	teams: "Ryu Teams",
};

const LEDGER_PAGE_SIZE = 10;

/** Where a solo user goes to create or pick an organization. */
const ORGANIZATIONS_URL = `${FRONTEND_URL.replace(/\/$/, "")}/organizations`;

export default function CreditsPage() {
	const {
		wallet,
		ledger,
		entitlement,
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

	const totalPages = Math.max(1, Math.ceil(ledger.length / LEDGER_PAGE_SIZE));
	const safeLedgerPage = Math.min(ledgerPage, totalPages - 1);

	const startTopup = useCallback(
		async (input: { pack?: CreditPack; amountCents?: number }) => {
			setBusyPack(input.pack ?? "custom");
			try {
				const { url, quote } = await createTopup(input);
				await openExternal(url);
				const feeNote = quote
					? ` $${(quote.faceCents / 100).toFixed(2)} credited, $${(quote.feeCents / 100).toFixed(2)} deposit fee ($${(quote.chargeCents / 100).toFixed(2)} charged).`
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
		[]
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
			createdAtLabel: new Date(entry.createdAt).toLocaleString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			}),
		}));
	}, [ledger, safeLedgerPage]);

	const noOrgMessage =
		error !== null && (error as CreditsError).kind === "no_org"
			? error.message
			: null;

	return (
		<CreditsView
			authed={authed}
			billingUnavailable={billingUnavailable}
			busyPack={busyPack}
			customAmount={customAmount}
			entitlement={
				entitlement
					? {
							managedInference: entitlement.managedInference,
							monthlyCreditPoolMicroUsd: entitlement.monthlyCreditPoolMicroUsd,
							plan: entitlement.plan,
							planLabel: entitlement.plan
								? (PLAN_LABELS[entitlement.plan] ?? entitlement.plan)
								: undefined,
							seats: entitlement.seats,
						}
					: null
			}
			errorMessage={error ? error.message : null}
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
						}
					: null
			}
			walletEmpty={walletEmpty}
		/>
	);
}
