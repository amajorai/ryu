import { expect, test } from "@playwright/test";
import {
	capture,
	closeCommitDialog,
	INITIAL_BRANCH,
	installGitFixture,
	jsonBody,
	mutationRequests,
	openProofPage,
	WORKSPACE,
} from "./git-actions-stateful-proof.helpers.ts";

test("Pull retries safely and Sync reads back the fixture status", async ({
	page,
}) => {
	const fixture = await installGitFixture(page, {
		failOnce: ["/api/git/pull"],
	});
	await openProofPage(page);
	await closeCommitDialog(page);
	await expect(
		page.getByRole("button", { name: "Pull latest changes" })
	).toBeVisible();
	expect(fixture.requests).toEqual([]);

	await page.getByRole("button", { name: "Pull latest changes" }).click();
	await expect(page.getByRole("alert")).toHaveText("fixture transient failure");
	await expect(page.getByTestId("git-status-readback")).toHaveText(
		"Not read yet"
	);
	await page.getByRole("button", { name: "Pull latest changes" }).click();
	await expect(page.getByTestId("git-status-readback")).toContainText(
		"behind 0"
	);
	await expect(page.getByTestId("action-result")).toHaveText(
		"Pulled and read back remote changes."
	);

	await page.getByRole("button", { name: "Sync with remote" }).click();
	await expect(page.getByTestId("git-status-readback")).toContainText(
		"ahead 0 · behind 0"
	);
	await expect(page.getByTestId("action-result")).toHaveText(
		"Synced and read back remote changes."
	);
	await capture(page, "desktop-git-actions-remote-readback.png");

	expect(
		mutationRequests(fixture).map(({ method, pathname, body }) => ({
			method,
			pathname,
			body,
		}))
	).toEqual([
		{ method: "POST", pathname: "/api/git/pull", body: { cwd: WORKSPACE } },
		{ method: "POST", pathname: "/api/git/pull", body: { cwd: WORKSPACE } },
		{ method: "POST", pathname: "/api/git/sync", body: { cwd: WORKSPACE } },
	]);
	expect(
		fixture.requests.filter((request) => request.pathname === "/api/git/status")
	).toHaveLength(2);
	expect(fixture.outsideRequests).toEqual([]);
});

test("branch selection, empty-name validation, cancel, and create retry read back", async ({
	page,
}) => {
	const fixture = await installGitFixture(page, {
		failOnce: ["/api/git/create-branch"],
	});
	await openProofPage(page);
	const branchMenu = (branchName: string) =>
		page.getByRole("button", { name: `Commit to ${branchName}`, exact: true });

	await branchMenu(INITIAL_BRANCH).click();
	await expect(
		page.getByRole("menuitem", { name: "main", exact: true })
	).toBeVisible();
	expect(
		fixture.requests.filter(
			(request) => request.pathname === "/api/git/branches"
		)[0]
	).toEqual({
		body: null,
		method: "GET",
		pathname: "/api/git/branches",
		search: `?cwd=${encodeURIComponent(WORKSPACE)}`,
	});
	await page.getByRole("menuitem", { name: "main", exact: true }).click();
	await expect(page.getByTestId("branch-readback")).toHaveText(
		"Current branch: main"
	);

	await branchMenu("main").click();
	await page.getByRole("menuitem", { name: "New branch", exact: true }).click();
	const newBranchDialog = page.getByRole("dialog", { name: "New branch" });
	const newBranchName = page.getByRole("textbox", { name: "New branch name" });
	const createBranchButton = page.getByRole("button", {
		name: "Create branch",
		exact: true,
	});
	await expect(newBranchDialog).toContainText(
		"Create a branch from the current commit"
	);
	await expect(createBranchButton).toBeDisabled();
	await newBranchName.press("Enter");
	await expect(newBranchDialog).toBeVisible();
	expect(mutationRequests(fixture).map((request) => request.pathname)).toEqual([
		"/api/git/checkout",
	]);
	await newBranchName.fill("feature/desktop-proof");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(newBranchDialog).toBeHidden();
	expect(mutationRequests(fixture).map((request) => request.pathname)).toEqual([
		"/api/git/checkout",
	]);

	await branchMenu("main").click();
	await page.getByRole("menuitem", { name: "New branch", exact: true }).click();
	await expect(newBranchName).toHaveValue("feature/desktop-proof");
	await createBranchButton.click();
	await expect(
		newBranchDialog.getByText("fixture transient failure", { exact: true })
	).toBeVisible();
	await capture(page, "desktop-git-actions-branch-create-retry.png");
	await createBranchButton.click();
	await expect(newBranchDialog).toBeHidden();
	await expect(page.getByTestId("branch-readback")).toHaveText(
		"Current branch: feature/desktop-proof"
	);
	await expect(page.getByTestId("git-status-readback")).toContainText(
		"branch feature/desktop-proof"
	);

	await branchMenu("feature/desktop-proof").click();
	await page.getByRole("menuitem", { name: "New branch", exact: true }).click();
	await newBranchName.fill("feature/enter-submit");
	await newBranchName.press("Enter");
	await expect(newBranchDialog).toBeHidden();
	await expect(page.getByTestId("branch-readback")).toHaveText(
		"Current branch: feature/enter-submit"
	);

	expect(
		mutationRequests(fixture).map(({ method, pathname, body }) => ({
			method,
			pathname,
			body,
		}))
	).toEqual([
		{
			method: "POST",
			pathname: "/api/git/checkout",
			body: { branch: "main", cwd: WORKSPACE },
		},
		{
			method: "POST",
			pathname: "/api/git/create-branch",
			body: { branch: "feature/desktop-proof", cwd: WORKSPACE },
		},
		{
			method: "POST",
			pathname: "/api/git/create-branch",
			body: { branch: "feature/desktop-proof", cwd: WORKSPACE },
		},
		{
			method: "POST",
			pathname: "/api/git/create-branch",
			body: { branch: "feature/enter-submit", cwd: WORKSPACE },
		},
	]);
	expect(fixture.state.branches).toContain("feature/desktop-proof");
	expect(fixture.state.branches).toContain("feature/enter-submit");
	expect(fixture.outsideRequests).toEqual([]);
});

