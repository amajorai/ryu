import { expect, test } from "@playwright/test";
import {
	callsWithPath,
	capture,
	clearCalls,
	failNext,
	listPath,
	mountPullRequests,
	REPOSITORY,
	waitForCall,
	waitForCommand,
} from "./pull-requests-companion-proof.helpers.ts";

test("issue scopes, search, state filters, refresh retry, selection, and mobile return reflect local results", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "issues");
	await expect(companion.getByText("GitHub · @proof-reviewer")).toBeVisible();
	await expect(
		companion.getByRole("option", { name: /Duplicate checkout jobs/ })
	).toBeVisible();
	await clearCalls(page);

	await companion.getByRole("button", { name: "Assigned" }).click();
	await expect(
		companion.getByRole("option", { name: /Duplicate checkout jobs/ })
	).toBeVisible();
	const assignedRequest = await waitForCall(
		page,
		"GET",
		listPath("issues", "assigned", "open")
	);
	expect(assignedRequest.status).toBe(200);
	const assignedCommand = await waitForCommand(
		page,
		"search issues --assignee @me"
	);
	expect(assignedCommand.argv.slice(0, 4)).toEqual([
		"search",
		"issues",
		"--assignee",
		"@me",
	]);

	await companion.getByRole("button", { name: "Authored" }).click();
	await expect(
		companion.getByRole("option", { name: /Add an audit event/ })
	).toBeVisible();
	await expect(
		companion.getByRole("option", { name: /Duplicate checkout jobs/ })
	).toHaveCount(0);
	await waitForCall(page, "GET", listPath("issues", "authored", "open"));
	await waitForCommand(page, "search issues --author @me");

	const issueSearch = companion.getByRole("textbox", { name: "Search issues" });
	await issueSearch.fill("  audit event  ");
	await expect(
		companion.getByRole("option", { name: /Add an audit event/ })
	).toBeVisible();
	const queryRequest = await waitForCall(
		page,
		"GET",
		listPath("issues", "authored", "open", "audit event")
	);
	expect(queryRequest.path).toBe(
		"/issues?scope=authored&state=open&limit=50&q=audit+event"
	);
	await waitForCommand(page, "search issues --author @me --state open");

	await issueSearch.fill("");
	await companion.getByRole("button", { name: "All", exact: true }).click();
	await companion
		.getByRole("combobox", { name: "Issue state" })
		.selectOption("closed");
	await expect(
		companion.getByRole("option", { name: /retired callback route/ })
	).toBeVisible();
	await expect(
		companion.getByRole("option", { name: /Add an audit event/ })
	).toHaveCount(0);
	await waitForCall(page, "GET", listPath("issues", "all", "closed"));
	await waitForCommand(page, "search issues --involves @me --state closed");

	await companion
		.getByRole("combobox", { name: "Issue state" })
		.selectOption("open");
	await expect(
		companion.getByRole("option", { name: /Duplicate checkout jobs/ })
	).toBeVisible();
	await clearCalls(page);
	await companion.getByRole("button", { name: "Refresh" }).click();
	await waitForCall(page, "GET", "/status");
	await waitForCall(page, "GET", listPath("issues", "all", "open"));

	await failNext(
		page,
		"search issues",
		"Fixture issue search is temporarily unavailable."
	);
	await companion.getByRole("button", { name: "Refresh" }).click();
	await expect(
		companion.getByRole("heading", { name: "Couldn’t load issues" })
	).toBeVisible();
	await expect(companion.getByText("No issues found")).toHaveCount(0);
	const retryButton = companion.getByRole("button", { name: "Try again" });
	await expect(retryButton).toBeVisible();
	await waitForCommand(page, "search issues --involves @me", true);
	await retryButton.click();
	await expect(
		companion.getByRole("option", { name: /Duplicate checkout jobs/ })
	).toBeVisible();
	await waitForCall(page, "GET", listPath("issues", "all", "open"), -1);

	await companion.getByRole("option", { name: /Add an audit event/ }).click();
	await expect(
		companion.getByRole("heading", { name: /Add an audit event/ })
	).toBeVisible();
	const issueDetailCall = await waitForCall(
		page,
		"GET",
		"/issues/octo/ryu/702"
	);
	expect(issueDetailCall.status).toBe(200);
	await page.setViewportSize({ width: 390, height: 844 });
	const mobileBack = companion.getByRole("button", {
		name: "Issues",
		exact: true,
	});
	await expect(mobileBack).toBeVisible();
	await mobileBack.click();
	await expect(mobileBack).toBeHidden();
	await expect(
		companion.getByRole("option", { name: /Add an audit event/ })
	).toBeVisible();
	await capture(
		companion,
		"pull-requests-companion-issues-filtered-mobile-list.png"
	);
});

