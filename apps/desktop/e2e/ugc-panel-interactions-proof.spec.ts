import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { parseProofJson } from "./fixture-json.ts";

const STORY_URL = "/ugc-panel-interactions-proof.html";
const API_BASE = "http://127.0.0.1:7980";
const NODE_TOKEN = "ugc-panel-proof-node-token";
const EVIDENCE_DIRECTORY = fileURLToPath(
	new URL(
		"../../../docs/proof/test-coverage-sweep-20260924/evidence/ugc-panel-interactions/",
		import.meta.url
	)
);

interface CampaignFixture {
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

interface CreatorFixture {
	contact_email: string | null;
	display_name: string;
	handles: Record<string, string>;
	id: string;
	payout_handle: string | null;
}

interface SnapshotFixture {
	captured_at: string;
	comments: number;
	likes: number;
	saves: number;
	shares: number;
	source: "manual" | "composio";
	views: number;
}

interface SubmissionFixture {
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

interface PayoutFixture {
	amount_cents: number;
	campaign_id: string;
	creator_id: string;
	id: string;
	reason: string;
	status: "accrued" | "approved" | "paid";
	submission_id: string | null;
}

interface RecordedRequest {
	authorization: string | null;
	body: unknown;
	contentType: string | null;
	method: string;
	path: string;
}

interface ApiFixture {
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

interface ApiResponse {
	body: unknown;
	status: number;
}

function initialSnapshot(
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

function createFixture(composioConfigured = true): ApiFixture {
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

function ok<Body>(body: Body): ApiResponse {
	return { body, status: 200 };
}

function failed(status: number, error: string): ApiResponse {
	return { body: { error }, status };
}

function campaignSummary(fixture: ApiFixture, campaignId: string) {
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

function visibleSubmissions(fixture: ApiFixture, campaignId: string) {
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

function overview(fixture: ApiFixture) {
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

function creatorLeaderboard(fixture: ApiFixture, campaignId: string) {
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

function nextId(fixture: ApiFixture, prefix: string): string {
	const id = `${prefix}-${fixture.nextId}`;
	fixture.nextId += 1;
	return id;
}

function refreshReport(fixture: ApiFixture): ApiResponse {
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

function dispatch(
	fixture: ApiFixture,
	url: URL,
	request: RecordedRequest
): ApiResponse {
	const { method } = request;
	const path = url.pathname.replace(/^\/api\/ugc/u, "") || "/";
	const segments = path.split("/").filter(Boolean).map(decodeURIComponent);

	if (method === "GET" && path === "/") {
		return ok(overview(fixture));
	}
	if (method === "GET" && path === "/platforms") {
		return ok({
			composio_configured: fixture.composioConfigured,
			platforms: [
				{
					action: "TIKTOK_GET_VIDEO_ANALYTICS",
					label: "TikTok",
					platform: "tiktok",
				},
				{
					action: "INSTAGRAM_GET_MEDIA_INSIGHTS",
					label: "Instagram",
					platform: "instagram",
				},
				{
					action: "YOUTUBE_GET_VIDEO_ANALYTICS",
					label: "YouTube",
					platform: "youtube",
				},
			],
		});
	}
	if (method === "GET" && path === "/creators") {
		return ok({ creators: fixture.creators });
	}
	if (method === "POST" && path === "/creators") {
		if (fixture.failCreatorCreateOnce) {
			fixture.failCreatorCreateOnce = false;
			return failed(503, "Creator service temporarily unavailable.");
		}
		// SAFETY: This controlled route receives mounted UgcPanel CreateCreatorDialog JSON: native input strings produce display_name and nullable contact_email/payout_handle; the fixture supplies id/handles afterward.
		const body = request.body as Omit<CreatorFixture, "id" | "handles">;
		const creator = { ...body, handles: {}, id: nextId(fixture, "creator") };
		fixture.creators.push(creator);
		return ok({ creator });
	}
	if (method === "GET" && path === "/campaigns") {
		const status = url.searchParams.get("status");
		return ok({
			campaigns: fixture.campaigns.filter(
				(row) => !status || row.status === status
			),
		});
	}
	if (method === "POST" && path === "/campaigns") {
		// SAFETY: The mounted CreateCampaignDialog authors this matched POST with parsed cent amounts, real selected platform strings, native brand/brief strings, a literal draft status, and the complete tagged payout; fixture dates/id are supplied below.
		const body = request.body as Omit<
			CampaignFixture,
			"ends_at" | "id" | "starts_at"
		>;
		const campaign: CampaignFixture = {
			...body,
			ends_at: "2026-12-31T00:00:00.000Z",
			id: nextId(fixture, "campaign"),
			starts_at: "2026-09-28T10:00:00.000Z",
		};
		fixture.campaigns.push(campaign);
		return ok({ campaign });
	}
	if (
		method === "GET" &&
		segments[0] === "campaigns" &&
		segments[2] === "summary"
	) {
		return ok(campaignSummary(fixture, segments[1] ?? ""));
	}
	if (
		method === "GET" &&
		segments[0] === "campaigns" &&
		segments[2] === "leaderboard"
	) {
		return ok({ leaderboard: creatorLeaderboard(fixture, segments[1] ?? "") });
	}
	if (
		method === "GET" &&
		segments[0] === "campaigns" &&
		segments[2] === "submissions"
	) {
		const status = url.searchParams.get("status");
		return ok({
			submissions: visibleSubmissions(fixture, segments[1] ?? "").filter(
				(row) => !status || row.status === status
			),
		});
	}
	if (
		method === "POST" &&
		segments[0] === "campaigns" &&
		segments[2] === "refresh"
	) {
		if (fixture.failCampaignRefreshOnce) {
			fixture.failCampaignRefreshOnce = false;
			return failed(502, "Metric provider temporarily unavailable.");
		}
		return refreshReport(fixture);
	}
	if (method === "POST" && path === "/submissions") {
		if (fixture.failSubmissionCreateOnce) {
			fixture.failSubmissionCreateOnce = false;
			return failed(409, "That post was already recorded for this campaign.");
		}
		// SAFETY: This controlled matched POST is the mounted submission dialog serializer: parsed campaign.id and native creator/platform/post input state are strings, with post_url trimmed before JSON capture.
		const body = request.body as {
			campaign_id: string;
			creator_id: string;
			platform: string;
			post_url: string;
		};
		const videoId = /\/video\/(\d+)/u.exec(body.post_url)?.[1] ?? "";
		const submission: SubmissionFixture = {
			campaign_id: body.campaign_id,
			creator_id: body.creator_id,
			external_post_id: videoId,
			id: nextId(fixture, "submission"),
			latest: null,
			platform: body.platform,
			post_url: body.post_url,
			rejection_reason: null,
			status: "pending",
			submitted_at: "2026-09-28T10:05:00.000Z",
		};
		fixture.submissions.push(submission);
		return ok({ submission });
	}
	if (
		method === "POST" &&
		segments[0] === "submissions" &&
		segments[2] === "review"
	) {
		const submission = fixture.submissions.find(
			(row) => row.id === segments[1]
		);
		// SAFETY: Mounted review callbacks publish literal approve/reject decisions and the optional native rejection input string through JSON; this fixture observes only those controlled actions.
		const body = request.body as {
			decision: "approve" | "reject";
			reason?: string;
		};
		if (body.decision === "approve" && fixture.failReviewApproveOnce) {
			fixture.failReviewApproveOnce = false;
			return failed(503, "Review service temporarily unavailable.");
		}
		if (!submission) {
			return failed(404, "Submission not found.");
		}
		if (body.decision === "approve") {
			submission.status = "approved";
			const campaign = fixture.campaigns.find(
				(row) => row.id === submission.campaign_id
			);
			const rule = campaign?.payout;
			const amount =
				rule?.type === "flat"
					? rule.flat_cents
					: Math.floor(
							((submission.latest?.views ?? 0) * (rule?.cpm_cents ?? 0)) / 1000
						);
			fixture.payouts.push({
				amount_cents: amount,
				campaign_id: submission.campaign_id,
				creator_id: submission.creator_id,
				id: nextId(fixture, "payout"),
				reason: "Accrued from the latest metric snapshot",
				status: "accrued",
				submission_id: submission.id,
			});
		} else {
			submission.status = "rejected";
			submission.rejection_reason = body.reason ?? null;
			fixture.payouts = fixture.payouts.filter(
				(row) => row.submission_id !== submission.id || row.status === "paid"
			);
		}
		return ok({ submission });
	}
	if (
		method === "POST" &&
		segments[0] === "submissions" &&
		segments[2] === "metrics"
	) {
		if (fixture.failMetricsWriteOnce) {
			fixture.failMetricsWriteOnce = false;
			return failed(503, "Metric history store temporarily unavailable.");
		}
		const submission = fixture.submissions.find(
			(row) => row.id === segments[1]
		);
		if (!submission) {
			return failed(404, "Submission not found.");
		}
		// SAFETY: The mounted RecordMetricsDialog only serializes a non-null parseDraft result, which parses all five native counter inputs as whole numbers; this matched fixture adds captured_at/source itself.
		const counts = request.body as Omit<
			SnapshotFixture,
			"captured_at" | "source"
		>;
		const snapshot: SnapshotFixture = {
			...counts,
			captured_at: "2026-09-28T10:10:00.000Z",
			source: "manual",
		};
		fixture.metricHistory[submission.id] ??= [];
		fixture.metricHistory[submission.id].push(snapshot);
		submission.latest = snapshot;
		const payout = fixture.payouts.find(
			(row) => row.submission_id === submission.id
		);
		const campaign = fixture.campaigns.find(
			(row) => row.id === submission.campaign_id
		);
		if (payout?.status === "accrued" && campaign?.payout.type === "cpm") {
			payout.amount_cents = Math.floor(
				(snapshot.views * campaign.payout.cpm_cents) / 1000
			);
			payout.reason = `${snapshot.views.toLocaleString()} views at CPM`;
		}
		return ok({ snapshot });
	}
	if (
		method === "POST" &&
		segments[0] === "submissions" &&
		segments[2] === "refresh"
	) {
		return ok({
			connect_url: "https://composio.dev/connect/ugc-proof-only",
			message: "No active connection for TikTok",
			snapshot: null,
			status: "needs_connection",
			submission_id: segments[1],
		});
	}
	if (method === "GET" && path === "/payouts") {
		const status = url.searchParams.get("status");
		return ok({
			payouts: fixture.payouts.filter(
				(row) => !status || row.status === status
			),
		});
	}
	if (
		method === "POST" &&
		segments[0] === "payouts" &&
		["approve", "paid"].includes(segments[2] ?? "")
	) {
		const payout = fixture.payouts.find((row) => row.id === segments[1]);
		if (!payout) {
			return failed(404, "Payout not found.");
		}
		payout.status = segments[2] === "approve" ? "approved" : "paid";
		if (segments[2] === "paid") {
			const submission = fixture.submissions.find(
				(row) => row.id === payout.submission_id
			);
			if (submission) {
				submission.status = "paid";
			}
		}
		return ok({ payout });
	}
	return failed(404, `No UGC fixture route for ${method} ${path}`);
}

async function installFixture(
	page: Page,
	fixture = createFixture()
): Promise<ApiFixture> {
	await page.context().route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
			await route.continue();
			return;
		}
		fixture.unexpectedExternalRequests.push(route.request().url());
		await route.abort();
	});
	await page.context().route("https://composio.dev/**", async (route) => {
		fixture.externalStubRequests.push(route.request().url());
		await route.fulfill({
			body: "<!doctype html><title>Local Composio connection fixture</title><main>External provider navigation was intercepted locally.</main>",
			contentType: "text/html",
			status: 200,
		});
	});
	for (const hostname of [
		"www.tiktok.com",
		"www.instagram.com",
		"www.youtube.com",
	]) {
		await page.context().route(`https://${hostname}/**`, async (route) => {
			fixture.postStubRequests.push(route.request().url());
			await route.fulfill({
				body: "<!doctype html><title>Local post link fixture</title><main>External post navigation was intercepted locally.</main>",
				contentType: "text/html",
				status: 200,
			});
		});
	}
	await page.route(`${API_BASE}/api/**`, async (route) => {
		fixture.unexpectedRoutes.push(route.request().url());
		await route.fulfill({
			body: JSON.stringify({
				error: "Unexpected Core or Gateway request in UGC proof.",
			}),
			contentType: "application/json",
			status: 500,
		});
	});
	await page.route(`${API_BASE}/api/ugc**`, async (route) => {
		const rawBody = route.request().postData();
		const url = new URL(route.request().url());
		const request: RecordedRequest = {
			body: rawBody ? parseProofJson(rawBody) : null,
			contentType: route.request().headers()["content-type"] ?? null,
			authorization: route.request().headers().authorization ?? null,
			method: route.request().method(),
			path: `${url.pathname}${url.search}`,
		};
		fixture.requests.push(request);
		const response = dispatch(fixture, url, request);
		await route.fulfill({
			body: JSON.stringify(response.body),
			contentType: "application/json",
			status: response.status,
		});
	});
	return fixture;
}

async function openPanel(page: Page, query = ""): Promise<void> {
	await page.goto(`${STORY_URL}${query}`);
	await expect(
		page.getByRole("tab", { name: "Campaigns", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Aurora Spring Launch/u })
	).toBeVisible();
}

function requestsFor(fixture: ApiFixture, method: string, path: string) {
	return fixture.requests.filter(
		(request) => request.method === method && request.path === path
	);
}

async function waitForRequest(
	fixture: ApiFixture,
	method: string,
	path: string,
	count = 1
): Promise<void> {
	await expect
		.poll(() => requestsFor(fixture, method, path).length)
		.toBeGreaterThanOrEqual(count);
}

function lastRequest(
	fixture: ApiFixture,
	method: string,
	path: string
): RecordedRequest {
	const request = requestsFor(fixture, method, path).at(-1);
	if (!request) {
		throw new Error(`Missing intercepted request: ${method} ${path}`);
	}
	return request;
}

function expectAuthenticatedLocalRequests(fixture: ApiFixture): void {
	expect(fixture.unexpectedRoutes).toEqual([]);
	expect(fixture.requests.length).toBeGreaterThan(0);
	for (const request of fixture.requests) {
		expect(request.authorization).toBe(`Bearer ${NODE_TOKEN}`);
		expect(request.path).toMatch(/^\/api\/ugc(?:\/|\?|$)/u);
	}
}

test.beforeAll(async () => {
	await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
});

test("creator and campaign forms validate, convert money to cents, and persist through reload", async ({
	page,
}) => {
	const fixture = createFixture();
	fixture.failCreatorCreateOnce = true;
	await installFixture(page, fixture);
	await openPanel(page);

	await page
		.getByRole("button", { name: "Add creator", exact: true })
		.first()
		.click();
	let creatorDialog = page.getByRole("dialog", { name: "Add a creator" });
	await creatorDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(creatorDialog).toBeHidden();
	expect(requestsFor(fixture, "POST", "/api/ugc/creators")).toHaveLength(0);
	await page
		.getByRole("button", { name: "Add creator", exact: true })
		.first()
		.click();
	creatorDialog = page.getByRole("dialog", { name: "Add a creator" });
	await expect(
		creatorDialog.getByRole("button", { name: "Add creator" })
	).toBeDisabled();
	await creatorDialog.getByLabel("Display name").fill("  Mira Proof  ");
	await creatorDialog.getByLabel("Contact email").fill("mira@example.test");
	await creatorDialog.getByLabel("Payout handle").fill("PayPal: mira-proof");
	await creatorDialog.getByRole("button", { name: "Add creator" }).click();
	await expect(
		creatorDialog.getByText("Creator service temporarily unavailable.")
	).toBeVisible();
	await expect(creatorDialog).toBeVisible();
	await creatorDialog.getByRole("button", { name: "Add creator" }).click();
	await expect(creatorDialog).toBeHidden();
	await expect
		.poll(() =>
			fixture.creators.some((row) => row.display_name === "Mira Proof")
		)
		.toBe(true);
	const creatorWrites = requestsFor(fixture, "POST", "/api/ugc/creators");
	expect(creatorWrites).toHaveLength(2);
	expect(creatorWrites[0]?.body).toEqual({
		contact_email: "mira@example.test",
		display_name: "Mira Proof",
		payout_handle: "PayPal: mira-proof",
	});
	expect(creatorWrites[1]?.body).toEqual(creatorWrites[0]?.body);
	await expect(page.getByText(/3 creators/u)).toBeVisible();

	await page.getByRole("button", { name: "New campaign", exact: true }).click();
	let campaignDialog = page.getByRole("dialog", { name: "New campaign" });
	await campaignDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(campaignDialog).toBeHidden();
	expect(requestsFor(fixture, "POST", "/api/ugc/campaigns")).toHaveLength(0);

	await page.getByRole("button", { name: "New campaign", exact: true }).click();
	campaignDialog = page.getByRole("dialog", { name: "New campaign" });
	await campaignDialog.getByLabel("Brand").fill("  Mira Spring Drop  ");
	await campaignDialog.getByLabel("Brief").fill("  Show the spring range.  ");
	await campaignDialog.getByLabel("Budget (USD)").fill("1200.05");
	await campaignDialog.getByLabel("Max per creator (USD)").fill("125.99");
	await campaignDialog.getByLabel("Rate (USD)").fill("2.50");
	await campaignDialog.getByRole("button", { name: "TikTok" }).click();
	await expect(
		campaignDialog.getByRole("button", { name: "TikTok" })
	).toHaveAttribute("aria-pressed", "true");
	await campaignDialog.getByRole("button", { name: "Instagram" }).click();
	await expect(
		campaignDialog.getByRole("button", { name: "Instagram" })
	).toHaveAttribute("aria-pressed", "true");
	await page.screenshot({
		path: `${EVIDENCE_DIRECTORY}/campaign-cpm-form.png`,
	});
	await campaignDialog.getByLabel("Budget (USD)").fill("12.345");
	await campaignDialog.getByRole("button", { name: "Create campaign" }).click();
	await expect(
		campaignDialog.getByText(
			"Budget and per-creator cap must be amounts like 250 or 250.00."
		)
	).toBeVisible();
	expect(requestsFor(fixture, "POST", "/api/ugc/campaigns")).toHaveLength(0);
	await campaignDialog.getByLabel("Budget (USD)").fill("1200.05");
	await campaignDialog.getByRole("button", { name: "Create campaign" }).click();
	await expect(campaignDialog).toBeHidden();
	await expect(
		page.getByRole("button", { name: /Mira Spring Drop/u })
	).toBeVisible();
	expect(lastRequest(fixture, "POST", "/api/ugc/campaigns").body).toEqual({
		brand: "Mira Spring Drop",
		brief: "Show the spring range.",
		budget_cents: 120_005,
		max_payout_per_creator_cents: 12_599,
		payout: { cpm_cents: 250, type: "cpm" },
		platforms: ["tiktok", "instagram"],
		status: "draft",
	});

	await page.getByRole("button", { name: "New campaign", exact: true }).click();
	campaignDialog = page.getByRole("dialog", { name: "New campaign" });
	await campaignDialog.getByLabel("Brand").fill("Unlimited Flat Trial");
	await campaignDialog.getByLabel("Payout rule").selectOption("flat_cents");
	await campaignDialog.getByLabel("Rate (USD)").fill("5.75");
	await campaignDialog.getByRole("button", { name: "Instagram" }).click();
	await campaignDialog.getByRole("button", { name: "Create campaign" }).click();
	await expect(campaignDialog).toBeHidden();
	expect(lastRequest(fixture, "POST", "/api/ugc/campaigns").body).toEqual({
		brand: "Unlimited Flat Trial",
		brief: "",
		budget_cents: 0,
		max_payout_per_creator_cents: 0,
		payout: { flat_cents: 575, type: "flat" },
		platforms: ["instagram"],
		status: "draft",
	});
	expect(fixture.campaigns.map((row) => row.brand)).toContain(
		"Unlimited Flat Trial"
	);

	await page.reload();
	await expect(
		page.getByRole("button", { name: /Mira Spring Drop/u })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Unlimited Flat Trial/u })
	).toBeVisible();
	await expect(page.getByText(/3 creators/u)).toBeVisible();
	await page.screenshot({
		path: `${EVIDENCE_DIRECTORY}/campaigns-persisted.png`,
	});
	expectAuthenticatedLocalRequests(fixture);
});

test("campaign filters, metric refresh retry, and Composio connection results reflect server outcomes", async ({
	page,
}) => {
	const fixture = createFixture();
	fixture.failCampaignRefreshOnce = true;
	await installFixture(page, fixture);
	await openPanel(page);

	await page.getByLabel("Filter campaigns by status").selectOption("paused");
	await waitForRequest(fixture, "GET", "/api/ugc/campaigns?status=paused");
	await expect(
		page.getByRole("button", { name: /Paused Trial/u })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Aurora Spring Launch/u })
	).toHaveCount(0);
	await page.getByLabel("Filter campaigns by status").selectOption("");
	await expect(
		page.getByRole("button", { name: /Aurora Spring Launch/u })
	).toBeVisible();
	await page.getByRole("button", { name: /Aurora Spring Launch/u }).click();
	await expect(
		page.getByRole("heading", { name: "Aurora Spring Launch" })
	).toBeVisible();

	const campaignRefresh = page.locator(
		'button[title="Refresh metrics for every approved submission"]'
	);
	await campaignRefresh.click();
	await expect(
		page.getByText("Metric provider temporarily unavailable.")
	).toBeVisible();
	expect(
		requestsFor(fixture, "POST", "/api/ugc/campaigns/campaign-aurora/refresh")
	).toHaveLength(1);
	await campaignRefresh.click();
	await expect(
		page.getByText("1 refreshed · 1 needs a connection · 1 failed.")
	).toBeVisible();
	const connectLink = page.getByRole("link", { name: "Connect account" });
	await expect(connectLink).toHaveAttribute(
		"href",
		"https://composio.dev/connect/ugc-proof-only"
	);
	await expect(connectLink).toHaveAttribute("target", "_blank");
	await expect(connectLink).toHaveAttribute("rel", "noopener noreferrer");
	await page.screenshot({
		path: `${EVIDENCE_DIRECTORY}/campaign-refresh-report.png`,
	});

	const popupPromise = page.waitForEvent("popup");
	await connectLink.click();
	const popup = await popupPromise;
	await expect(popup).toHaveTitle("Local Composio connection fixture");
	await expect(popup.locator("body")).toContainText("intercepted locally");
	expect(fixture.externalStubRequests).toEqual([
		"https://composio.dev/connect/ugc-proof-only",
	]);
	expect(fixture.unexpectedExternalRequests).toEqual([]);
	await popup.close();

	const refreshRequests = requestsFor(
		fixture,
		"POST",
		"/api/ugc/campaigns/campaign-aurora/refresh"
	);
	expect(refreshRequests).toHaveLength(2);
	expect(refreshRequests[0]?.body).toBeNull();
	expect(refreshRequests[1]?.body).toBeNull();
	await page.getByRole("button", { name: "Reload", exact: true }).click();
	await waitForRequest(fixture, "GET", "/api/ugc/campaigns");
	expectAuthenticatedLocalRequests(fixture);
});

test("new submission validates selection, surfaces a conflict, retries, and persists the post", async ({
	page,
}) => {
	const fixture = createFixture();
	fixture.failSubmissionCreateOnce = true;
	await installFixture(page, fixture);
	await openPanel(page);

	await page
		.getByRole("button", { name: "Add submission", exact: true })
		.click();
	let dialog = page.getByRole("dialog", { name: "Record a submission" });
	let save = dialog.getByRole("button", { name: "Record submission" });
	await expect(save).toBeDisabled();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	expect(requestsFor(fixture, "POST", "/api/ugc/submissions")).toHaveLength(0);
	await page
		.getByRole("button", { name: "Add submission", exact: true })
		.click();
	dialog = page.getByRole("dialog", { name: "Record a submission" });
	save = dialog.getByRole("button", { name: "Record submission" });
	await expect(save).toBeDisabled();
	await dialog.getByLabel("Creator").selectOption("creator-ada");
	await dialog.getByLabel("Platform").selectOption("tiktok");
	await dialog
		.getByLabel("Post URL")
		.fill(" https://www.tiktok.com/@ada/video/730010 ");
	await expect(save).toBeEnabled();
	await save.click();
	await expect(
		dialog.getByText("That post was already recorded for this campaign.")
	).toBeVisible();
	await expect(dialog).toBeVisible();
	await dialog
		.getByLabel("Post URL")
		.fill(" https://www.tiktok.com/@ada/video/730011 ");
	await save.click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("link", { name: "www.tiktok.com/@ada/video/730011" })
	).toBeVisible();
	const writes = requestsFor(fixture, "POST", "/api/ugc/submissions");
	expect(writes).toHaveLength(2);
	expect(writes[0]?.body).toEqual({
		campaign_id: "campaign-aurora",
		creator_id: "creator-ada",
		platform: "tiktok",
		post_url: "https://www.tiktok.com/@ada/video/730010",
	});
	expect(writes[1]?.body).toEqual({
		campaign_id: "campaign-aurora",
		creator_id: "creator-ada",
		platform: "tiktok",
		post_url: "https://www.tiktok.com/@ada/video/730011",
	});
	const postLink = page.getByRole("link", {
		name: "www.tiktok.com/@ada/video/730011",
	});
	await expect(postLink).toHaveAttribute("target", "_blank");
	await expect(postLink).toHaveAttribute("rel", "noopener noreferrer");
	const postPopupPromise = page.waitForEvent("popup");
	await postLink.click();
	const postPopup = await postPopupPromise;
	await expect(postPopup).toHaveTitle("Local post link fixture");
	await expect(postPopup.locator("body")).toContainText(
		"External post navigation was intercepted locally"
	);
	expect(fixture.postStubRequests).toEqual([
		"https://www.tiktok.com/@ada/video/730011",
	]);
	await postPopup.close();

	await page.getByLabel("Filter submissions by status").selectOption("pending");
	await waitForRequest(
		fixture,
		"GET",
		"/api/ugc/campaigns/campaign-aurora/submissions?status=pending"
	);
	await expect(
		page.getByRole("row").filter({ hasText: "730011" })
	).toBeVisible();
	await expect(page.getByRole("row").filter({ hasText: "730000" })).toHaveCount(
		0
	);
	await page.screenshot({
		path: `${EVIDENCE_DIRECTORY}/submissions-pending-filter.png`,
	});
	expect(
		fixture.submissions.some((row) => row.external_post_id === "730011")
	).toBe(true);
	expect(fixture.unexpectedExternalRequests).toEqual([]);
	expectAuthenticatedLocalRequests(fixture);
});

test("review decisions and hand-entered metrics retain errors, cancel cleanly, and write complete snapshots", async ({
	page,
}) => {
	const fixture = createFixture();
	fixture.failReviewApproveOnce = true;
	fixture.failMetricsWriteOnce = true;
	await installFixture(page, fixture);
	await openPanel(page);

	const approvalRow = page.getByRole("row").filter({ hasText: "730001" });
	await approvalRow
		.getByRole("button", { name: "Approve", exact: true })
		.click();
	await expect(
		page.getByText("Review service temporarily unavailable.")
	).toBeVisible();
	await approvalRow
		.getByRole("button", { name: "Approve", exact: true })
		.click();
	await expect(approvalRow).toContainText("approved");
	const approvalWrites = requestsFor(
		fixture,
		"POST",
		"/api/ugc/submissions/submission-pending-approve/review"
	);
	expect(approvalWrites).toHaveLength(2);
	expect(approvalWrites[0]?.body).toEqual({ decision: "approve" });
	expect(approvalWrites[1]?.body).toEqual({ decision: "approve" });
	expect(
		fixture.payouts.some(
			(row) => row.submission_id === "submission-pending-approve"
		)
	).toBe(true);

	const rejectionRow = page.getByRole("row").filter({ hasText: "730004" });
	await rejectionRow
		.getByRole("button", { name: "Reject", exact: true })
		.click();
	const rejectionDialog = page.getByRole("dialog", {
		name: "Reject this submission?",
	});
	await rejectionDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(rejectionDialog).toBeHidden();
	expect(
		requestsFor(
			fixture,
			"POST",
			"/api/ugc/submissions/submission-pending-reject/review"
		)
	).toHaveLength(0);
	await rejectionRow
		.getByRole("button", { name: "Reject", exact: true })
		.click();
	await rejectionDialog
		.getByLabel("Reason")
		.fill("  Missing the required hashtag  ");
	await rejectionDialog
		.getByRole("button", { name: "Reject submission" })
		.click();
	await expect(rejectionDialog).toBeHidden();
	await expect(rejectionRow).toContainText("rejected");
	expect(
		lastRequest(
			fixture,
			"POST",
			"/api/ugc/submissions/submission-pending-reject/review"
		).body
	).toEqual({ decision: "reject", reason: "Missing the required hashtag" });
	expect(
		fixture.submissions.find((row) => row.id === "submission-pending-reject")
			?.rejection_reason
	).toBe("Missing the required hashtag");

	const metricsRow = page.getByRole("row").filter({ hasText: "730000" });
	const postLink = metricsRow.getByRole("link");
	await expect(postLink).toHaveAttribute(
		"href",
		"https://www.tiktok.com/@ada/video/730000"
	);
	await metricsRow
		.getByRole("button", { name: "Record metrics", exact: true })
		.click();
	let metricsDialog = page.getByRole("dialog", { name: "Record metrics" });
	await expect(metricsDialog.getByLabel("Views")).toHaveValue("12345");
	await expect(metricsDialog.getByLabel("Likes")).toHaveValue("555");
	await expect(metricsDialog.getByLabel("Comments")).toHaveValue("77");
	await expect(metricsDialog.getByLabel("Shares")).toHaveValue("25");
	await expect(metricsDialog.getByLabel("Saves")).toHaveValue("43");
	await metricsDialog.getByLabel("Likes").fill("999");
	await metricsDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(metricsDialog).toBeHidden();
	expect(
		requestsFor(
			fixture,
			"POST",
			"/api/ugc/submissions/submission-accrued/metrics"
		)
	).toHaveLength(0);

	await metricsRow
		.getByRole("button", { name: "Record metrics", exact: true })
		.click();
	metricsDialog = page.getByRole("dialog", { name: "Record metrics" });
	await expect(metricsDialog.getByLabel("Likes")).toHaveValue("555");
	await metricsDialog.getByLabel("Views").fill("12.5");
	await metricsDialog.getByRole("button", { name: "Record metrics" }).click();
	await expect(
		metricsDialog.getByText(
			"Every counter must be a whole number, e.g. 12000. Blank is 0."
		)
	).toBeVisible();
	expect(
		requestsFor(
			fixture,
			"POST",
			"/api/ugc/submissions/submission-accrued/metrics"
		)
	).toHaveLength(0);

	await metricsDialog.getByLabel("Views").fill("20000");
	await metricsDialog.getByRole("button", { name: "Record metrics" }).click();
	await expect(
		metricsDialog.getByText("Metric history store temporarily unavailable.")
	).toBeVisible();
	await expect(metricsDialog).toBeVisible();
	await metricsDialog.getByRole("button", { name: "Record metrics" }).click();
	await expect(metricsDialog).toBeHidden();
	await expect(metricsRow).toContainText("20,000");
	const metricWrites = requestsFor(
		fixture,
		"POST",
		"/api/ugc/submissions/submission-accrued/metrics"
	);
	expect(metricWrites).toHaveLength(2);
	const expectedSnapshot = {
		comments: 77,
		likes: 555,
		saves: 43,
		shares: 25,
		views: 20_000,
	};
	expect(metricWrites[0]?.body).toEqual(expectedSnapshot);
	expect(metricWrites[1]?.body).toEqual(expectedSnapshot);
	expect(
		fixture.submissions.find((row) => row.id === "submission-accrued")?.latest
	).toMatchObject({
		...expectedSnapshot,
		source: "manual",
	});
	expect(fixture.metricHistory["submission-accrued"]).toHaveLength(2);
	expect(fixture.metricHistory["submission-accrued"]?.[0]?.views).toBe(12_345);
	expect(fixture.metricHistory["submission-accrued"]?.[1]?.views).toBe(20_000);
	expect(
		fixture.payouts.find((row) => row.submission_id === "submission-accrued")
			?.amount_cents
	).toBe(5000);
	const refreshPost = metricsRow.locator(
		'button[title="Refresh this post\'s metrics"]'
	);
	await refreshPost.click();
	await expect(page.getByText("1 needs a connection.")).toBeVisible();
	expect(
		requestsFor(
			fixture,
			"POST",
			"/api/ugc/submissions/submission-accrued/refresh"
		)
	).toHaveLength(1);
	await expect(
		page.getByRole("link", { name: "Connect account" })
	).toBeVisible();
	await page.screenshot({
		path: `${EVIDENCE_DIRECTORY}/manual-metrics-persisted.png`,
	});
	expectAuthenticatedLocalRequests(fixture);
});

test("payout filters require confirmation and only record local settlement state", async ({
	page,
}) => {
	const fixture = createFixture();
	await installFixture(page, fixture);
	await openPanel(page);
	await page.getByRole("tab", { name: "Payouts", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();

	await page.getByLabel("Filter payouts by status").selectOption("accrued");
	await waitForRequest(fixture, "GET", "/api/ugc/payouts?status=accrued");
	const accruedRow = page.getByRole("row").filter({ hasText: "$25.00" });
	await accruedRow
		.getByRole("button", { name: "Approve", exact: true })
		.click();
	let confirm = page.getByRole("alertdialog", { name: "Approve this payout?" });
	await expect(confirm).toContainText("$25.00 to Ada Lovelace");
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(confirm).toBeHidden();
	expect(
		requestsFor(fixture, "POST", "/api/ugc/payouts/payout-accrued/approve")
	).toHaveLength(0);
	await accruedRow
		.getByRole("button", { name: "Approve", exact: true })
		.click();
	confirm = page.getByRole("alertdialog", { name: "Approve this payout?" });
	await confirm.getByRole("button", { name: "Approve payout" }).click();
	await expect(confirm).toBeHidden();
	await expect
		.poll(
			() => fixture.payouts.find((row) => row.id === "payout-accrued")?.status
		)
		.toBe("approved");
	expect(
		requestsFor(fixture, "POST", "/api/ugc/payouts/payout-accrued/approve")
	).toHaveLength(1);

	await page.getByLabel("Filter payouts by status").selectOption("approved");
	await waitForRequest(fixture, "GET", "/api/ugc/payouts?status=approved");
	const paidRow = page.getByRole("row").filter({ hasText: "$42.00" });
	await paidRow.getByRole("button", { name: "Mark paid", exact: true }).click();
	confirm = page.getByRole("alertdialog", {
		name: "Mark this payout as paid?",
	});
	await expect(confirm).toContainText("This cannot be undone.");
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(confirm).toBeHidden();
	expect(
		requestsFor(fixture, "POST", "/api/ugc/payouts/payout-approved/paid")
	).toHaveLength(0);
	await paidRow.getByRole("button", { name: "Mark paid", exact: true }).click();
	confirm = page.getByRole("alertdialog", {
		name: "Mark this payout as paid?",
	});
	await expect(confirm).toBeVisible();
	await expect(confirm).toHaveCSS("opacity", "1");
	const confirmBounds = await confirm.boundingBox();
	expect(confirmBounds?.width).toBeGreaterThan(0);
	expect(confirmBounds?.height).toBeGreaterThan(0);
	await page.screenshot({
		path: `${EVIDENCE_DIRECTORY}/payout-confirmation.png`,
		animations: "disabled",
	});
	await confirm.getByRole("button", { name: "Mark paid" }).click();
	await expect(confirm).toBeHidden();
	await expect
		.poll(
			() => fixture.payouts.find((row) => row.id === "payout-approved")?.status
		)
		.toBe("paid");
	await expect
		.poll(
			() =>
				fixture.submissions.find((row) => row.id === "submission-approved")
					?.status
		)
		.toBe("paid");
	expect(
		requestsFor(fixture, "POST", "/api/ugc/payouts/payout-approved/paid")
	).toHaveLength(1);
	expect(
		lastRequest(fixture, "POST", "/api/ugc/payouts/payout-approved/paid").body
	).toBeNull();
	await page.getByLabel("Filter payouts by status").selectOption("paid");
	await waitForRequest(fixture, "GET", "/api/ugc/payouts?status=paid");
	await expect(
		page.getByRole("row").filter({ hasText: "$42.00" })
	).toContainText("paid");
	await page.getByRole("tab", { name: "Campaigns", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Aurora Spring Launch" })
	).toBeVisible();
	expectAuthenticatedLocalRequests(fixture);
});

test("managed Composio status links to Gateway keys and never calls UGC key routes", async ({
	page,
}) => {
	const fixture = createFixture(false);
	await installFixture(page, fixture);
	await openPanel(page);
	await expect(
		page.getByText(/No managed Composio provider is configured on this node/u)
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Gateway keys", exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "Gateway keys", exact: true }).click();
	await expect(page.getByTestId("gateway-intent")).toHaveAttribute(
		"data-open",
		"true"
	);
	await expect(page.getByTestId("gateway-intent")).toHaveAttribute(
		"data-section",
		"keys"
	);
	await page
		.getByRole("button", {
			name: "Composio settings in Gateway → Keys",
			exact: true,
		})
		.click();
	await expect(page.getByTestId("gateway-intent")).toHaveAttribute(
		"data-section",
		"keys"
	);

	const paths = fixture.requests.map((request) => request.path);
	expect(paths.some((path) => /\/settings(?:\/|$)/u.test(path))).toBe(false);
	expect(paths.some((path) => path.includes("composio-key"))).toBe(false);
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true
	);
	await page.screenshot({
		path: `${EVIDENCE_DIRECTORY}/managed-provider-gateway-keys-entry.png`,
	});
	expectAuthenticatedLocalRequests(fixture);
});

test("disabled UGC app shows the enable explanation without reaching its sidecar", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	await page.goto(`${STORY_URL}?disabled=1`);
	await expect(
		page.getByText(/Enable the UGC app to track creator campaigns/u)
	).toBeVisible();
	await expect(
		page.getByRole("tab", { name: "Campaigns", exact: true })
	).toHaveCount(0);
	expect(fixture.requests).toEqual([]);
	expect(fixture.unexpectedRoutes).toEqual([]);
	await page.screenshot({
		path: `${EVIDENCE_DIRECTORY}/disabled-app-state.png`,
	});
});
