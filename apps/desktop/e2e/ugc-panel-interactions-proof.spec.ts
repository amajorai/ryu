import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
	expectAuthenticatedLocalRequests,
	installFixture,
	lastRequest,
	openPanel,
	requestsFor,
	waitForRequest,
} from "./ugc-panel-interactions-proof.data.ts";
import {
	createFixture,
	EVIDENCE_DIRECTORY,
} from "./ugc-panel-interactions-proof.helpers.ts";

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
