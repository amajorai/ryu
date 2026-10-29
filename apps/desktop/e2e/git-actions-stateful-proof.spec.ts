import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import {
	type ProofJsonRecord,
	type ProofJsonValue,
	parseProofJsonRecord,
} from "./fixture-json.ts";

const STORY_URL = "/git-actions-stateful-proof.html";
const WORKSPACE = "/fixture/git-actions-workspace";
const INITIAL_BRANCH = "codex/git-actions-fixture";
const PROOF_DIR = resolve(
	process.cwd(),
	"../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface FixtureRequest {
	body: ProofJsonRecord | null;
	method: string;
	pathname: string;
	search: string;
}

interface FixtureOptions {
	failOnce?: string[];
	holdCommitMessage?: string;
}

interface FixtureState {
	branches: string[];
	commitCount: number;
	currentBranch: string;
	gitStatus: {
		ahead: number;
		behind: number;
		branch: string;
		changed_files_count: number;
		deletions: number;
		dirty: boolean;
		insertions: number;
		is_repo: boolean;
	};
	lastRepositoryVisibility: string | null;
	nextPullRequest: number;
	pullRequest: {
		base: ProofJsonValue;
		branch: string;
		comments_count: number;
		head_sha: string;
		is_draft: boolean;
		number: number;
		pr_url: string;
		repository: string;
		state: string;
		title: string;
		updated_at: string;
	} | null;
	repository: {
		defaultBranch: string;
		nameWithOwner: string;
		url: string;
	} | null;
}

function jsonBody(requestBody: string | null): ProofJsonRecord | null {
	if (!requestBody) {
		return null;
	}
	return parseProofJsonRecord(requestBody);
}