test("issue details show a static Summary label, retry reads, comment with retry, and close/reopen through the local CLI", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "issues");
	await companion.getByRole("option", { name: /Add an audit event/ }).click();
	await expect(
		companion.getByRole("heading", { name: /Add an audit event/ })
	).toBeVisible();
	const issueSummary = companion.getByText("Summary", { exact: true });
	await expect(issueSummary).toHaveAttribute("aria-current", "page");
	await expect(
		companion.getByRole("button", { name: "Summary", exact: true })
	).toHaveCount(0);
	await expect(
		companion.getByText("Issue description for #702.")
	).toBeVisible();
	await clearCalls(page);

	await failNext(
		page,
		"issue view 701",
		"Fixture issue details are temporarily unavailable."
	);
	await companion
		.getByRole("option", { name: /Duplicate checkout jobs/ })
		.click();
	await expect(
		companion.getByRole("heading", { name: "Couldn’t load this issue" })
	).toBeVisible();
	const detailRetry = companion.getByRole("button", { name: "Try again" });
	await expect(detailRetry).toBeVisible();
	await waitForCommand(page, "issue view 701", true);
	await detailRetry.click();
	await expect(
		companion.getByRole("heading", { name: /Duplicate checkout jobs/ })
	).toBeVisible();
	await waitForCall(page, "GET", "/issues/octo/ryu/701");

	const comment = "Please keep the idempotency key stable across every retry.";
	const commentBox = companion.getByRole("textbox", { name: "Issue comment" });
	await commentBox.fill(comment);
	await failNext(
		page,
		"issue comment 701",
		"Fixture rejected the first issue comment."
	);
	await companion.getByRole("button", { name: "Send" }).click();
	await expect(companion.getByRole("alert")).toHaveText(
		"Fixture rejected the first issue comment."
	);
	await expect(commentBox).toHaveValue(comment);
	const failedComment = await waitForCommand(page, "issue comment 701", true);
	expect(failedComment.argv).toEqual([
		"issue",
		"comment",
		"701",
		"--repo",
		REPOSITORY,
		"--body",
		comment,
	]);
	await companion.getByRole("button", { name: "Send" }).click();
	await expect(companion.getByText(comment)).toBeVisible();
	await expect(commentBox).toHaveValue("");
	const successfulComment = await waitForCommand(
		page,
		"issue comment 701",
		false
	);
	expect(successfulComment.argv).toEqual(failedComment.argv);
	const commentWrite = await waitForCall(
		page,
		"POST",
		"/issues/octo/ryu/701/comment"
	);
	expect(commentWrite.body).toEqual({ body: comment });

	await companion.getByRole("button", { name: "Close issue" }).click();
	await waitForCommand(page, "issue close 701 --repo octo/ryu");
	await waitForCall(page, "POST", "/issues/octo/ryu/701/state");
	await expect(
		companion.getByRole("option", { name: /Duplicate checkout jobs/ })
	).toHaveCount(0);
	await companion
		.getByRole("combobox", { name: "Issue state" })
		.selectOption("closed");
	await expect(
		companion.getByRole("option", { name: /Duplicate checkout jobs/ })
	).toBeVisible();
	await companion
		.getByRole("option", { name: /Duplicate checkout jobs/ })
		.click();
	await expect(
		companion.getByRole("heading", { name: /Duplicate checkout jobs/ })
	).toBeVisible();
	await companion.getByRole("button", { name: "Reopen issue" }).click();
	const reopenCommand = await waitForCommand(
		page,
		"issue reopen 701 --repo octo/ryu"
	);
	expect(reopenCommand.argv).toEqual([
		"issue",
		"reopen",
		"701",
		"--repo",
		REPOSITORY,
	]);
	const stateWrite = await waitForCall(
		page,
		"POST",
		"/issues/octo/ryu/701/state",
		-1
	);
	expect(stateWrite.body).toEqual({ state: "open" });
	await companion
		.getByRole("combobox", { name: "Issue state" })
		.selectOption("open");
	await expect(
		companion.getByRole("option", { name: /Duplicate checkout jobs/ })
	).toBeVisible();
	await capture(
		companion,
		"pull-requests-companion-issue-static-summary-comment-state.png"
	);
});

