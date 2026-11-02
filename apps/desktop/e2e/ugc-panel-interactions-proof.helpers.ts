import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for ugc-panel-interactions-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const STORY_URL = "/ugc-panel-interactions-proof.html";
export const API_BASE = "http://127.0.0.1:7980";
export const NODE_TOKEN = "ugc-panel-proof-node-token";
export const EVIDENCE_DIRECTORY = `${proofEvidencePath("test-coverage-sweep-20260924/evidence/ugc-panel-interactions")}/`;

export interface CampaignFixture {
	brand: string;
	brief: string;
	budget_cents: number;
	ends_at: string;
	id: string;
	max_payout_per_creator_cents: number;
	payout:
		| { cpm_cents: number; type: "cpm" }
		| { flat_cents: number; type: "flat" };
	platforms: string[];
	starts_at: string;
	status: "active" | "paused" | "draft" | "ended";
}

export interface CreatorFixture {
	contact_email: string | null;
	display_name: string;
	handles: Record<string, string>;
	id: string;
	payout_handle: string | null;
}

export interface SnapshotFixture {
	captured_at: string;
	comments: number;
	likes: number;
	saves: number;
	shares: number;
	source: "manual" | "composio";
	views: number;
}

export interface SubmissionFixture {
	campaign_id: string;
	creator_id: string;
	external_post_id: string;
	id: string;
	latest: SnapshotFixture | null;
	platform: string;
	post_url: string;
	rejection_reason: string | null;
	status: "pending" | "approved" | "rejected" | "paid";
	submitted_at: string;
}

export interface PayoutFixture {
	amount_cents: number;
	campaign_id: string;
	creator_id: string;
	id: string;
	reason: string;
	status: "accrued" | "approved" | "paid";
	submission_id: string | null;
}

export interface RecordedRequest {
	authorization: string | null;
	body: unknown;
	contentType: string | null;
	method: string;
	path: string;
}

export interface ApiFixture {
	campaigns: CampaignFixture[];
	composioConfigured: boolean;
	creators: CreatorFixture[];
	externalStubRequests: string[];
	failCampaignRefreshOnce: boolean;
	failCreatorCreateOnce: boolean;
	failMetricsWriteOnce: boolean;
	failReviewApproveOnce: boolean;
	failSubmissionCreateOnce: boolean;
	metricHistory: Record<string, SnapshotFixture[]>;
	nextId: number;
	payouts: PayoutFixture[];
	postStubRequests: string[];
	requests: RecordedRequest[];
	submissions: SubmissionFixture[];
	unexpectedExternalRequests: string[];
	unexpectedRoutes: string[];
}

export interface ApiResponse {
	body: unknown;
	status: number;
}

export function initialSnapshot(
	overrides: Partial<SnapshotFixture> = {}
): SnapshotFixture {
	return {
		captured_at: "2026-09-20T10:00:00.000Z",
		comments: 77,
		likes: 555,
		saves: 43,
		shares: 25,
		source: "manual",
		views: 12_345,
		...overrides,
	};
}