async function installGitFixture(page: Page, options: FixtureOptions = {}) {
	const requests: FixtureRequest[] = [];
	const failedPaths = new Set<string>();
	const failurePaths = new Set(options.failOnce ?? []);
	const state: FixtureState = {
		branches: [INITIAL_BRANCH, "main", "release/0.1"],
		commitCount: 0,
		currentBranch: INITIAL_BRANCH,
		gitStatus: {
			ahead: 1,
			behind: 2,
			branch: INITIAL_BRANCH,
			changed_files_count: 2,
			deletions: 3,
			dirty: true,
			insertions: 7,
			is_repo: true,
		},
		lastRepositoryVisibility: null,
		nextPullRequest: 551,
		pullRequest: null,
		repository: null,
	};
	let releaseHeldRequest: (() => void) | null = null;
	let finishHeldRequest: (() => void) | null = null;
	const heldRequestGate = new Promise<void>((resolveGate) => {
		releaseHeldRequest = resolveGate;
	});
	const heldRequestComplete = new Promise<void>((resolveDone) => {
		finishHeldRequest = resolveDone;
	});
	const outsideRequests: string[] = [];

	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.origin !== "http://127.0.0.1:5184") {
			outsideRequests.push(request.url());
		}
	});

	await page.route("http://127.0.0.1:5184/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const body = jsonBody(request.postData());
		requests.push({
			body,
			method: request.method(),
			pathname: url.pathname,
			search: url.search,
		});

		const fulfill = async <FixturePayload>(
			status: number,
			data: FixturePayload
		) => {
			await route.fulfill({
				body: JSON.stringify(data),
				contentType: "application/json",
				status,
			});
		};

		if (
			options.holdCommitMessage &&
			url.pathname === "/api/git/commit-push" &&
			body?.message === options.holdCommitMessage
		) {
			await heldRequestGate;
			try {
				await fulfill(200, {
					commit: "fixture-cancelled-commit",
					committed: true,
					pushed: false,
					success: true,
				});
			} catch {
				// The browser cancels this held response when Stop aborts the request.
			} finally {
				finishHeldRequest?.();
			}
			return;
		}

		if (failurePaths.has(url.pathname) && !failedPaths.has(url.pathname)) {
			failedPaths.add(url.pathname);
			await fulfill(503, { error: "fixture transient failure" });
			return;
		}

		if (url.pathname === "/api/git/status" && request.method() === "GET") {
			await fulfill(200, state.gitStatus);
			return;
		}

		if (url.pathname === "/api/git/branches" && request.method() === "GET") {
			await fulfill(200, {
				branches: state.branches,
				current: state.currentBranch,
				is_repo: true,
			});
			return;
		}

		if (url.pathname === "/api/git/checkout" && request.method() === "POST") {
			const selected = body?.branch;
			if (!(isNativeText(selected) && state.branches.includes(selected))) {
				await fulfill(409, { error: "branch does not exist in local fixture" });
				return;
			}
			state.currentBranch = selected;
			state.gitStatus = { ...state.gitStatus, branch: selected };
			await fulfill(200, { branch: selected, success: true });
			return;
		}

		if (
			url.pathname === "/api/git/create-branch" &&
			request.method() === "POST"
		) {
			const created = body?.branch;
			if (!(isNativeText(created) && created.trim())) {
				await fulfill(400, { error: "branch name is required" });
				return;
			}
			if (state.branches.includes(created)) {
				await fulfill(409, { error: "branch already exists" });
				return;
			}
			state.branches = [...state.branches, created];
			state.currentBranch = created;
			state.gitStatus = { ...state.gitStatus, branch: created };
			await fulfill(200, { branch: created, success: true });
			return;
		}

		if (
			url.pathname === "/api/git/commit-push" &&
			request.method() === "POST"
		) {
			const action = body?.action;
			if (action !== "commit" && action !== "push") {
				await fulfill(400, { error: "unknown Git action" });
				return;
			}
			state.commitCount += action === "commit" ? 1 : 0;
			state.gitStatus =
				action === "commit"
					? {
							...state.gitStatus,
							ahead: state.gitStatus.ahead + 1,
							changed_files_count: 0,
							deletions: 0,
							dirty: false,
							insertions: 0,
						}
					: { ...state.gitStatus, ahead: 0 };
			await fulfill(200, {
				commit: `fixture-commit-${state.commitCount}`,
				committed: action === "commit",
				pushed: action === "push",
				success: true,
			});
			return;
		}

		if (url.pathname === "/api/git/pull" && request.method() === "POST") {
			state.gitStatus = { ...state.gitStatus, behind: 0 };
			await fulfill(200, {
				commit: "fixture-pull-head",
				pulled: true,
				pushed: false,
				success: true,
			});
			return;
		}

		if (url.pathname === "/api/git/sync" && request.method() === "POST") {
			state.gitStatus = { ...state.gitStatus, ahead: 0, behind: 0 };
			await fulfill(200, {
				commit: "fixture-sync-head",
				pulled: true,
				pushed: true,
				success: true,
			});
			return;
		}

		if (
			url.pathname === "/api/git/pull-request" &&
			request.method() === "POST"
		) {
			state.nextPullRequest += 1;
			const number = state.nextPullRequest;
			const repository = "fixture-owner/git-actions-fixture";
			const urlValue = `https://github.com/${repository}/pull/${number}`;
			const title = isNativeText(body?.title)
				? body.title
				: `Update ${state.currentBranch}`;
			state.pullRequest = {
				base: body?.base ?? "main",
				branch: state.currentBranch,
				comments_count: 0,
				head_sha: `fixture-head-${number}`,
				is_draft: body?.draft === true,
				number,
				pr_url: urlValue,
				repository,
				state: "OPEN",
				title,
				updated_at: "2026-09-28T00:00:00Z",
			};
			await fulfill(200, { ...state.pullRequest, success: true });
			return;
		}

		if (url.pathname.endsWith("/pulls/branch") && request.method() === "GET") {
			await fulfill(200, { pull: state.pullRequest });
			return;
		}

		if (
			url.pathname.endsWith("/repository/create") &&
			request.method() === "POST"
		) {
			const name = isNativeText(body?.name) ? body.name : "invalid-name";
			state.lastRepositoryVisibility = isNativeText(body?.visibility)
				? body.visibility
				: null;
			state.repository = {
				defaultBranch: "main",
				nameWithOwner: `fixture-owner/${name}`,
				url: `https://github.com/fixture-owner/${name}`,
			};
			await fulfill(200, { repository: state.repository });
			return;
		}

		if (url.pathname.endsWith("/repository") && request.method() === "GET") {
			await fulfill(200, { repository: state.repository });
			return;
		}

		await fulfill(404, { error: "unmapped local Git fixture request" });
	});

	return {
		heldRequestComplete,
		releaseHeldRequest: () => releaseHeldRequest?.(),
		requests,
		state,
		outsideRequests,
	};
}

function mutationRequests(
	fixture: Awaited<ReturnType<typeof installGitFixture>>
) {
	return fixture.requests.filter((request) => request.method === "POST");
}

async function closeCommitDialog(page: Page) {
	await expect(
		page.getByPlaceholder("Commit message (leave blank to generate)…")
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByPlaceholder("Commit message (leave blank to generate)…")
	).toBeHidden();
}

async function openProofPage(page: Page) {
	const runtimeErrors: string[] = [];
	const failedResponses: string[] = [];
	page.on("pageerror", (error) => runtimeErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			runtimeErrors.push(`${message.text()} (${message.location().url})`);
		}
	});
	page.on("response", async (response) => {
		if (response.status() >= 400) {
			const responseText = await response.text().catch(() => "");
			failedResponses.push(
				`${response.status()} ${response.url()} ${responseText}`
			);
		}
	});
	const response = await page.goto(STORY_URL);
	try {
		await expect(page.getByRole("dialog")).toBeVisible();
	} catch {
		const body = await page.locator("body").innerText();
		const html = await page.locator("body").innerHTML();
		throw new Error(
			`Git action proof did not render (HTTP ${response?.status() ?? "no response"}). Console errors: ${runtimeErrors.join(" | ")}. Failed responses: ${failedResponses.join(" | ")}. Page text: ${body}. Page HTML: ${html}`
		);
	}
}

