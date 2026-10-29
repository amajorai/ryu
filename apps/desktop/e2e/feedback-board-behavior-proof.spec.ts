import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	type FeedbackFixtureSnapshot,
	parseFeedbackFixtureSnapshot,
} from "./feedback-board-fixture-contract.ts";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

async function resetFixture(page: Page, emptyBoard = false) {
	const response = await page.request.post("/__fixture/reset", {
		data: { emptyBoard },
	});
	expect(response.ok()).toBe(true);
}

async function fixtureState(page: Page): Promise<FeedbackFixtureSnapshot> {
	const response = await page.request.get("/__fixture/state");
	expect(response.ok()).toBe(true);
	return parseFeedbackFixtureSnapshot(await response.text());
}

async function expectModeOptionDescriptionsFit(container: Locator) {
	const descriptions = container.locator(
		".admin-mode-grid .admin-mode-card > span"
	);
	await expect(descriptions).toHaveCount(5);
	const overflow = await descriptions.evaluateAll((elements) =>
		elements.map((element) => element.scrollWidth > element.clientWidth)
	);
	expect(overflow).toEqual([false, false, false, false, false]);
}

test("public board search, voting, comments, submissions, and reload use persisted API state", async ({
	page,
}) => {
	await resetFixture(page);
	await page.goto("/feedback/demo");
	await expect(page.getByRole("heading", { name: "Feedback" })).toBeVisible();
	await expect(page.getByText("3 requests", { exact: true })).toBeVisible();

	await page.getByLabel("Search feedback").fill("dark mode");
	await expect(
		page.getByRole("button", { name: /Dark mode toggle/ })
	).toBeVisible();
	await expect(page.getByRole("button", { name: /CSV export/ })).toHaveCount(0);
	await page.getByLabel("Search feedback").fill("");
	await page.getByLabel("Sort feedback").selectOption("new");
	await expect(
		page.getByText("Sorted by newest", { exact: false })
	).toBeVisible();
	expect(
		await page.locator(".feedback-request-title").allTextContents()
	).toEqual(["Keyboard navigation", "Dark mode toggle", "CSV export"]);

	await page
		.getByRole("button", { name: "Vote for this request, 3 votes" })
		.click();
	await expect(
		page.getByRole("button", { name: "Vote for this request, 4 votes" })
	).toBeVisible();
	await page.getByRole("button", { name: /CSV export/ }).click();
	const detail = page.getByRole("complementary", { name: "Request detail" });
	await expect(
		detail.getByRole("heading", { name: "CSV export" })
	).toBeVisible();
	await detail
		.getByRole("button", { name: "Vote for this request, 4 votes" })
		.click();
	await expect(
		detail.getByRole("button", { name: "Vote for this request, 4 votes" })
	).toBeVisible();
	await detail
		.getByRole("textbox", { name: "Comment" })
		.fill("Please include a selectable date range.");
	await detail.getByRole("textbox", { name: "Your name" }).fill("Lin");
	await detail.getByRole("button", { name: "Post comment" }).click();
	await expect(
		detail
			.locator(".feedback-comment")
			.getByText("Please include a selectable date range.", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Comment posted.")).toBeVisible();
	await detail.getByRole("button", { name: /All feedback/ }).click();

	await page.getByRole("button", { name: /Share feedback/ }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await page.getByRole("button", { name: /Share feedback/ }).click();
	await dialog.getByLabel("Short title").fill("Discarded draft");
	await dialog
		.getByLabel("Tell us more")
		.fill("This draft should not be submitted.");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await page.getByRole("button", { name: /Share feedback/ }).click();
	await expect(dialog).toBeVisible();
	const shareButton = dialog.getByRole("button", { name: "Share feedback" });
	await expect(shareButton).toBeDisabled();
	await dialog.getByLabel("Short title").fill("Saved export presets");
	await dialog
		.getByLabel("Tell us more")
		.fill("Let us save reusable export configurations.");
	await dialog.getByLabel("Category").selectOption("Bugs");
	await dialog.getByLabel("Your name").fill("Jo");
	await dialog.getByLabel("Email for updates").fill("jo@example.test");
	await expect(shareButton).toBeEnabled();
	await page.request.post("/__fixture/fail-next", {
		data: {
			method: "POST",
			path: "/feedback/demo/requests",
			status: 503,
		},
	});
	await shareButton.click();
	const submitError = dialog.getByRole("alert");
	await expect(submitError).toContainText(
		"The public fixture rejected that action."
	);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel("Short title")).toHaveValue(
		"Saved export presets"
	);
	await page.screenshot({
		path: path.join(
			evidenceDir,
			"feedback-board-public-request-error-draft-preserved.png"
		),
	});
	await submitError.getByRole("button", { name: "Dismiss" }).click();
	await expect(submitError).toHaveCount(0);
	await shareButton.click();
	await expect(page.getByText("Your feedback is on the board.")).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Saved export presets/ })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "feedback-board-public-request-created.png"),
	});

	const state = await fixtureState(page);
	const created = state.requests.find(
		(request) => request.title === "Saved export presets"
	);
	expect(created).toMatchObject({
		author_email: "jo@example.test",
		author_name: "Jo",
		body: "Let us save reusable export configurations.",
		category: "Bugs",
		moderation_state: "approved",
		public_visible: true,
	});
	expect(
		state.requests.filter((request) => request.title === "Saved export presets")
	).toHaveLength(1);
	expect(state.comments.find(([id]) => id === "req-export")?.[1]).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				author_name: "Lin",
				body: "Please include a selectable date range.",
			}),
		])
	);
	const submitCall = state.calls.find(
		(call) =>
			call.surface === "public-api" &&
			call.method === "POST" &&
			call.path === "/feedback/demo/requests"
	);
	expect(submitCall?.body).toMatchObject({
		author_name: "Jo",
		body: "Let us save reusable export configurations.",
		category: "Bugs",
		email: "jo@example.test",
		title: "Saved export presets",
	});
	expect(
		state.calls.filter(
			(call) =>
				call.surface === "public-api" &&
				call.method === "POST" &&
				call.path === "/feedback/demo/requests"
		)
	).toHaveLength(2);

	await page.goto("/feedback/demo");
	await expect(
		page.getByRole("button", { name: /Saved export presets/ })
	).toBeVisible();
	await page.getByRole("button", { name: /CSV export/ }).click();
	await expect(
		page.getByText("Please include a selectable date range.")
	).toBeVisible();
	const csvCard = page.getByRole("article").filter({ hasText: "CSV export" });
	await csvCard
		.getByRole("button", { name: "Vote for this request, 4 votes" })
		.click();
	await expect(
		csvCard.getByRole("button", { name: "Vote for this request, 4 votes" })
	).toBeVisible();
	expect(
		(await fixtureState(page)).requests.find(
			(request) => request.id === "req-export"
		)?.vote_count
	).toBe(4);
});

