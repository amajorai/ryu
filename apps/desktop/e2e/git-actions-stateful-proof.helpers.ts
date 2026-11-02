import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	type ProofJsonRecord,
	type ProofJsonValue,
	parseProofJsonRecord,
} from "./fixture-json.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for git-actions-stateful-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const STORY_URL = "/git-actions-stateful-proof.html";
export const WORKSPACE = "/fixture/git-actions-workspace";
export const INITIAL_BRANCH = "codex/git-actions-fixture";
export const PROOF_DIR = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

export interface FixtureRequest {
	body: ProofJsonRecord | null;
	method: string;
	pathname: string;
	search: string;
}

export interface FixtureOptions {
	failOnce?: string[];
	holdCommitMessage?: string;
}

export interface FixtureState {
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

export function jsonBody(requestBody: string | null): ProofJsonRecord | null {
	if (!requestBody) {
		return null;
	}
	return parseProofJsonRecord(requestBody);
}

export async function installGitFixture(
	page: Page,
	options: FixtureOptions = {}
) {
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

export function mutationRequests(
	fixture: Awaited<ReturnType<typeof installGitFixture>>
) {
	return fixture.requests.filter((request) => request.method === "POST");
}

export async function closeCommitDialog(page: Page) {
	await expect(
		page.getByPlaceholder("Commit message (leave blank to generate)…")
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByPlaceholder("Commit message (leave blank to generate)…")
	).toBeHidden();
}

export async function openProofPage(page: Page) {
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

export async function capture(page: Page, filename: string) {
	await page.screenshot({ path: resolve(PROOF_DIR, filename), fullPage: true });
}