test("commit, push, and commit-and-push preserve payloads through retry and read-back", async ({
	page,
}) => {
	const fixture = await installGitFixture(page, {
		failOnce: ["/api/git/commit-push"],
	});
	await openProofPage(page);
	const message = page.getByRole("textbox", {
		name: "Commit message",
		exact: true,
	});
	const includeUnstaged = page.getByRole("checkbox", {
		name: /Include unstaged changes/,
	});
	await message.fill("Persist the fixture commit");
	await expect(includeUnstaged).toBeChecked();
	await includeUnstaged.click();
	await expect(includeUnstaged).not.toBeChecked();
	await page.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(
		page.getByText("fixture transient failure", { exact: true })
	).toBeVisible();
	await expect(message).toHaveValue("Persist the fixture commit");
	await page.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(message).toBeHidden();
	await expect(page.getByTestId("git-status-readback")).toContainText("clean");
	await expect(page.getByTestId("action-result")).toContainText(
		"Committed fixture-commit-1"
	);

	await page.getByRole("button", { name: "Open commit dialog" }).click();
	await message.fill("Push the existing fixture commit");
	await expect(includeUnstaged).not.toBeChecked();
	await page.getByRole("button", { name: "Push", exact: true }).click();
	await expect(message).toBeHidden();
	await expect(page.getByTestId("git-status-readback")).toContainText(
		"ahead 0"
	);

	await page.getByRole("button", { name: "Open commit dialog" }).click();
	await message.fill("Commit and push fixture changes");
	await includeUnstaged.click();
	await expect(includeUnstaged).toBeChecked();
	await page
		.getByRole("button", { name: "Commit and push", exact: true })
		.click();
	await expect(message).toBeHidden();
	await expect(page.getByTestId("git-status-readback")).toContainText(
		"ahead 0 · behind 2"
	);
	await expect(page.getByTestId("action-result")).toContainText(
		"Committed and pushed fixture-commit-2"
	);
	await capture(page, "desktop-git-actions-commit-readback.png");

	expect(
		mutationRequests(fixture)
			.filter((request) => request.pathname === "/api/git/commit-push")
			.map((request) => request.body)
	).toEqual([
		{
			action: "commit",
			cwd: WORKSPACE,
			include_unstaged: false,
			message: "Persist the fixture commit",
		},
		{
			action: "commit",
			cwd: WORKSPACE,
			include_unstaged: false,
			message: "Persist the fixture commit",
		},
		{
			action: "push",
			cwd: WORKSPACE,
			include_unstaged: false,
			message: "Push the existing fixture commit",
		},
		{
			action: "commit",
			cwd: WORKSPACE,
			include_unstaged: true,
			message: "Commit and push fixture changes",
		},
		{ action: "push", cwd: WORKSPACE, include_unstaged: false },
	]);
	expect(fixture.outsideRequests).toEqual([]);
});

