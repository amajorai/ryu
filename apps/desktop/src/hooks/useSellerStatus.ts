// apps/desktop/src/hooks/useSellerStatus.ts
//
// Loads the active org's Stripe Connect seller status (lib/api/seller.ts ->
// :3000) and exposes a "Become a seller" onboarding action. Plain state + focus
// refetch, mirroring useCreditsWallet: targets :3000 (session-authed), not the
// active Core node.
//
// Onboarding opens a Stripe-hosted Express URL externally (KYC). Payout state is
// materialized from the `account.updated` webhook, so the hook refetches on
// window focus — landing back after Stripe onboarding flips payoutsEnabled
// without a manual reload.

import { useCallback, useEffect, useState } from "react";
import {
	fetchSellerStatus,
	hasSellerAuth,
	type SellerError,
	type SellerStatus,
	startOnboarding,
} from "@/src/lib/api/seller.ts";

interface UseSellerStatus {
	/** False when there is no session token (the seller flow requires sign-in). */
	authed: boolean;
	/** The classified error (auth / no_org / admin / stripe / unknown), or null. */
	error: SellerError | null;
	loading: boolean;
	/**
	 * Begin (or resume) Connect onboarding: returns a hosted Stripe URL to open
	 * externally. Throws a classified SellerError on failure (e.g. not an admin,
	 * Stripe unconfigured).
	 */
	onboard: () => Promise<string>;
	/** True while an onboarding session is being created. */
	onboarding: boolean;
	refresh: () => Promise<void>;
	status: SellerStatus | null;
}

export function useSellerStatus(): UseSellerStatus {
	const [status, setStatus] = useState<SellerStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<SellerError | null>(null);
	const [onboarding, setOnboarding] = useState(false);
	const authed = hasSellerAuth();

	const refresh = useCallback(async () => {
		if (!hasSellerAuth()) {
			setStatus(null);
			setLoading(false);
			setError(null);
			return;
		}
		setLoading(true);
		try {
			const data = await fetchSellerStatus();
			setStatus(data);
			setError(null);
		} catch (e) {
			setError(e as SellerError);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	// Re-fetch on focus so returning from Stripe onboarding picks up the new
	// payout/onboarding state (materialized by the account.updated webhook).
	useEffect(() => {
		const onFocus = () => {
			refresh().catch(() => undefined);
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	const onboard = useCallback(async (): Promise<string> => {
		setOnboarding(true);
		try {
			const { url } = await startOnboarding();
			return url;
		} finally {
			setOnboarding(false);
		}
	}, []);

	return { status, loading, error, authed, refresh, onboard, onboarding };
}
