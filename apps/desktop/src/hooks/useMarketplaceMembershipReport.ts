// Publisher-facing A Major Pass revenue totals.

import type { MarketplaceMembershipState } from "@ryu/marketplace/host";
import { useCallback, useEffect, useState } from "react";
import {
	fetchMarketplaceMembershipPublisherReport,
	hasMarketplaceAuth,
	MarketplaceError,
	type MarketplaceMembershipPublisherReport,
} from "@/src/lib/api/marketplace.ts";

function toHostError(cause: unknown): MarketplaceMembershipState["error"] {
	const typed = cause instanceof MarketplaceError ? cause : null;
	return {
		kind: typed?.kind ?? "unknown",
		message: typed?.message ?? "Could not load A Major Pass revenue.",
	};
}

export function useMarketplaceMembershipReport(): MarketplaceMembershipState {
	const [report, setReport] =
		useState<MarketplaceMembershipPublisherReport | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<MarketplaceMembershipState["error"]>(null);
	const authed = hasMarketplaceAuth();

	const refresh = useCallback(async () => {
		if (!hasMarketplaceAuth()) {
			setReport(null);
			setLoading(false);
			setError(null);
			return;
		}
		setLoading(true);
		try {
			setReport(await fetchMarketplaceMembershipPublisherReport());
			setError(null);
		} catch (cause) {
			setReport(null);
			setError(toHostError(cause));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	useEffect(() => {
		const onFocus = () => {
			refresh().catch(() => undefined);
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	return { authed, error, loading, refresh, report };
}
