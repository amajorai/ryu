// packages/marketplace/src/seller-reports.tsx
//
// Org-admin inbox for quality reports on the seller's hosted listings.
// Trust & safety reports never appear here (platform-only routing).

import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import { type SellerReportsState, useMarketplaceHost } from "./host.tsx";

const REASON_LABEL: Record<string, string> = {
	broken: "Not working",
	other: "Other",
	malicious: "Malicious",
	spam: "Spam",
	inappropriate: "Inappropriate",
	ip: "IP / copyright",
};

function useMissingSellerReports(): SellerReportsState {
	return {
		authed: false,
		error: null,
		loading: false,
		refresh: async () => {
			// no-op when the host does not supply a seller-reports hook
		},
		reports: [],
		resolve: async () => {
			// no-op
		},
	};
}

const MISSING_SELLER_REPORTS_HOOK = useMissingSellerReports;

export function SellerReportsPanel() {
	const { useSellerReports } = useMarketplaceHost();
	// Host is a stable module const; when absent we always call the same fallback.
	const { reports, loading, error, refresh, resolve, authed } = (
		useSellerReports ?? MISSING_SELLER_REPORTS_HOOK
	)();
	const [busyId, setBusyId] = useState<string | null>(null);

	useEffect(() => {
		if (!useSellerReports) {
			return;
		}
		void refresh();
	}, [refresh, useSellerReports]);

	const decide = useCallback(
		async (id: string, status: "resolved" | "dismissed") => {
			setBusyId(id);
			try {
				await resolve({ id, status });
				sileo.success({
					title: status === "resolved" ? "Marked resolved" : "Dismissed",
				});
				await refresh();
			} catch (e) {
				sileo.error({
					title: e instanceof Error ? e.message : "Could not update report",
				});
			} finally {
				setBusyId(null);
			}
		},
		[refresh, resolve]
	);

	if (!(useSellerReports && authed)) {
		return null;
	}

	return (
		<div className="mt-8 rounded-lg border bg-card p-5">
			<div className="mb-4 flex items-center justify-between gap-2">
				<div>
					<h3 className="font-medium text-sm">Reports on your listings</h3>
					<p className="mt-0.5 text-muted-foreground text-xs">
						Quality reports (“not working” / other) from buyers and installers.
						Security reports go to Ryu, not here.
					</p>
				</div>
				<Button
					loading={loading}
					onClick={() => void refresh()}
					size="sm"
					type="button"
					variant="ghost"
				>
					Refresh
				</Button>
			</div>

			{error ? (
				<p className="text-destructive text-sm">{error.message}</p>
			) : null}
			{loading && reports.length === 0 ? (
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Spinner className="size-4" />
					Loading…
				</div>
			) : null}
			{!(loading || error) && reports.length === 0 ? (
				<p className="text-muted-foreground text-sm">No open reports.</p>
			) : null}

			<ul className="flex flex-col gap-3">
				{reports.map((report) => {
					const busy = busyId === report.id;
					return (
						<li
							className="flex flex-col gap-2 rounded-md border px-3 py-3"
							key={report.id}
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium text-sm">
									{report.itemName ?? report.itemId}
								</span>
								<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground uppercase">
									{report.itemKind}
								</span>
								<span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
									{REASON_LABEL[report.reason] ?? report.reason}
								</span>
							</div>
							{report.details ? (
								<p className="whitespace-pre-wrap text-muted-foreground text-xs">
									{report.details}
								</p>
							) : null}
							<div className="flex flex-wrap gap-2">
								<Button
									disabled={busy}
									onClick={() => void decide(report.id, "resolved")}
									size="sm"
									type="button"
								>
									Resolve
								</Button>
								<Button
									disabled={busy}
									onClick={() => void decide(report.id, "dismissed")}
									size="sm"
									type="button"
									variant="ghost"
								>
									Dismiss
								</Button>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