export function createFixture(composioConfigured = true): ApiFixture {
	const fixture: ApiFixture = {
		campaigns: [
			{
				brand: "Aurora Spring Launch",
				brief: "Show the new spring collection and tag @aurora.",
				budget_cents: 150_000,
				ends_at: "2026-10-31T00:00:00.000Z",
				id: "campaign-aurora",
				max_payout_per_creator_cents: 25_000,
				payout: { cpm_cents: 250, type: "cpm" },
				platforms: ["tiktok", "instagram"],
				starts_at: "2026-09-01T00:00:00.000Z",
				status: "active",
			},
			{
				brand: "Paused Trial",
				brief: "A paused campaign used for the status filter.",
				budget_cents: 0,
				ends_at: "2026-08-31T00:00:00.000Z",
				id: "campaign-paused",
				max_payout_per_creator_cents: 0,
				payout: { flat_cents: 5000, type: "flat" },
				platforms: [],
				starts_at: "2026-08-01T00:00:00.000Z",
				status: "paused",
			},
		],
		composioConfigured,
		creators: [
			{
				contact_email: "ada@example.test",
				display_name: "Ada Lovelace",
				handles: { tiktok: "@ada" },
				id: "creator-ada",
				payout_handle: "PayPal: ada-proof",
			},
			{
				contact_email: "grace@example.test",
				display_name: "Grace Hopper",
				handles: { instagram: "@grace" },
				id: "creator-grace",
				payout_handle: "Bank alias: grace-proof",
			},
		],
		externalStubRequests: [],
		unexpectedExternalRequests: [],
		failCampaignRefreshOnce: false,
		failCreatorCreateOnce: false,
		failMetricsWriteOnce: false,
		failReviewApproveOnce: false,
		failSubmissionCreateOnce: false,
		nextId: 1,
		payouts: [
			{
				amount_cents: 2500,
				campaign_id: "campaign-aurora",
				creator_id: "creator-ada",
				id: "payout-accrued",
				reason: "12,345 views at $2.50 CPM",
				status: "accrued",
				submission_id: "submission-accrued",
			},
			{
				amount_cents: 4200,
				campaign_id: "campaign-aurora",
				creator_id: "creator-grace",
				id: "payout-approved",
				reason: "Flat sponsor bonus",
				status: "approved",
				submission_id: "submission-approved",
			},
		],
		metricHistory: {},
		requests: [],
		submissions: [
			{
				campaign_id: "campaign-aurora",
				creator_id: "creator-ada",
				external_post_id: "730000",
				id: "submission-accrued",
				latest: initialSnapshot(),
				platform: "tiktok",
				post_url: "https://www.tiktok.com/@ada/video/730000",
				rejection_reason: null,
				status: "approved",
				submitted_at: "2026-09-10T10:00:00.000Z",
			},
			{
				campaign_id: "campaign-aurora",
				creator_id: "creator-grace",
				external_post_id: "reel1001",
				id: "submission-approved",
				latest: initialSnapshot({
					comments: 121,
					likes: 900,
					saves: 65,
					shares: 40,
					views: 21_500,
				}),
				platform: "instagram",
				post_url: "https://www.instagram.com/reel/reel1001/",
				rejection_reason: null,
				status: "approved",
				submitted_at: "2026-09-11T10:00:00.000Z",
			},
			{
				campaign_id: "campaign-aurora",
				creator_id: "creator-ada",
				external_post_id: "youtube1002",
				id: "submission-refresh-ok",
				latest: initialSnapshot({
					comments: 80,
					likes: 400,
					saves: 32,
					shares: 12,
					views: 8200,
				}),
				platform: "youtube",
				post_url: "https://www.youtube.com/shorts/youtube1002",
				rejection_reason: null,
				status: "approved",
				submitted_at: "2026-09-12T10:00:00.000Z",
			},
			{
				campaign_id: "campaign-aurora",
				creator_id: "creator-ada",
				external_post_id: "730001",
				id: "submission-pending-approve",
				latest: initialSnapshot({
					comments: 11,
					likes: 99,
					saves: 5,
					shares: 7,
					views: 2000,
				}),
				platform: "tiktok",
				post_url: "https://www.tiktok.com/@ada/video/730001",
				rejection_reason: null,
				status: "pending",
				submitted_at: "2026-09-15T10:00:00.000Z",
			},
			{
				campaign_id: "campaign-aurora",
				creator_id: "creator-grace",
				external_post_id: "730004",
				id: "submission-pending-reject",
				latest: initialSnapshot({
					comments: 17,
					likes: 120,
					saves: 9,
					shares: 10,
					views: 3500,
				}),
				platform: "tiktok",
				post_url: "https://www.tiktok.com/@grace/video/730004",
				rejection_reason: null,
				status: "pending",
				submitted_at: "2026-09-16T10:00:00.000Z",
			},
		],
		unexpectedRoutes: [],
		postStubRequests: [],
	};
	for (const submission of fixture.submissions) {
		fixture.metricHistory[submission.id] = submission.latest
			? [submission.latest]
			: [];
	}
	return fixture;
}

export function ok<Body>(body: Body): ApiResponse {
	return { body, status: 200 };
}

export function failed(status: number, error: string): ApiResponse {
	return { body: { error }, status };
}

export function campaignSummary(fixture: ApiFixture, campaignId: string) {
	const campaign = fixture.campaigns.find((row) => row.id === campaignId);
	const submissions = fixture.submissions.filter(
		(row) => row.campaign_id === campaignId
	);
	const payouts = fixture.payouts.filter(
		(row) => row.campaign_id === campaignId
	);
	const metricTotal = (field: "comments" | "likes" | "views") =>
		submissions.reduce((sum, row) => sum + (row.latest?.[field] ?? 0), 0);
	const counts = {
		approved: submissions.filter((row) => row.status === "approved").length,
		paid: submissions.filter((row) => row.status === "paid").length,
		pending: submissions.filter((row) => row.status === "pending").length,
		rejected: submissions.filter((row) => row.status === "rejected").length,
	};
	const accruedCents = payouts
		.filter((row) => row.status !== "paid")
		.reduce((sum, row) => sum + row.amount_cents, 0);
	const paidCents = payouts
		.filter((row) => row.status === "paid")
		.reduce((sum, row) => sum + row.amount_cents, 0);
	return {
		accrued_cents: accruedCents,
		approved_cents: payouts
			.filter((row) => row.status === "approved")
			.reduce((sum, row) => sum + row.amount_cents, 0),
		budget_cents: campaign?.budget_cents ?? 0,
		creators: new Set(submissions.map((row) => row.creator_id)).size,
		paid_cents: paidCents,
		remaining_cents:
			campaign && campaign.budget_cents > 0
				? Math.max(0, campaign.budget_cents - accruedCents - paidCents)
				: null,
		submissions: counts,
		total_comments: metricTotal("comments"),
		total_likes: metricTotal("likes"),
		total_views: metricTotal("views"),
	};
}