test("public comment failures keep the draft available for retry and Dismiss clears the error", async ({
	page,
}) => {
	await resetFixture(page);
	await page.goto("/feedback/demo");
	await page.getByRole("button", { name: /CSV export/ }).click();
	const detail = page.getByRole("complementary", { name: "Request detail" });
	await page.request.post("/__fixture/fail-next", {
		data: {
			method: "POST",
			path: "/feedback/demo/requests/req-export/comments",
			status: 503,
		},
	});
	await detail
		.getByRole("textbox", { name: "Comment" })
		.fill("This draft should survive a failed post.");
	await detail.getByRole("button", { name: "Post comment" }).click();
	await expect(page.locator(".feedback-error")).toContainText(
		"The public fixture rejected that action."
	);
	await page.screenshot({
		fullPage: true,
		path: path.join(
			evidenceDir,
			"feedback-board-public-comment-error-draft-preserved.png"
		),
	});
	await page
		.locator(".feedback-error")
		.getByRole("button", { name: "Dismiss" })
		.click();
	await expect(page.locator(".feedback-error")).toHaveCount(0);
	await expect(detail.getByRole("textbox", { name: "Comment" })).toHaveValue(
		"This draft should survive a failed post."
	);
	await detail.getByRole("button", { name: "Post comment" }).click();
	await expect(
		detail
			.getByRole("paragraph")
			.filter({ hasText: "This draft should survive a failed post." })
	).toBeVisible();
	await expect(page.getByText("Comment posted.")).toBeVisible();
});

