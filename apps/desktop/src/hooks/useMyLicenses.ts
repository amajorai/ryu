// apps/desktop/src/hooks/useMyLicenses.ts
//
// Loads the active org's owned marketplace licenses (paid items) from the
// control-plane server (lib/api/marketplace.ts -> :3000). Plain state + manual
// refresh + focus refetch, mirroring useCreditsWallet: this targets :3000
// (session-authed) rather than the active Core node, so it sits outside the
// node-scoped TanStack query cache.
//
// Because a purchase grants the license asynchronously (the Stripe webhook fires
// after the buyer returns from hosted checkout), the hook refetches when the
// window regains focus — so landing back in the app after paying picks up the
// newly granted license without a manual reload.

import { useCallback, useEffect, useState } from "react";
import {
	fetchLicenses,
	hasMarketplaceAuth,
	type MarketplaceError,
	type OwnedLicense,
} from "@/src/lib/api/marketplace.ts";

interface UseMyLicenses {
	/** False when there is no session token (the money layer requires sign-in). */
	authed: boolean;
	/** The classified error (auth / no_org / unknown), or null. */
	error: MarketplaceError | null;
	/** True when the buyer org holds an ACTIVE license for this item. */
	isLicensed: (kind: OwnedLicense["itemKind"], id: string) => boolean;
	licenses: OwnedLicense[];
	loading: boolean;
	refresh: () => Promise<void>;
}

export function useMyLicenses(): UseMyLicenses {
	const [licenses, setLicenses] = useState<OwnedLicense[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<MarketplaceError | null>(null);
	const authed = hasMarketplaceAuth();

	const refresh = useCallback(async () => {
		if (!hasMarketplaceAuth()) {
			setLicenses([]);
			setLoading(false);
			setError(null);
			return;
		}
		setLoading(true);
		try {
			const data = await fetchLicenses();
			setLicenses(data);
			setError(null);
		} catch (e) {
			setError(e as MarketplaceError);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	// Re-fetch when returning to the app (e.g. after a Stripe checkout), so an
	// async webhook-granted license shows up without a manual reload.
	useEffect(() => {
		const onFocus = () => {
			refresh().catch(() => undefined);
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	const isLicensed = useCallback(
		(kind: OwnedLicense["itemKind"], id: string) =>
			licenses.some(
				(l) => l.status === "active" && l.itemKind === kind && l.itemId === id
			),
		[licenses]
	);

	return { licenses, loading, error, authed, refresh, isLicensed };
}
