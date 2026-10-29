// packages/marketplace/src/seller-reports.tsx
//
// Org-admin inbox for quality reports on the seller's hosted listings.
// Trust & safety reports never appear here (platform-only routing).
// `layout="settings"` frames it as an iOS-style settings section (header with
// Refresh, card, caption) instead of the Store page's own bordered card.

import {
	SettingsCard,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import { type SellerReportsState, useMarketplaceHost } from "./host.tsx";

const REASON_LABEL = new Map(
	Object.entries({
		broken: "Not working",
		other: "Other",
		malicious: "Malicious",
		spam: "Spam",
		inappropriate: "Inappropriate",
		ip: "IP / copyright",
	})
);

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

const REPORTS_DESCRIPTION =
	"Quality reports (“not working” / other) from buyers and installers. Security reports go to Ryu, not here.";

export function SellerReportsPanel({
	layout = "page",
}: {
	/** The Store page's own card (default), or a settings section. */
	layout?: "page" | "settings";
} = {}) {
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

	const refreshButton = (
		<Button
			loading={loading}
			onClick={() => void refresh()}
			size="sm"
			type="button"
			variant="ghost"
		>
			Refresh
		</Button>
	);
	const body = (
		<>
			{error ? (
				<p className="text-sm text-status-destructive">{error.message}</p>
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

			{reports.length > 0 ? (
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
									<span className="type-compact rounded-full bg-muted px-2 py-0.5 text-muted-foreground uppercase">
										{report.itemKind}
									</span>
									<span className="type-compact rounded-full bg-warning/15 px-2 py-0.5 text-status-warning">
										{REASON_LABEL.get(report.reason) ?? report.reason}
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
			) : null}
		</>
	);

	if (layout === "settings") {
		return (
			<SettingsSection
				caption={REPORTS_DESCRIPTION}
				headerAction={refreshButton}
				title="Reports on your listings"
			>
				<SettingsCard className="space-y-3">{body}</SettingsCard>
			</SettingsSection>
		);
	}

	return (
		<div className="mt-8 rounded-lg border bg-card p-5">
			<div className="mb-4 flex items-center justify-between gap-2">
				<div>
					<h3 className="font-medium text-sm">Reports on your listings</h3>
					<p className="mt-0.5 text-muted-foreground text-xs">
						{REPORTS_DESCRIPTION}
					</p>
				</div>
				{refreshButton}
			</div>

			{body}
		</div>
	);
}
