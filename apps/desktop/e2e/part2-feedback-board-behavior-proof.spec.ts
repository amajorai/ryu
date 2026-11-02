// Continues feedback-board-behavior-proof.spec.ts (split under the file token limit); helpers live in feedback-board-behavior-proof.helpers.ts.

import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	evidenceDir,
	expectModeOptionDescriptionsFit,
	fixtureState,
	resetFixture,
} from "./feedback-board-behavior-proof.helpers.ts";

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
