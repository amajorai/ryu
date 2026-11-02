import { expect, type Page } from "@playwright/test";
import { parseProofJson } from "./fixture-json.ts";
import {
	API_BASE,
	type ApiFixture,
	type ApiResponse,
	type CampaignFixture,
	type CreatorFixture,
	campaignSummary,
	createFixture,
	creatorLeaderboard,
	failed,
	NODE_TOKEN,
	nextId,
	ok,
	overview,
	type RecordedRequest,
	refreshReport,
	type SnapshotFixture,
	STORY_URL,
	type SubmissionFixture,
	visibleSubmissions,
} from "./ugc-panel-interactions-proof.helpers.ts";

// Fixtures and helpers for ugc-panel-interactions-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export function dispatch(
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

export async function installFixture(
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

export async function openPanel(page: Page, query = ""): Promise<void> {
	await page.goto(`${STORY_URL}${query}`);
	await expect(
		page.getByRole("tab", { name: "Campaigns", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Aurora Spring Launch/u })
	).toBeVisible();
}

export function requestsFor(fixture: ApiFixture, method: string, path: string) {
	return fixture.requests.filter(
		(request) => request.method === method && request.path === path
	);
}

export async function waitForRequest(
	fixture: ApiFixture,
	method: string,
	path: string,
	count = 1
): Promise<void> {
	await expect
		.poll(() => requestsFor(fixture, method, path).length)
		.toBeGreaterThanOrEqual(count);
}

export function lastRequest(
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

export function expectAuthenticatedLocalRequests(fixture: ApiFixture): void {
	expect(fixture.unexpectedRoutes).toEqual([]);
	expect(fixture.requests.length).toBeGreaterThan(0);
	for (const request of fixture.requests) {
		expect(request.authorization).toBe(`Bearer ${NODE_TOKEN}`);
		expect(request.path).toMatch(/^\/api\/ugc(?:\/|\?|$)/u);
	}
}