test("pull request scopes, search, state filters, refresh retry, and mobile back stay query-correct", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	await expect(companion.getByText("GitHub · @proof-reviewer")).toBeVisible();
	await expect(
		companion.getByRole("option", { name: /Protect billing retries/ })
	).toBeVisible();
	await clearCalls(page);

	await companion
		.getByRole("button", { name: "Needs my review", exact: true })
		.click();
	await expect(
		companion.getByRole("option", { name: /Protect billing retries/ })
	).toBeVisible();
	await expect(
		companion.getByRole("option", { name: /Rotate session cookie/ })
	).toHaveCount(0);
	await waitForCall(page, "GET", listPath("pulls", "reviewing", "open"));
	const reviewingCommand = await waitForCommand(
		page,
		"search prs --review-requested @me"
	);
	expect(reviewingCommand.argv.slice(0, 4)).toEqual([
		"search",
		"prs",
		"--review-requested",
		"@me",
	]);

	await companion
		.getByRole("button", { name: "Authored by me", exact: true })
		.click();
	await expect(
		companion.getByRole("option", { name: /Rotate session cookie/ })
	).toBeVisible();
	await waitForCall(page, "GET", listPath("pulls", "authored", "open"));
	await waitForCommand(page, "search prs --author @me");
	const pullSearch = companion.getByRole("textbox", {
		name: "Search pull requests",
	});
	await pullSearch.fill("  session cookie  ");
	await expect(
		companion.getByRole("option", { name: /Rotate session cookie/ })
	).toBeVisible();
	const searchRequest = await waitForCall(
		page,
		"GET",
		listPath("pulls", "authored", "open", "session cookie")
	);
	expect(searchRequest.path).toBe(
		"/pulls?scope=authored&state=open&limit=50&q=session+cookie"
	);
	await waitForCommand(page, "search prs --author @me --state open");

	await pullSearch.fill("");
	await companion
		.getByRole("combobox", { name: "Pull request state" })
		.selectOption("merged");
	await expect(
		companion.getByRole("option", { name: /Document merged token refresh/ })
	).toBeVisible();
	await waitForCall(page, "GET", listPath("pulls", "authored", "merged"));
	await waitForCommand(page, "search prs --author @me --merged");
	await companion
		.getByRole("combobox", { name: "Pull request state" })
		.selectOption("closed");
	await expect(
		companion.getByRole("option", { name: /Remove deprecated callback/ })
	).toBeVisible();
	await waitForCall(page, "GET", listPath("pulls", "authored", "closed"));
	await waitForCommand(page, "search prs --author @me --state closed");

	await pullSearch.fill("");
	await companion.getByRole("button", { name: "Inbox", exact: true }).click();
	await companion
		.getByRole("combobox", { name: "Pull request state" })
		.selectOption("open");
	await expect(
		companion.getByRole("option", { name: /Protect billing retries/ })
	).toBeVisible();
	await clearCalls(page);
	const refreshButton = companion.getByRole("button", { name: "Refresh" });
	await expect(refreshButton).toBeEnabled();
	await refreshButton.click();
	await waitForCall(page, "GET", "/status");
	await waitForCall(page, "GET", listPath("pulls", "all", "open"));
	// The list button remains disabled while either status or search is in flight.
	// Wait for the rendered busy state to clear before arming the next one-shot
	// fake-gh failure; otherwise a click can land during the previous refresh.
	await expect(refreshButton).toBeEnabled();
	await failNext(
		page,
		"search prs",
		"Fixture pull request search is temporarily unavailable."
	);
	await refreshButton.click();
	await expect(
		companion.getByRole("heading", { name: "Couldn’t load pull requests" })
	).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Try again" })
	).toBeVisible();
	await waitForCommand(page, "search prs --involves @me", true);
	await companion.getByRole("button", { name: "Try again" }).click();
	await expect(
		companion.getByRole("option", { name: /Protect billing retries/ })
	).toBeVisible();
	await waitForCall(page, "GET", listPath("pulls", "all", "open"), -1);

	await companion.getByRole("option", { name: /Expose usage export/ }).click();
	await expect(
		companion.getByRole("heading", { name: /Expose usage export/ })
	).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	const mobileBack = companion.getByRole("button", {
		name: "Pull requests",
		exact: true,
	});
	await expect(mobileBack).toBeVisible();
	await mobileBack.click();
	await expect(mobileBack).toBeHidden();
	await expect(
		companion.getByRole("option", { name: /Expose usage export/ })
	).toBeVisible();
	await capture(companion, "pull-requests-companion-pull-inbox-mobile.png");
});

