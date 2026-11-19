// apps/desktop/src/lib/api/marketplace-reports.ts
//
// Abuse and quality reports: submit, seller inbox, resolve.
// Split out of marketplace.ts (which re-exports it); see that file's header
// for the control-plane contract.

import {
	authHeaders,
	BASE,
	MarketplaceError,
	toError,
} from "./marketplace-http.ts";
import {
	parseMarketplaceResponse,
	reportEnvelopeSchema,
	reportSubmissionSchema,
	reportsEnvelopeSchema,
} from "./marketplace-response-contracts.ts";

// ── abuse / quality reports ───────────────────────────────────────────────────

export type ReportReason =
	| "malicious"
	| "spam"
	| "inappropriate"
	| "ip"
	| "broken"
	| "other";

export type ReportSource =
	| "mongo"
	| "github-curated"
	| "github-community"
	| "installed"
	| "unknown";

export interface SubmitReportInput {
	details?: string | null;
	homepage?: string | null;
	id: string;
	installSource?: string | null;
	itemName?: string | null;
	kind: string;
	reason: ReportReason;
	source?: ReportSource;
}

export interface SubmitReportResult {
	suggestIssuesUrl?: string | null;
}

/** POST /api/marketplace/report — file a report against a listing or installed item. */
export async function submitReport(
	input: SubmitReportInput
): Promise<SubmitReportResult> {
	const resp = await fetch(`${BASE}/report`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			kind: input.kind,
			id: input.id,
			reason: input.reason,
			details: input.details ?? null,
			source: input.source ?? "unknown",
			installSource: input.installSource ?? null,
			homepage: input.homepage ?? null,
			itemName: input.itemName ?? null,
		}),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		reportSubmissionSchema,
		await resp.json()
	);
	return { suggestIssuesUrl: json.suggestIssuesUrl ?? null };
}

export type ReportStatus = "open" | "reviewing" | "resolved" | "dismissed";

export interface MarketplaceReportView {
	audience: "platform" | "seller" | "both";
	createdAt: string | null;
	details: string | null;
	homepage: string | null;
	id: string;
	installSource: string | null;
	issuesUrl: string | null;
	itemId: string;
	itemKind: string;
	itemName: string | null;
	reason: ReportReason;
	/** Platform-admin views only; the seller inbox omits who filed a report. */
	reporterEmail?: string | null;
	reporterName?: string | null;
	reporterUserId?: string;
	resolutionNote: string | null;
	resolvedAt: string | null;
	sellerOrgId: string | null;
	source: ReportSource;
	status: ReportStatus;
}

/** GET /api/marketplace/reports/seller — org admin inbox for seller-visible reports. */
export async function fetchSellerReports(input?: {
	status?: ReportStatus;
}): Promise<MarketplaceReportView[]> {
	const params = new URLSearchParams();
	if (input?.status) {
		params.set("status", input.status);
	}
	const qs = params.toString();
	const resp = await fetch(`${BASE}/reports/seller${qs ? `?${qs}` : ""}`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		reportsEnvelopeSchema,
		await resp.json()
	);
	return json.reports ?? [];
}

/** POST /api/marketplace/reports/resolve — seller or platform admin status update. */
export async function resolveReport(input: {
	id: string;
	note?: string | null;
	status: ReportStatus;
}): Promise<MarketplaceReportView> {
	const resp = await fetch(`${BASE}/reports/resolve`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		reportEnvelopeSchema,
		await resp.json()
	);
	if (!json.report) {
		throw new MarketplaceError("unknown", "Resolve returned no report.");
	}
	return json.report;
}