test("Stop aborts an in-flight commit without a fixture state change", async ({
	page,
}) => {
	const fixture = await installGitFixture(page, {
		holdCommitMessage: "Hold while stopping",
	});
	const startingStatus = { ...fixture.state.gitStatus };
	await openProofPage(page);
	await page
		.getByRole("textbox", { name: "Commit message", exact: true })
		.fill("Hold while stopping");
	const requestStarted = page.waitForRequest((request) =>
		request.url().includes("/api/git/commit-push")
	);
	const requestFailed = page.waitForEvent("requestfailed", (request) =>
		request.url().includes("/api/git/commit-push")
	);
	await page.getByRole("button", { name: "Commit", exact: true }).click();
	const pendingRequest = await requestStarted;
	await expect(page.getByText("Committing…", { exact: true })).toBeVisible();
	const commitDialog = page.getByRole("dialog", {
		name: "Commit or push changes",
	});
	await commitDialog.getByRole("button", { name: "Close" }).click();
	await expect(commitDialog).toBeHidden();
	await expect(
		page.getByTestId("environment-status").getByRole("status")
	).toContainText("Committing…");
	await page.getByRole("button", { name: "Stop git action" }).click();
	await expect(commitDialog).toBeHidden();
	await expect(page.getByTestId("action-result")).toContainText(
		"Git action cancelled"
	);
	const failedRequest = await requestFailed;
	fixture.releaseHeldRequest();
	await fixture.heldRequestComplete;
	expect(failedRequest.failure()).toBeTruthy();
	expect(jsonBody(pendingRequest.postData())).toEqual({
		action: "commit",
		cwd: WORKSPACE,
		include_unstaged: true,
		message: "Hold while stopping",
	});
	expect(fixture.state.gitStatus).toEqual(startingStatus);
	expect(
		fixture.requests.filter((request) => request.pathname === "/api/git/status")
	).toEqual([]);
	expect(fixture.outsideRequests).toEqual([]);
	await capture(page, "desktop-git-actions-stop-cancelled.png");
});

test("repository creation validates, cancels, retries, and reads back the selected visibility", async ({
	page,
}) => {
	const repositoryPath = "/api/ext/@ryu/pull-requests/repository/create";
	const fixture = await installGitFixture(page, { failOnce: [repositoryPath] });
	await openProofPage(page);
	await closeCommitDialog(page);
	await page.getByRole("button", { name: "Open repository dialog" }).click();
	const repositoryDialog = page.getByRole("dialog", {
		name: "Create GitHub repository",
	});
	const name = page.getByRole("textbox", { name: "GitHub repository name" });
	const createAndPush = page.getByRole("button", {
		name: "Create and push",
		exact: true,
	});
	await expect(name).toBeVisible();
	await expect(createAndPush).toBeDisabled();
	await expect(
		page.getByRole("radio", { name: "Private repository" })
	).toBeChecked();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(repositoryDialog).toBeHidden();
	expect(mutationRequests(fixture)).toEqual([]);

	await page.getByRole("button", { name: "Open repository dialog" }).click();
	await name.fill("coverage-fixture");
	await page.getByRole("radio", { name: "Public repository" }).click();
	await expect(
		page.getByRole("radio", { name: "Public repository" })
	).toBeChecked();
	await createAndPush.click();
	await expect(repositoryDialog.getByRole("alert")).toHaveText(
		"GitHub is temporarily unavailable. Try again."
	);
	await expect(name).toHaveValue("coverage-fixture");
	await capture(page, "desktop-git-actions-repository-retry.png");
	await createAndPush.click();
	await expect(repositoryDialog).toBeHidden();
	await expect(page.getByTestId("repository-readback")).toHaveText(
		"fixture-owner/coverage-fixture"
	);
	await expect(page.getByTestId("action-result")).toHaveText(
		"Published fixture-owner/coverage-fixture and read it back."
	);
	await capture(page, "desktop-git-actions-repository-readback.png");

	expect(
		mutationRequests(fixture).map(({ method, pathname, body }) => ({
			method,
			pathname,
			body,
		}))
	).toEqual([
		{
			method: "POST",
			pathname: "/api/git/commit-push",
			body: {
				action: "commit",
				cwd: WORKSPACE,
				include_unstaged: true,
				message: "Initial commit",
			},
		},
		{
			method: "POST",
			pathname: repositoryPath,
			body: { cwd: WORKSPACE, name: "coverage-fixture", visibility: "public" },
		},
		{
			method: "POST",
			pathname: "/api/git/commit-push",
			body: {
				action: "commit",
				cwd: WORKSPACE,
				include_unstaged: true,
				message: "Initial commit",
			},
		},
		{
			method: "POST",
			pathname: repositoryPath,
			body: { cwd: WORKSPACE, name: "coverage-fixture", visibility: "public" },
		},
	]);
	expect(fixture.state.lastRepositoryVisibility).toBe("public");
	expect(
		fixture.requests.filter((request) =>
			request.pathname.endsWith("/repository")
		)
	).toEqual([
		{
			method: "GET",
			pathname: "/api/ext/@ryu/pull-requests/repository",
			search: "?cwd=%2Ffixture%2Fgit-actions-workspace",
			body: null,
		},
	]);
	expect(fixture.outsideRequests).toEqual([]);
});
