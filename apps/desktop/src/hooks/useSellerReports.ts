// apps/desktop/src/hooks/useSellerReports.ts
//
// Seller-org inbox for quality reports on hosted marketplace listings.

import type { SellerReportsState } from "@ryu/marketplace/host";
import { useCallback, useState } from "react";
import { z } from "zod";
import {
	fetchSellerReports,
	hasMarketplaceAuth,
	type MarketplaceReportView,
	resolveReport,
} from "@/src/lib/api/marketplace.ts";

// Marketplace host errors expose only their classification and display text;
// preserve future string classifications while validating both consumed fields.
const toHostError = z
	.union([
		z.object({ kind: z.string().min(1), message: z.string() }),
		z
			.instanceof(Error)
			.transform((error) => ({ kind: "unknown", message: error.message })),
	])
	.catch({ kind: "unknown", message: "Could not load reports" }).parse;

export function useSellerReports(): SellerReportsState {
	const [reports, setReports] = useState<MarketplaceReportView[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<SellerReportsState["error"]>(null);
	const authed = hasMarketplaceAuth();

	const refresh = useCallback(async () => {
		if (!authed) {
			setReports([]);
			return;
		}
		setLoading(true);
		try {
			const next = await fetchSellerReports();
			setReports(next);
			setError(null);
		} catch (e) {
			setReports([]);
			setError(toHostError(e));
		} finally {
			setLoading(false);
		}
	}, [authed]);

	const resolve = useCallback(
		async (input: {
			id: string;
			note?: string | null;
			status: "resolved" | "dismissed" | "reviewing" | "open";
		}) => {
			await resolveReport(input);
		},
		[]
	);

	return {
		authed,
		error,
		loading,
		refresh,
		reports: reports.map((r) => ({
			id: r.id,
			itemId: r.itemId,
			itemKind: r.itemKind,
			itemName: r.itemName,
			reason: r.reason,
			details: r.details,
			status: r.status,
		})),
		resolve,
	};
}