test("pull details retry, expose checks/task links, open only safe destinations, and load their diff once with the detail", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	await expect(
		companion.getByRole("heading", { name: /Protect billing retries/ })
	).toBeVisible();
	// Wide layouts show check status in the review rail; the summary copy is
	// the hidden narrow-layout overview.
	const reviewPanel = companion.getByRole("complementary", {
		name: "Pull request review panel",
	});
	await expect(
		reviewPanel.getByText("unit-tests", { exact: true })
	).toBeVisible();
	await expect(
		reviewPanel.getByText("typecheck", { exact: true })
	).toBeVisible();
	await expect(
		companion.getByRole("checkbox", { name: "Completed task 1" })
	).toBeChecked();
	await expect(
		companion.getByRole("checkbox", { name: "Open task 2" })
	).not.toBeChecked();
	const issueLink = companion.getByRole("link", {
		name: /Duplicate checkout jobs charge twice/,
	});
	await expect(issueLink).toHaveAttribute(
		"href",
		`https://${"github.com"}/${REPOSITORY}/issues/701`
	);
	await expect(issueLink).toHaveAttribute("target", "_blank");
	await expect(issueLink).toHaveAttribute("rel", /noopener/);
	const subtaskLink = companion.getByRole("link", {
		name: /octo\/ryu#702 Write retry telemetry/,
	});
	await expect(subtaskLink).toHaveAttribute("target", "_blank");
	await expect(subtaskLink).toHaveAttribute("rel", /noopener/);
	const summaryTab = companion.getByRole("tab", { name: "Summary" });
	await expect(summaryTab).toHaveAttribute("aria-selected", "true");
	await summaryTab.click();
	await expect(
		companion.getByRole("heading", { name: "Tasks", exact: true })
	).toBeVisible();
	// The diff is fetched once with the detail (it also feeds the assistant
	// context), so the Changes tab shows it without a second request.
	const diffCall = await waitForCall(page, "GET", "/pulls/octo/ryu/101/diff");
	expect(diffCall.status).toBe(200);
	await companion.getByRole("tab", { name: /^Changes/ }).click();
	await expect(
		companion.getByText("src/billing.ts", { exact: true })
	).toBeVisible();
	await expect(companion.locator(".diff")).toContainText(
		"idempotencyKey(order)"
	);
	await expect(
		companion.getByRole("button", { name: "Load full patch" })
	).toHaveCount(0);
	expect(
		await callsWithPath(page, "GET", "/pulls/octo/ryu/101/diff")
	).toHaveLength(1);
	const diffCommand = await waitForCommand(page, "pr diff 101 --repo octo/ryu");
	expect(diffCommand.argv).toEqual([
		"pr",
		"diff",
		"101",
		"--repo",
		REPOSITORY,
		"--patch",
		"--color",
		"never",
	]);
	await capture(companion, "pull-requests-companion-detail-diff.png");

	await failNext(
		page,
		"pr view 103",
		"Fixture pull request details are temporarily unavailable."
	);
	await companion.getByRole("option", { name: /Expose usage export/ }).click();
	await expect(
		companion.getByRole("heading", { name: "Couldn’t load this pull request" })
	).toBeVisible();
	await waitForCommand(page, "pr view 103", true);
	await companion.getByRole("button", { name: "Try again" }).click();
	await expect(
		companion.getByRole("heading", { name: /Expose usage export/ })
	).toBeVisible();
	await waitForCall(page, "GET", "/pulls/octo/ryu/103");
});