test("admin queue edits recover from failures and triage/brief/build operations persist results", async ({
	page,
}) => {
	await resetFixture(page);
	await page.goto("/?view=requests");
	await expect(page.getByRole("heading", { name: "Requests" })).toBeVisible();
	await page.getByLabel("Search requests").fill("dark mode");
	await expect(
		page.getByRole("button", { name: /Dark mode toggle/ })
	).toBeVisible();
	await expect(page.getByRole("button", { name: /CSV export/ })).toHaveCount(0);
	await page.getByLabel("Search requests").fill("");
	await page.getByRole("button", { name: /CSV export/ }).click();
	const detail = page.getByRole("region", { name: /Request detail/ });
	await expect(
		detail.getByRole("heading", { name: "CSV export" })
	).toBeVisible();
	let state: FeedbackFixtureSnapshot;

	await page.request.post("/__fixture/fail-next", {
		data: { method: "PUT", path: "/admin/requests/req-export", status: 503 },
	});
	await detail.getByLabel("Status").selectOption("planned");
	await expect(page.getByRole("alert")).toContainText(
		"Feedback Board could not complete that operator action."
	);
	await page
		.getByRole("alert")
		.getByRole("button", { name: "Dismiss" })
		.click();
	await detail.getByLabel("Status").selectOption("planned");
	await expect(detail.getByLabel("Status")).toHaveValue("planned");
	await expect(page.getByRole("status")).toContainText("Request updated.");
	await page
		.getByRole("status")
		.getByRole("button", { name: "Dismiss" })
		.click();
	await expect(page.getByRole("status")).toHaveCount(0);
	const beforeRefresh = await fixtureState(page);
	const requestListReadsBeforeRefresh = beforeRefresh.calls.filter(
		(call) => call.method === "GET" && call.path === "/admin/requests"
	).length;
	await page.getByRole("button", { name: "Refresh Feedback Board" }).click();
	await expect
		.poll(async () => {
			const refreshed = await fixtureState(page);
			return refreshed.calls.filter(
				(call) => call.method === "GET" && call.path === "/admin/requests"
			).length;
		})
		.toBe(requestListReadsBeforeRefresh + 1);
	const refreshedRequestState = await fixtureState(page);
	expect(
		refreshedRequestState.requests.find(
			(request) => request.id === "req-export"
		)?.status
	).toBe("planned");
	await expect(detail.getByLabel("Status")).toHaveValue("planned");

	await detail.getByRole("button", { name: "Triage with Ryu" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Ryu prepared a triage suggestion."
	);
	await expect(
		detail.getByText("Export helps teams report demand.")
	).toBeVisible();
	await detail.getByRole("button", { name: "Discard" }).click();
	await expect(detail.getByText("Ryu suggestion")).toHaveCount(0);
	await detail.getByRole("button", { name: "Triage with Ryu" }).click();
	await detail.getByRole("button", { name: "Save triage" }).click();
	await expect(page.getByRole("status")).toContainText("Request updated.");
	state = await fixtureState(page);
	expect(
		state.requests.find((request) => request.id === "req-export")
	).toMatchObject({
		ai_summary: "Export helps teams report demand.",
		category: "Ideas",
		impact_score: 84,
		tags: ["reporting", "exports"],
	});
	expect(state.calls).toContainEqual(
		expect.objectContaining({
			body: expect.objectContaining({
				suggestion: expect.objectContaining({
					summary: "Export helps teams report demand.",
					tags: ["reporting", "exports"],
				}),
			}),
			method: "POST",
			path: "/admin/requests/req-export/triage",
			surface: "admin-api",
		})
	);

	await detail.getByRole("button", { name: "Create brief" }).click();
	await expect(
		detail.getByRole("button", { name: "Refresh brief" })
	).toBeVisible();
	state = await fixtureState(page);
	const briefRequest = state.requests.find(
		(request) => request.id === "req-export"
	);
	expect(briefRequest?.space_doc_id).toBe("doc-1");
	expect(state.docs).toEqual(
		expect.arrayContaining([
			expect.arrayContaining([
				"doc-1",
				expect.objectContaining({ title: "Feedback request: CSV export" }),
			]),
		])
	);
	const briefUpdatesBeforeRefresh = state.calls.filter(
		(call) => call.surface === "spaces-bridge" && call.path.endsWith("/update")
	).length;
	await detail.getByRole("button", { name: "Refresh brief" }).click();
	await expect
		.poll(async () => {
			const refreshed = await fixtureState(page);
			return refreshed.calls.filter(
				(call) =>
					call.surface === "spaces-bridge" && call.path.endsWith("/update")
			).length;
		})
		.toBe(briefUpdatesBeforeRefresh + 1);
	await expect(page.getByRole("status")).toContainText("Request updated.");
	state = await fixtureState(page);
	expect(state.docs).toHaveLength(1);
	expect(
		state.calls.filter(
			(call) =>
				call.surface === "spaces-bridge" && call.path.endsWith("/update")
		)
	).toHaveLength(briefUpdatesBeforeRefresh + 1);
	expect(state.calls).toContainEqual(
		expect.objectContaining({
			body: expect.objectContaining({
				doc_id: "doc-1",
				title: "Feedback request: CSV export",
			}),
			method: "POST",
			path: "/__fixture/bridge/spaces/update",
			surface: "spaces-bridge",
		})
	);

	for (const [label, mode] of [
		["Manual", "manual"],
		["Assist", "assist"],
		["Prepare", "prepare"],
		["Autopilot", "autopilot"],
		["Build with review", "build_review"],
	] as const) {
		await detail.getByRole("button", { name: new RegExp(label, "i") }).click();
		state = await fixtureState(page);
		expect(
			state.requests.find((request) => request.id === "req-export")
				?.automation_mode
		).toBe(mode);
	}
	await detail
		.getByRole("button", { name: "Prepare build with Blueprint" })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"Ryu started the build workflow."
	);
	state = await fixtureState(page);
	expect(state.workflowInputs).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: "workflow-feedback",
				input: expect.objectContaining({
					request: expect.stringContaining("CSV export"),
				}),
			}),
		])
	);
	expect(
		state.requests.find((request) => request.id === "req-export")
			?.workflow_run_id
	).toBe("workflow-run-1");
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "feedback-board-admin-build-run-saved.png"),
	});
});