export function visibleSubmissions(fixture: ApiFixture, campaignId: string) {
	return fixture.submissions
		.filter((row) => row.campaign_id === campaignId)
		.map((submission) => {
			const payout = fixture.payouts.find(
				(row) => row.submission_id === submission.id
			);
			return {
				...submission,
				accrued_cents: payout?.amount_cents ?? null,
				payout_status: payout?.status ?? null,
			};
		});
}

export function overview(fixture: ApiFixture) {
	const openPayouts = fixture.payouts.filter((row) => row.status !== "paid");
	const paidPayouts = fixture.payouts.filter((row) => row.status === "paid");
	return {
		accrued_cents: openPayouts.reduce((sum, row) => sum + row.amount_cents, 0),
		campaigns: fixture.campaigns.length,
		creators: fixture.creators.length,
		paid_cents: paidPayouts.reduce((sum, row) => sum + row.amount_cents, 0),
		submissions: {
			approved: fixture.submissions.filter((row) => row.status === "approved")
				.length,
			paid: fixture.submissions.filter((row) => row.status === "paid").length,
			pending: fixture.submissions.filter((row) => row.status === "pending")
				.length,
			rejected: fixture.submissions.filter((row) => row.status === "rejected")
				.length,
		},
	};
}

export function creatorLeaderboard(fixture: ApiFixture, campaignId: string) {
	const rows = new Map<
		string,
		{
			approved_submissions: number;
			accrued_cents: number;
			creator_id: string;
			display_name: string;
			paid_cents: number;
			views: number;
		}
	>();
	for (const submission of fixture.submissions) {
		if (submission.campaign_id !== campaignId) {
			continue;
		}
		const creator = fixture.creators.find(
			(row) => row.id === submission.creator_id
		);
		const row = rows.get(submission.creator_id) ?? {
			approved_submissions: 0,
			accrued_cents: 0,
			creator_id: submission.creator_id,
			display_name: creator?.display_name ?? "",
			paid_cents: 0,
			views: 0,
		};
		row.views += submission.latest?.views ?? 0;
		if (submission.status === "approved" || submission.status === "paid") {
			row.approved_submissions += 1;
		}
		const payout = fixture.payouts.find(
			(item) => item.submission_id === submission.id
		);
		if (payout?.status === "paid") {
			row.paid_cents += payout.amount_cents;
		} else if (payout) {
			row.accrued_cents += payout.amount_cents;
		}
		rows.set(submission.creator_id, row);
	}
	return [...rows.values()].sort((a, b) => b.views - a.views);
}

export function nextId(fixture: ApiFixture, prefix: string): string {
	const id = `${prefix}-${fixture.nextId}`;
	fixture.nextId += 1;
	return id;
}

export function refreshReport(fixture: ApiFixture): ApiResponse {
	const [needsConnection, failedSubmission, refreshed] =
		fixture.submissions.filter((row) => row.status === "approved");
	return ok({
		counts: { error: 1, needs_connection: 1, ok: 1 },
		results: [
			{
				connect_url: "https://composio.dev/connect/ugc-proof-only",
				message: "No active connection for TikTok",
				snapshot: null,
				status: "needs_connection",
				submission_id: needsConnection?.id ?? "missing-connection",
			},
			{
				connect_url: null,
				message: "Instagram metric read timed out",
				snapshot: null,
				status: "error",
				submission_id: failedSubmission?.id ?? "failed-read",
			},
			{
				connect_url: null,
				message: null,
				snapshot: initialSnapshot({
					captured_at: "2026-09-28T09:00:00.000Z",
					comments: 81,
					likes: 402,
					saves: 35,
					shares: 13,
					source: "composio",
					views: 8250,
				}),
				status: "ok",
				submission_id: refreshed?.id ?? "successful-read",
			},
		],
	});
}
