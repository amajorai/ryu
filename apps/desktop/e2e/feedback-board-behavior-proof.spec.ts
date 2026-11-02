import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	evidenceDir,
	fixtureState,
	resetFixture,
} from "./feedback-board-behavior-proof.helpers.ts";
import type { FeedbackFixtureSnapshot } from "./feedback-board-fixture-contract.ts";

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