async function capture(page: Page, filename: string) {
	await page.screenshot({ path: resolve(PROOF_DIR, filename), fullPage: true });
}

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

test("pull request draft, create, and browser-target actions preserve options and retry state", async ({
	page,
}) => {
	const fixture = await installGitFixture(page, {
		failOnce: ["/api/git/pull-request"],
	});
	await openProofPage(page);
	await closeCommitDialog(page);
	await page.getByRole("button", { name: "Open pull request dialog" }).click();
	const pullRequestDialog = page.getByRole("dialog", {
		name: "Create pull request",
	});
	const title = page.getByRole("textbox", {
		name: "Pull request title",
		exact: true,
	});
	const description = page.getByRole("textbox", {
		name: "Pull request description",
		exact: true,
	});
	const commitWithPr = page.getByRole("checkbox", {
		name: /Commit and push local changes/,
	});
	await title.fill("Fixture draft title");
	await description.fill("Verify the failure and retry path.");
	await expect(commitWithPr).toBeChecked();
	await commitWithPr.click();
	await expect(commitWithPr).not.toBeChecked();
	await pullRequestDialog.getByRole("button", { name: "Close" }).click();
	await expect(pullRequestDialog).toBeHidden();
	expect(mutationRequests(fixture)).toEqual([]);

	await page.getByRole("button", { name: "Open pull request dialog" }).click();
	await expect(title).toHaveValue("Fixture draft title");
	await expect(description).toHaveValue("Verify the failure and retry path.");
	await page
		.getByRole("button", { name: "Create draft PR", exact: true })
		.click();
	await expect(
		pullRequestDialog.getByText("fixture transient failure", { exact: true })
	).toBeVisible();
	await expect(title).toHaveValue("Fixture draft title");
	await capture(page, "desktop-git-actions-pull-request-retry.png");
	await page
		.getByRole("button", { name: "Create draft PR", exact: true })
		.click();
	await expect(pullRequestDialog).toBeHidden();
	await expect(page.getByTestId("pull-request-readback")).toContainText(
		"draft · Fixture draft title"
	);

	await page.getByRole("button", { name: "Open pull request dialog" }).click();
	await title.fill("Fixture ready title");
	await description.fill("Create a non-draft pull request.");
	await commitWithPr.click();
	await expect(commitWithPr).toBeChecked();
	await page.getByRole("button", { name: "Create PR", exact: true }).click();
	await expect(pullRequestDialog).toBeHidden();
	await expect(page.getByTestId("pull-request-readback")).toContainText(
		"ready · Fixture ready title"
	);

	await page.getByRole("button", { name: "Open pull request dialog" }).click();
	await title.fill("Fixture browser target");
	await description.fill("Capture the URL without opening an external site.");
	await page
		.getByRole("button", { name: "Open PR in browser", exact: true })
		.click();
	await expect(pullRequestDialog).toBeHidden();
	await expect(page.getByTestId("external-url-requested")).toContainText(
		"https://github.com/fixture-owner/git-actions-fixture/pull/554"
	);
	const nativeCalls = z
		.array(
			z.object({
				args: z.record(z.string(), z.json()).optional(),
				command: z.string(),
			})
		)
		.parse(
			JSON.parse(
				(await page.getByTestId("tauri-native-calls").textContent()) ?? "[]"
			)
		);
	expect(
		nativeCalls.filter((call) => call.command === "open_external")
	).toEqual([
		{
			args: {
				url: "https://github.com/fixture-owner/git-actions-fixture/pull/554",
			},
			command: "open_external",
		},
	]);
	await expect(page.getByTestId("pull-request-readback")).toContainText(
		"ready · Fixture browser target"
	);
	await capture(page, "desktop-git-actions-pull-request-readback.png");

	const mutationPayloads = mutationRequests(fixture)
		.filter((request) => request.pathname === "/api/git/pull-request")
		.map((request) => request.body);
	expect(mutationPayloads).toEqual([
		{
			base: "main",
			body: "Verify the failure and retry path.",
			cwd: WORKSPACE,
			draft: true,
			include_unstaged: false,
			title: "Fixture draft title",
		},
		{
			base: "main",
			body: "Verify the failure and retry path.",
			cwd: WORKSPACE,
			draft: true,
			include_unstaged: false,
			title: "Fixture draft title",
		},
		{
			base: "main",
			body: "Create a non-draft pull request.",
			cwd: WORKSPACE,
			draft: false,
			include_unstaged: true,
			title: "Fixture ready title",
		},
		{
			base: "main",
			body: "Capture the URL without opening an external site.",
			cwd: WORKSPACE,
			draft: false,
			include_unstaged: true,
			title: "Fixture browser target",
		},
	]);
	expect(
		fixture.requests.filter((request) =>
			request.pathname.endsWith("/pulls/branch")
		)
	).toHaveLength(3);
	expect(fixture.outsideRequests).toEqual([]);
});