test("automation defaults, workspace settings and changelog drafts persist across view reloads", async ({
	page,
}) => {
	await resetFixture(page);
	await page.goto("/?view=automation");
	await expect(
		page.getByRole("heading", { name: "Automation", level: 1 })
	).toBeVisible();
	await page.getByRole("button", { name: /Autopilot/ }).click();
	await page.getByLabel("Agent id").fill("agent-reviewer");
	await page.getByLabel("Workflow id").fill("");
	await page.getByRole("button", { name: "Save automation defaults" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Automation defaults saved."
	);
	let state = await fixtureState(page);
	expect(state.workspace).toMatchObject({
		default_agent_id: "agent-reviewer",
		default_automation_mode: "autopilot",
		default_workflow_id: null,
	});
	expect(state.calls).toContainEqual(
		expect.objectContaining({
			body: {
				default_agent_id: "agent-reviewer",
				default_automation_mode: "autopilot",
				default_workflow_id: null,
				revision: 1,
			},
			method: "PUT",
			path: "/admin/workspace",
			surface: "admin-api",
		})
	);
	await page.reload();
	await expect(page.getByLabel("Agent id")).toHaveValue("agent-reviewer");
	await expect(page.getByLabel("Workflow id")).toHaveValue("");

	await page.goto("/?view=settings");
	await page.getByLabel("Workspace name").fill("Ryu Builders");
	await page
		.getByLabel("Public description")
		.fill("A board for shipping useful product improvements.");
	await page
		.getByRole("checkbox", { name: "Moderate public submissions" })
		.check();
	await page.getByRole("button", { name: "Save board settings" }).click();
	await expect(page.getByRole("status")).toContainText("Board settings saved.");
	state = await fixtureState(page);
	expect(state.workspace).toMatchObject({
		moderate_public_writes: true,
		description: "A board for shipping useful product improvements.",
		name: "Ryu Builders",
	});
	expect(state.board.moderate_public_writes).toBe(true);
	expect(state.calls).toContainEqual(
		expect.objectContaining({
			body: expect.objectContaining({
				description: "A board for shipping useful product improvements.",
				moderate_public_writes: true,
				name: "Ryu Builders",
			}),
			method: "PUT",
			path: "/admin/workspace",
			surface: "admin-api",
		})
	);
	expect(
		state.calls.filter(
			(call) =>
				call.surface === "admin-api" &&
				call.method === "PUT" &&
				call.path.startsWith("/admin/boards/")
		)
	).toHaveLength(0);
	await page.reload();
	await expect(page.getByLabel("Workspace name")).toHaveValue("Ryu Builders");
	await expect(page.getByLabel("Public description")).toHaveValue(
		"A board for shipping useful product improvements."
	);
	await expect(
		page.getByRole("checkbox", { name: "Moderate public submissions" })
	).toBeChecked();

	await page.goto("/?view=changelog");
	await expect(page.getByText("1 shipped requests ready")).toBeVisible();
	const draftButton = page.getByRole("button", {
		name: "Save changelog draft",
	});
	await expect(draftButton).toBeDisabled();
	await page.getByLabel("Release title").fill("Better keyboard flow");
	await page
		.getByLabel("Release body")
		.fill("Keyboard navigation now covers the feedback queue.");
	await expect(draftButton).toBeEnabled();
	await draftButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Changelog draft saved."
	);
	state = await fixtureState(page);
	expect(state.releases).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				body: "Keyboard navigation now covers the feedback queue.",
				request_ids: ["req-shipped"],
				status: "draft",
				title: "Better keyboard flow",
			}),
		])
	);
	await page.goto("/feedback/demo");
	await page.getByRole("button", { name: "Changelog" }).click();
	await expect(
		page.getByRole("heading", { name: "Keyboard navigation" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Better keyboard flow" })
	).toHaveCount(0);
	await page.screenshot({
		fullPage: true,
		path: path.join(
			evidenceDir,
			"feedback-board-public-changelog-projection.png"
		),
	});
	const brandLink = page.getByRole("link", { name: "Ryu Builders" });
	await expect(brandLink).toHaveAttribute("href", "/feedback/demo");
	await brandLink.click();
	await expect(page.getByRole("heading", { name: "Feedback" })).toBeVisible();
	await page.getByRole("button", { name: "Roadmap" }).click();
	await expect(page.getByRole("heading", { name: "Roadmap" })).toBeVisible();
	await expect(page.getByText("CSV export", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Feedback", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Feedback" })).toBeVisible();
});

