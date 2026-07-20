// apps/desktop/src/hooks/useCreditsWallet.ts
//
// Loads the platform-credits wallet + ledger from the control-plane server
// (lib/api/credits.ts). Plain state + manual refresh rather than TanStack Query
// because this targets :3000 (session-authed) instead of the active Core node,
// so it sits outside the node-scoped query cache the other hooks share (same
// reasoning as useChannels).
//
// Alongside the wallet it resolves the org's PLAN entitlement (epic #496, Unit
// C2) so the wallet surface can show the monthly included credit pool that is
// granted INTO the balance each billing period (via `plan_grant` ledger
// entries) — distinct from the live spendable balance. The entitlement also
// tells us whether managed inference is included, which gates the wallet-empty
// nudge (a free/local-only user has no managed wallet to run dry).
//
// Because a top-up credits the wallet asynchronously (the Polar webhook fires
// after the buyer returns from the hosted checkout), the hook also refreshes
// when the window regains focus — so landing back in the app after paying picks
// up the new balance without a manual reload.

import type { Entitlement } from "@ryu/auth/lib/plans";
import { useCallback, useEffect, useState } from "react";
import { fetchEntitlement } from "@/src/lib/api/billing.ts";
import {
	type CreditsError,
	type CreditWallet,
	fetchWallet,
	hasCreditsAuth,
	type LedgerEntry,
} from "@/src/lib/api/credits.ts";
import { useWalletStream } from "./useWalletStream.ts";

interface UseCreditsWallet {
	/** False when there is no session token (credits require sign-in). */
	authed: boolean;
	/** The org's resolved plan entitlement (monthly pool, managed inference). */
	entitlement: Entitlement | null;
	/** The classified error (auth / no_org / billing / unknown), or null. */
	error: CreditsError | null;
	ledger: LedgerEntry[];
	loading: boolean;
	refresh: () => Promise<void>;
	wallet: CreditWallet | null;
	/**
	 * True when managed inference is included AND the spendable balance has run
	 * dry (<= 0). Drives the wallet-empty nudge: the gateway's configured action
	 * (Stop / Downgrade) has kicked in server-side and the user should top up.
	 */
	walletEmpty: boolean;
}

export function useCreditsWallet(): UseCreditsWallet {
	const [wallet, setWallet] = useState<CreditWallet | null>(null);
	const [ledger, setLedger] = useState<LedgerEntry[]>([]);
	const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<CreditsError | null>(null);
	const authed = hasCreditsAuth();

	const refresh = useCallback(async () => {
		if (!hasCreditsAuth()) {
			setWallet(null);
			setLedger([]);
			setEntitlement(null);
			setLoading(false);
			setError(null);
			return;
		}
		setLoading(true);
		// The plan entitlement is purely additive context for the surface; a failed
		// or absent entitlement (free user / offline) must never block the wallet,
		// so resolve it in parallel and swallow its errors independently.
		const entitlementPromise = fetchEntitlement().catch(() => null);
		try {
			const data = await fetchWallet();
			setWallet(data.wallet);
			setLedger(data.ledger ?? []);
			setError(null);
		} catch (e) {
			setError(e as CreditsError);
		} finally {
			setEntitlement(await entitlementPromise);
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	// Re-fetch when returning to the app (e.g. after a Polar checkout in the
	// browser), so an async webhook top-up shows up without a manual reload.
	useEffect(() => {
		const onFocus = () => {
			refresh().catch(() => undefined);
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	// Live balance: the wallet stream pushes a fresh balance the instant a debit
	// or webhook top-up lands. It carries the server's minimal balance view (a
	// subset of CreditWallet), so merge it into the last full wallet rather than
	// replacing it — the initial `fetchWallet` above supplies fields the event
	// omits (e.g. `ownerType`). A frame before the first fetch is ignored; the
	// snapshot frame on the next (re)connect re-syncs it.
	const liveWallet = useWalletStream();
	useEffect(() => {
		if (!liveWallet) {
			return;
		}
		setWallet((prev) =>
			prev
				? {
						...prev,
						balanceMicroUsd: liveWallet.balanceMicroUsd,
						currency: liveWallet.currency,
						updatedAt: liveWallet.updatedAt,
					}
				: prev
		);
	}, [liveWallet]);

	const walletEmpty = Boolean(
		entitlement?.managedInference &&
			wallet !== null &&
			wallet.balanceMicroUsd <= 0
	);

	return {
		wallet,
		ledger,
		entitlement,
		walletEmpty,
		loading,
		error,
		authed,
		refresh,
	};
}