test("moderated guest submissions are acknowledged and can be approved or rejected", async ({
	page,
}) => {
	await resetFixture(page);
	await page.goto("/?view=settings");
	await page
		.getByRole("checkbox", { name: "Moderate public submissions" })
		.check();
	await page.getByRole("button", { name: "Save board settings" }).click();
	await expect(page.getByRole("status")).toContainText("Board settings saved.");
	await page.goto("/feedback/demo");
	await page.getByRole("button", { name: /Share feedback/ }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Short title").fill("Moderated customer request");
	await dialog
		.getByLabel("Tell us more")
		.fill("Please review before showing this publicly.");
	await dialog.getByRole("button", { name: "Share feedback" }).click();
	await expect(
		page.getByText("Your feedback was sent for review.")
	).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /Moderated customer request/ })
	).toHaveCount(0);
	let state = await fixtureState(page);
	const pending = state.requests.filter(
		(request) => request.title === "Moderated customer request"
	);
	expect(pending).toHaveLength(1);
	expect(pending[0]).toMatchObject({
		moderation_state: "pending",
		public_visible: false,
	});
	expect(
		state.calls.filter(
			(call) =>
				call.surface === "public-api" &&
				call.method === "POST" &&
				call.path === "/feedback/demo/requests"
		)
	).toHaveLength(1);
	expect(state.calls).toContainEqual(
		expect.objectContaining({
			method: "POST",
			path: "/feedback/demo/requests",
			surface: "public-api",
			body: expect.objectContaining({ title: "Moderated customer request" }),
		})
	);
	await page.screenshot({
		fullPage: true,
		path: path.join(
			evidenceDir,
			"feedback-board-moderated-submission-acknowledged.png"
		),
	});

	await page.goto("/?view=requests");
	await page
		.getByRole("button", { name: /Moderated customer request/ })
		.click();
	const pendingDetail = page.getByRole("region", { name: "Request detail" });
	await expect(
		pendingDetail.getByText("Waiting for moderation review.")
	).toBeVisible();
	await expectModeOptionDescriptionsFit(pendingDetail);
	await page.screenshot({
		fullPage: true,
		path: path.join(
			evidenceDir,
			"feedback-board-admin-pending-request-review.png"
		),
	});
	await pendingDetail
		.getByRole("button", { name: "Approve and publish" })
		.click();
	await expect(page.getByRole("status")).toContainText("Request updated.");
	state = await fixtureState(page);
	expect(
		state.requests.find(
			(request) => request.title === "Moderated customer request"
		)
	).toMatchObject({
		moderation_state: "approved",
		public_visible: true,
	});
	expect(state.calls).toContainEqual(
		expect.objectContaining({
			body: {
				moderation_state: "approved",
				public_visible: true,
				revision: 1,
			},
			method: "PUT",
			path: `/admin/requests/${pending[0]?.id}`,
			surface: "admin-api",
		})
	);

	await page.goto("/feedback/demo");
	await expect(
		page.getByRole("button", { name: /Moderated customer request/ })
	).toBeVisible();
	await page
		.getByRole("button", { name: /Moderated customer request/ })
		.click();
	const publicDetail = page.getByRole("complementary", {
		name: "Request detail",
	});
	await publicDetail
		.getByRole("textbox", { name: "Comment" })
		.fill("Please review this public comment.");
	await publicDetail.getByRole("button", { name: "Post comment" }).click();
	await expect(page.getByText("Comment sent for review.")).toBeVisible();
	await expect(
		publicDetail.getByText("Please review this public comment.")
	).toHaveCount(0);
	state = await fixtureState(page);
	const initialComments = state.comments.find(
		([requestId]) => requestId === pending[0]?.id
	)?.[1];
	expect(initialComments).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				body: "Please review this public comment.",
				moderation_state: "pending",
				visibility: "public",
			}),
		])
	);
	expect(state.calls).toContainEqual(
		expect.objectContaining({
			body: { body: "Please review this public comment." },
			method: "POST",
			path: `/feedback/demo/requests/${pending[0]?.id}/comments`,
			surface: "public-api",
		})
	);
	await page.reload();
	await page
		.getByRole("button", { name: /Moderated customer request/ })
		.click();
	await expect(
		page
			.getByRole("complementary", { name: "Request detail" })
			.getByText("Please review this public comment.")
	).toHaveCount(0);
	await page.goto("/?view=requests");
	await page
		.getByRole("button", { name: /Moderated customer request/ })
		.click();
	const requestDetail = page.getByRole("region", { name: "Request detail" });
	await expectModeOptionDescriptionsFit(requestDetail);
	const pendingCommentReview = requestDetail.getByRole("region", {
		name: "Pending public comments",
	});
	await expect(pendingCommentReview).toContainText(
		"Please review this public comment."
	);
	await page.screenshot({
		fullPage: true,
		path: path.join(
			evidenceDir,
			"feedback-board-admin-pending-comment-review.png"
		),
	});
	state = await fixtureState(page);
	const commentPendingReview = state.comments
		.find(([requestId]) => requestId === pending[0]?.id)?.[1]
		.find((comment) => comment.body === "Please review this public comment.");
	expect(commentPendingReview).toBeDefined();
	await page.request.post("/__fixture/fail-next", {
		data: {
			method: "PUT",
			path: `/admin/requests/${pending[0]?.id}/comments/${commentPendingReview?.id}`,
			status: 503,
		},
	});
	await pendingCommentReview
		.getByRole("button", { name: "Approve comment" })
		.click();
	await expect(page.getByRole("alert")).toContainText(
		"Feedback Board could not complete that operator action."
	);
	await expect(pendingCommentReview).toContainText(
		"Please review this public comment."
	);
	state = await fixtureState(page);
	expect(
		state.comments.find(([requestId]) => requestId === pending[0]?.id)?.[1]
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				body: "Please review this public comment.",
				moderation_state: "pending",
			}),
		])
	);
	await page
		.getByRole("alert")
		.getByRole("button", { name: "Dismiss" })
		.click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await pendingCommentReview
		.getByRole("button", { name: "Approve comment" })
		.click();
	await expect(page.getByRole("status")).toContainText("Comment review saved.");
	state = await fixtureState(page);
	expect(
		state.comments.find(([requestId]) => requestId === pending[0]?.id)?.[1]
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				body: "Please review this public comment.",
				moderation_state: "approved",
			}),
		])
	);
	expect(state.calls).toContainEqual(
		expect.objectContaining({
			body: { approved: true, revision: 2 },
			method: "PUT",
			path: `/admin/requests/${pending[0]?.id}/comments/${commentPendingReview?.id}`,
			surface: "admin-api",
		})
	);
	expect(
		state.requests.find((request) => request.id === pending[0]?.id)
			?.comment_count
	).toBe(1);
	await page.goto("/feedback/demo");
	await page
		.getByRole("button", { name: /Moderated customer request/ })
		.click();
	const publishedCommentDetail = page.getByRole("complementary", {
		name: "Request detail",
	});
	await expect(
		publishedCommentDetail.getByText("Please review this public comment.")
	).toBeVisible();
	await publishedCommentDetail.screenshot({
		path: path.join(
			evidenceDir,
			"feedback-board-moderated-comment-approved.png"
		),
	});
	await publishedCommentDetail
		.getByRole("textbox", { name: "Comment" })
		.fill("Please reject this comment.");
	await publishedCommentDetail
		.getByRole("button", { name: "Post comment" })
		.click();
	await expect(page.getByText("Comment sent for review.")).toBeVisible();
	await page.goto("/?view=requests");
	await page
		.getByRole("button", { name: /Moderated customer request/ })
		.click();
	const rejectedCommentReview = page
		.getByRole("region", { name: "Request detail" })
		.getByRole("region", { name: "Pending public comments" });
	await expect(rejectedCommentReview).toContainText(
		"Please reject this comment."
	);
	await rejectedCommentReview
		.getByRole("button", { name: "Reject comment" })
		.click();
	await expect(page.getByRole("status")).toContainText("Comment review saved.");
	state = await fixtureState(page);
	expect(
		state.comments.find(([requestId]) => requestId === pending[0]?.id)?.[1]
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				body: "Please reject this comment.",
				moderation_state: "rejected",
			}),
		])
	);
	const rejectedComment = state.comments
		.find(([requestId]) => requestId === pending[0]?.id)?.[1]
		.find((comment) => comment.body === "Please reject this comment.");
	expect(rejectedComment).toBeDefined();
	expect(state.calls).toContainEqual(
		expect.objectContaining({
			body: { approved: false, revision: 3 },
			method: "PUT",
			path: `/admin/requests/${pending[0]?.id}/comments/${rejectedComment?.id}`,
			surface: "admin-api",
		})
	);
	await page.goto("/feedback/demo");
	await page
		.getByRole("button", { name: /Moderated customer request/ })
		.click();
	const rejectedPublicDetail = page.getByRole("complementary", {
		name: "Request detail",
	});
	await expect(
		rejectedPublicDetail.getByText("Please reject this comment.")
	).toHaveCount(0);
	await expect(
		rejectedPublicDetail.getByRole("heading", {
			exact: true,
			name: "1 comment",
		})
	).toBeVisible();
	await rejectedPublicDetail.screenshot({
		path: path.join(
			evidenceDir,
			"feedback-board-moderated-comment-rejected-hidden.png"
		),
	});

	await page.getByRole("button", { name: /Share feedback/ }).click();
	const rejectedDialog = page.getByRole("dialog");
	await rejectedDialog
		.getByLabel("Short title")
		.fill("Rejected customer request");
	await rejectedDialog
		.getByLabel("Tell us more")
		.fill("This request should remain private after rejection.");
	await rejectedDialog.getByRole("button", { name: "Share feedback" }).click();
	await expect(
		page.getByText("Your feedback was sent for review.")
	).toBeVisible();
	await page.goto("/?view=requests");
	await page.getByRole("button", { name: /Rejected customer request/ }).click();
	const rejectedDetail = page.getByRole("region", { name: "Request detail" });
	await rejectedDetail
		.getByRole("button", { name: "Reject submission" })
		.click();
	await expect(page.getByRole("status")).toContainText("Request updated.");
	state = await fixtureState(page);
	expect(
		state.requests.find(
			(request) => request.title === "Rejected customer request"
		)
	).toMatchObject({
		moderation_state: "rejected",
		public_visible: false,
	});
	const rejectedRequest = state.requests.find(
		(request) => request.title === "Rejected customer request"
	);
	expect(rejectedRequest).toBeDefined();
	expect(state.calls).toContainEqual(
		expect.objectContaining({
			body: {
				moderation_state: "rejected",
				public_visible: false,
				revision: 1,
			},
			method: "PUT",
			path: `/admin/requests/${rejectedRequest?.id}`,
			surface: "admin-api",
		})
	);
	await page.goto("/feedback/demo");
	await expect(
		page.getByRole("button", { name: /Rejected customer request/ })
	).toHaveCount(0);
});

test("empty-board call to action opens the form and publishes the first request", async ({
	page,
}) => {
	await resetFixture(page, true);
	await page.goto("/feedback/demo");
	await expect(
		page.getByRole("heading", { name: "No requests yet." })
	).toBeVisible();
	const emptyState = page.locator(".feedback-empty-state");
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "feedback-board-public-empty-board.png"),
	});
	await emptyState.getByRole("button", { name: "Share feedback" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await dialog.getByLabel("Short title").fill("First public request");
	await dialog
		.getByLabel("Tell us more")
		.fill("The empty board call to action should create real feedback.");
	await dialog.getByRole("button", { name: "Share feedback" }).click();
	await expect(page.getByText("Your feedback is on the board.")).toBeVisible();
	await expect(
		page.getByRole("button", { name: /First public request/ })
	).toBeVisible();
	const state = await fixtureState(page);
	expect(state.requests).toHaveLength(1);
	expect(state.requests[0]).toMatchObject({
		body: "The empty board call to action should create real feedback.",
		category: "Ideas",
		moderation_state: "approved",
		public_visible: true,
		title: "First public request",
	});
	await page.reload();
	await expect(
		page.getByRole("button", { name: /First public request/ })
	).toBeVisible();
});
