import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import {
	REVIEW_PREAMBLE,
	REVIEW_PROMPTS,
} from "../../../apps-store/pull-requests/ui/src/ai-review.ts";
import { createPullRequestsProofState } from "./harness/pull-requests-companion-fixture.ts";
import type { PullRequestsProofApi } from "./harness/pull-requests-companion-proof.tsx";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = `${tmpdir()}/ryu-pull-requests-companion-ui-build/index.html`;
const EVIDENCE = path.resolve(
	HERE,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const REPOSITORY = "octo/ryu";

interface PullRequestsCall {
	body?: unknown;
	method: string;
	path: string;
	result?: unknown;
	status: number;
}

interface GhCommand {
	argv: string[];
	cwd: string | null;
	failed: boolean;
}

interface ProofState {
	issues: Array<{ number: number; state: string; title: string }>;
	pullDetails: Record<
		string,
		{ isDraft: boolean; state: string; title: string }
	>;
}

type AssistantCall = ReturnType<PullRequestsProofApi["assistantCalls"]>[number];
type BridgeRpc = ReturnType<PullRequestsProofApi["bridgeRpcs"]>[number];

interface MountOptions {
	/** Grant `assistant:context`, as the shipped manifest does. */
	assistantGrant?: boolean;
	/** App requests the harness holds from the first frame load until released. */
	holdPaths?: string[];
}

async function mountPullRequests(
	page: Page,
	view: "issues" | "pulls" = "pulls",
	authenticated = true,
	{ assistantGrant = false, holdPaths = [] }: MountOptions = {}
): Promise<FrameLocator> {
	const reset = await page.request.post("/__proof/reset", {
		data: { authenticated },
	});
	expect(reset.status()).toBe(200);
	await page.goto("/pull-requests-companion-proof.html");
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate(
		({ appHtml, requestedView, grantedAssistant, heldPaths }) =>
			window.__pullRequestsProof.mount({
				appHtml,
				assistantGrant: grantedAssistant,
				holdPaths: heldPaths,
				view: requestedView,
			}),
		{
			appHtml: readFileSync(APP_HTML, "utf8"),
			grantedAssistant: assistantGrant,
			heldPaths: holdPaths,
			requestedView: view,
		}
	);
	await expect
		.poll(() => page.evaluate(() => window.__pullRequestsProof.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	return page.frameLocator("iframe");
}

async function calls(page: Page): Promise<PullRequestsCall[]> {
	return await page.evaluate(() => window.__pullRequestsProof.calls());
}

async function commands(page: Page): Promise<GhCommand[]> {
	const response = await page.request.get("/__proof/commands");
	expect(response.status()).toBe(200);
	return await response.json();
}

async function fixtureState(page: Page): Promise<ProofState> {
	const response = await page.request.get("/__proof/state");
	expect(response.status()).toBe(200);
	return await response.json();
}

async function clearCalls(page: Page): Promise<void> {
	await page.evaluate(() => window.__pullRequestsProof.clearCalls());
}

async function failNext(
	page: Page,
	match: string,
	message: string
): Promise<void> {
	const response = await page.request.post("/__proof/fail-next", {
		data: { match, message },
	});
	expect(response.status()).toBe(200);
}

async function callsWithPath(
	page: Page,
	method: string,
	pathName: string
): Promise<PullRequestsCall[]> {
	return (await calls(page)).filter(
		(call) => call.method === method && call.path === pathName
	);
}

async function waitForCall(
	page: Page,
	method: string,
	pathName: string,
	index = -1
): Promise<PullRequestsCall> {
	await expect
		.poll(
			async () =>
				(await callsWithPath(page, method, pathName)).at(index)?.status ?? 0
		)
		.toBeGreaterThan(0);
	const call = (await callsWithPath(page, method, pathName)).at(index);
	if (!call) {
		throw new Error(`No captured ${method} ${pathName} request was recorded.`);
	}
	return call;
}

async function waitForCommand(
	page: Page,
	match: string,
	failed?: boolean
): Promise<GhCommand> {
	await expect
		.poll(async () =>
			(await commands(page)).some(
				(command) =>
					command.argv.join(" ").includes(match) &&
					(failed === undefined || command.failed === failed)
			)
		)
		.toBe(true);
	const command = (await commands(page))
		.filter(
			(item) =>
				item.argv.join(" ").includes(match) &&
				(failed === undefined || item.failed === failed)
		)
		.at(-1);
	if (!command) {
		throw new Error(`The fake gh fixture did not record ${match}.`);
	}
	return command;
}

async function capture(
	companion: FrameLocator,
	filename: string
): Promise<void> {
	await mkdir(EVIDENCE, { recursive: true });
	await companion.locator("body").screenshot({
		animations: "disabled",
		path: path.join(EVIDENCE, filename),
	});
}

function listPath(
	kind: "issues" | "pulls",
	scope: string,
	state: string,
	query?: string
): string {
	const params = new URLSearchParams({ scope, state, limit: "50" });
	if (query) {
		params.set("q", query);
	}
	return `/${kind}?${params.toString()}`;
}

async function openPull(
	companion: FrameLocator,
	number: number
): Promise<void> {
	const title =
		number === 101
			? /Protect billing retries/
			: number === 102
				? /Rotate session cookie/
				: number === 103
					? /Expose usage export/
					: number === 104
						? /Document merged token refresh/
						: number === 105
							? /Remove deprecated callback/
							: /Keep retry metadata/;
	await companion.getByRole("option", { name: title }).click();
	await expect(companion.getByRole("heading", { name: title })).toBeVisible();
}

async function openPullMergeMenu(companion: FrameLocator): Promise<void> {
	await companion.getByRole("button", { name: /^Merge$/ }).click();
}

async function createStackThroughDialog(
	companion: FrameLocator
): Promise<void> {
	await companion.getByRole("button", { name: "Create stack" }).click();
	const dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Pull request numbers" })
		.fill("101, 102");
	await dialog.getByRole("button", { name: "Create a stack" }).click();
	await expect(
		companion.getByRole("heading", { name: "Stack #900" })
	).toBeVisible();
}

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
	const mobileBack = companion.getByRole("button", { name: "← Issues" });
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
	const mobileBack = companion.getByRole("button", { name: "← Pull requests" });
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

test("GitHub sign-in and issue/PR detail buttons hand URLs to the trusted host", async ({
	page,
}) => {
	const issueView = await mountPullRequests(page, "issues");
	await issueView.getByRole("button", { name: "Open on GitHub" }).click();
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual([`https://${"github.com"}/${REPOSITORY}/issues/701`]);
	await expect(page).toHaveURL(/pull-requests-companion-proof\.html/);

	const pullView = await mountPullRequests(page, "pulls");
	await pullView.getByRole("button", { name: "Open on GitHub" }).click();
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual([`https://${"github.com"}/${REPOSITORY}/pull/101`]);
	await capture(pullView, "pull-requests-companion-external-open-success.png");

	const setup = await mountPullRequests(page, "issues", false);
	await setup.getByRole("button", { name: "Sign in with GitHub" }).click();
	await expect(
		setup.getByRole("button", { name: "Copy one-time GitHub code" })
	).toContainText("ABCD-EFGH");
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual(["https://github.com/login/device"]);
	await setup.getByRole("button", { name: "Open GitHub" }).click();
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual([
			"https://github.com/login/device",
			"https://github.com/login/device",
		]);
	await expect(
		setup.getByText(/Capability not granted: ui\.displayMode/)
	).toHaveCount(0);
	await setup.getByRole("button", { name: "Cancel" }).click();
	await expect(setup.getByText("Sign-in cancelled.")).toBeVisible();
	const cancelledDeviceFlow = await waitForCall(page, "DELETE", "/auth/device");
	expect(cancelledDeviceFlow.status).toBe(200);
});

test("trusted issue, task, and subtask links open through the host without popups", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	const hostUrl = page.url();
	const externalLinks = [
		{
			href: `https://github.com/${REPOSITORY}/issues/701`,
			link: companion.getByRole("link", {
				name: /Duplicate checkout jobs charge twice/,
			}),
		},
		{
			href: `https://github.com/${REPOSITORY}/issues/701`,
			link: companion.getByRole("link", {
				name: /Persist the idempotency key/,
			}),
		},
		{
			href: `https://github.com/${REPOSITORY}/issues/702`,
			link: companion.getByRole("link", {
				name: /octo\/ryu#702 Write retry telemetry/,
			}),
		},
	];
	const expectedDestinations: string[] = [];
	for (const { href, link } of externalLinks) {
		await expect(link).toHaveAttribute("href", href);
		await expect(link).toHaveAttribute("target", "_blank");
		await expect(link).toHaveAttribute("rel", /noopener/);
		await link.click();
		expectedDestinations.push(href);
		await expect
			.poll(() =>
				page.evaluate(() => window.__pullRequestsProof.openedExternal())
			)
			.toEqual(expectedDestinations);
		expect(page.context().pages()).toHaveLength(1);
		await expect(page).toHaveURL(hostUrl);
	}

	await companion.locator("body").evaluate(() => {
		const unsafeJavaScript = document.createElement("a");
		unsafeJavaScript.href = "javascript:window.__unsafeNavigationRan=true";
		unsafeJavaScript.target = "_blank";
		unsafeJavaScript.textContent = "Unsafe JavaScript destination";
		unsafeJavaScript.style.cssText =
			"position:fixed;top:0;left:0;z-index:99999;background:white;color:black;padding:8px";
		unsafeJavaScript.dataset.testid = "proof-unsafe-javascript";
		document.body.append(unsafeJavaScript);
		const unsafeFile = document.createElement("a");
		unsafeFile.href = "file:///etc/passwd";
		unsafeFile.target = "_blank";
		unsafeFile.textContent = "Unsafe file destination";
		unsafeFile.style.cssText = unsafeJavaScript.style.cssText;
		unsafeFile.style.top = "40px";
		unsafeFile.dataset.testid = "proof-unsafe-file";
		document.body.append(unsafeFile);
	});
	for (const scheme of ["javascript", "file"] as const) {
		await companion.getByTestId(`proof-unsafe-${scheme}`).click();
	}
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual(expectedDestinations);
	const unsafeNavigationRan = await companion.locator("body").evaluate(
		() =>
			// SAFETY: This controlled proof only authors the optional marker through its javascript: link assigning literal true; an unexecuted destination leaves the property absent.
			(window as Window & { __unsafeNavigationRan?: boolean })
				.__unsafeNavigationRan ?? false
	);
	expect(unsafeNavigationRan).toBe(false);
	await companion.locator("body").evaluate(() => {
		const syntheticLink = document.createElement("a");
		syntheticLink.href = "https://github.com/octo/ryu/issues/999";
		syntheticLink.target = "_blank";
		document.body.append(syntheticLink);
		syntheticLink.click();
		syntheticLink.remove();
	});
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual(expectedDestinations);
	await expect(page).toHaveURL(hostUrl);
	expect(page.context().pages()).toHaveLength(1);
	await companion
		.locator('[data-testid^="proof-unsafe-"]')
		.evaluateAll((links) => links.forEach((link) => link.remove()));
	await capture(
		companion,
		"pull-requests-companion-anchor-external-open-success.png"
	);
});

test("review comments and decisions preserve exact intent, retry failures, and mark drafts ready", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	// The review rail shows the readable decision for the selected pull request.
	const reviewDecision = (decision: string) =>
		companion
			.getByRole("complementary", { name: "Pull request review panel" })
			.getByText(decision, { exact: true });
	// Let the detail's eager diff read finish before arming the fixture failure,
	// so the two fake gh processes do not race on the shared fixture state.
	await waitForCall(page, "GET", "/pulls/octo/ryu/101/diff");
	const reviewComment = "Please keep the same idempotency key across retries.";
	const commentBox = companion.getByRole("textbox", { name: "Review comment" });
	await commentBox.fill(reviewComment);
	await failNext(
		page,
		"pr comment 101",
		"Fixture rejected the first PR comment."
	);
	await companion.getByRole("button", { name: "Send" }).click();
	await expect(companion.getByRole("alert")).toHaveText(
		"Fixture rejected the first PR comment."
	);
	await expect(commentBox).toHaveValue(reviewComment);
	const failedComment = await waitForCommand(page, "pr comment 101", true);
	expect(failedComment.argv).toEqual([
		"pr",
		"comment",
		"101",
		"--repo",
		REPOSITORY,
		"--body",
		reviewComment,
	]);
	await companion.getByRole("button", { name: "Send" }).click();
	await expect(companion.getByText(reviewComment)).toBeVisible();
	await expect(commentBox).toHaveValue("");
	const successfulComment = await waitForCommand(page, "pr comment 101", false);
	expect(successfulComment.argv).toEqual(failedComment.argv);
	const commentCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/101/comment"
	);
	expect(commentCall.body).toEqual({ body: reviewComment });

	await companion
		.getByRole("combobox", { name: "Comment type" })
		.selectOption("approve");
	await expect(companion.getByRole("button", { name: "Send" })).toBeEnabled();
	const approvalNote = "Verified with the local regression fixture.";
	await commentBox.fill(approvalNote);
	await companion.getByRole("button", { name: "Send" }).click();
	await expect(reviewDecision("Approved")).toBeVisible();
	const approvalCommand = await waitForCommand(
		page,
		"pr review 101 --repo octo/ryu --approve"
	);
	expect(approvalCommand.argv).toEqual([
		"pr",
		"review",
		"101",
		"--repo",
		REPOSITORY,
		"--approve",
		"--body",
		approvalNote,
	]);
	const approvalCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/101/review"
	);
	expect(approvalCall.body).toEqual({ action: "approve", body: approvalNote });

	await companion
		.getByRole("combobox", { name: "Comment type" })
		.selectOption("request_changes");
	const changesNote =
		"Please cover the timeout after the first charge succeeds.";
	await commentBox.fill(changesNote);
	await companion.getByRole("button", { name: "Send" }).click();
	await expect(reviewDecision("Changes requested")).toBeVisible();
	const changesCommand = await waitForCommand(
		page,
		"pr review 101 --repo octo/ryu --request-changes"
	);
	expect(changesCommand.argv).toEqual([
		"pr",
		"review",
		"101",
		"--repo",
		REPOSITORY,
		"--request-changes",
		"--body",
		changesNote,
	]);
	const changesCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/101/review"
	);
	expect(changesCall.body).toEqual({
		action: "request_changes",
		body: changesNote,
	});

	await openPull(companion, 102);
	await expect(
		companion.getByRole("button", { name: "Ready for review" })
	).toBeVisible();
	await companion.getByRole("button", { name: "Ready for review" }).click();
	await expect(
		companion.getByRole("button", { name: "Ready for review" })
	).toHaveCount(0);
	const readyCommand = await waitForCommand(
		page,
		"pr ready 102 --repo octo/ryu"
	);
	expect(readyCommand.argv).toEqual([
		"pr",
		"ready",
		"102",
		"--repo",
		REPOSITORY,
	]);
	const readyCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/102/ready"
	);
	expect(readyCall.body).toEqual({ draft: false });
	expect(
		(await fixtureState(page)).pullDetails[`${REPOSITORY}#102`]?.isDraft
	).toBe(false);
	await expect(
		companion.getByRole("heading", { name: /Rotate session cookie/ })
	).toBeVisible();
	await expect(reviewDecision("Review required")).toBeVisible();
	await capture(companion, "pull-requests-companion-review-ready-state.png");
});

test("stack dialogs validate unique layers, save order, navigate layers, and unstack safely", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	const createButton = companion.getByRole("button", { name: "Create stack" });
	await expect(createButton).toBeVisible();
	await createButton.click();
	let dialog = companion.getByRole("dialog");
	const numbers = dialog.getByRole("textbox", { name: "Pull request numbers" });
	await expect(numbers).toHaveValue("101");
	await numbers.fill("101, 102, 102");
	await dialog.getByRole("button", { name: "Create a stack" }).click();
	await expect(
		dialog.getByText(/at least two unique PR numbers/)
	).toBeVisible();
	const noStackWrite = await commands(page);
	expect(
		noStackWrite.some((command) =>
			command.argv.includes("repos/octo/ryu/stacks")
		)
	).toBe(false);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();

	await companion.getByRole("button", { name: "Create stack" }).click();
	dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Pull request numbers" })
		.fill("101, 102");
	await dialog.getByRole("button", { name: "Create a stack" }).click();
	await expect(
		companion.getByRole("heading", { name: "Stack #900" })
	).toBeVisible();
	const createCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/101/stack"
	);
	expect(createCall.body).toEqual({ pullRequests: [101, 102] });
	const createCommand = await waitForCommand(
		page,
		"repos/octo/ryu/stacks --header"
	);
	expect(createCommand.argv).toContain("pull_requests[]=101");
	expect(createCommand.argv).toContain("pull_requests[]=102");
	const currentLayer = companion.getByRole("button", {
		name: /#101 Protect billing retries/,
	});
	await expect(currentLayer).toBeDisabled();
	await expect(
		companion.getByRole("button", { name: /#102 Rotate session cookie/ })
	).toBeEnabled();

	await companion.getByRole("button", { name: "Add layer" }).click();
	dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Pull request numbers" })
		.fill("103");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	expect(
		await callsWithPath(page, "POST", "/pulls/octo/ryu/101/stack/add")
	).toHaveLength(0);
	await companion.getByRole("button", { name: "Add layer" }).click();
	dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Pull request numbers" })
		.fill("103");
	await dialog.getByRole("button", { name: "Add layers" }).click();
	await expect(
		companion.getByRole("button", { name: /#103 Expose usage export/ })
	).toBeVisible();
	const addCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/101/stack/add"
	);
	expect(addCall.body).toEqual({ pullRequests: [103], stackNumber: 900 });
	const addCommand = await waitForCommand(
		page,
		"repos/octo/ryu/stacks/900/add --header"
	);
	expect(addCommand.argv).toContain("pull_requests[]=103");

	await companion
		.getByRole("button", { name: /#102 Rotate session cookie/ })
		.click();
	await expect(
		companion.getByRole("heading", { name: /Rotate session cookie/ })
	).toBeVisible();
	await expect(
		companion.getByRole("heading", { name: "Stack #900" })
	).toBeVisible();
	await companion.getByRole("button", { name: "Unstack" }).click();
	dialog = companion.getByRole("dialog");
	await expect(dialog.getByText(/removes only unmerged layers/)).toBeVisible();
	await dialog.getByRole("button", { name: "Unstack" }).click();
	await expect(dialog).toBeHidden();
	await expect(
		companion.getByRole("heading", { name: "Stack", exact: true })
	).toBeVisible();
	const unstackCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/102/stack/unstack"
	);
	expect(unstackCall.body).toEqual({ stackNumber: 900 });
	const unstackCommand = await waitForCommand(
		page,
		"repos/octo/ryu/stacks/900/unstack --header"
	);
	expect(unstackCommand.argv).toContain("--method");
	await capture(companion, "pull-requests-companion-stack-unstacked.png");
});

test("all direct merge methods and auto-merge send exact choices and update pull state", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	const cases = [
		{
			number: 101,
			label: "Create merge commit",
			strategy: "merge",
			action: "default",
			auto: false,
			flag: "--merge",
		},
		{
			number: 102,
			label: "Squash and merge",
			strategy: "squash",
			action: "default",
			auto: false,
			flag: "--squash",
		},
		{
			number: 103,
			label: "Rebase and merge",
			strategy: "rebase",
			action: "default",
			auto: false,
			flag: "--rebase",
		},
		{
			number: 106,
			label: "Auto-merge when ready",
			strategy: "squash",
			action: "merge_queue",
			auto: true,
			flag: "--squash --auto",
		},
	] as const;
	for (const item of cases) {
		await openPull(companion, item.number);
		await openPullMergeMenu(companion);
		await companion.getByRole("menuitem", { name: item.label }).click();
		const pathName = `/pulls/${REPOSITORY.split("/").join("/")}/${item.number}/merge`;
		const mergeCall = await waitForCall(page, "POST", pathName);
		expect(mergeCall.body).toEqual({
			auto: item.auto,
			mergeAction: item.action,
			strategy: item.strategy,
		});
		const mergeCommand = await waitForCommand(
			page,
			`pr merge ${item.number} --repo ${REPOSITORY} ${item.flag}`
		);
		expect(mergeCommand.argv).toEqual([
			"pr",
			"merge",
			String(item.number),
			"--repo",
			REPOSITORY,
			...(item.strategy === "merge"
				? ["--merge"]
				: item.strategy === "rebase"
					? ["--rebase"]
					: ["--squash"]),
			...(item.auto ? ["--auto"] : []),
		]);
		await expect
			.poll(
				async () =>
					(await fixtureState(page)).pullDetails[`${REPOSITORY}#${item.number}`]
						?.state
			)
			.toBe("MERGED");
	}
	await capture(companion, "pull-requests-companion-merge-methods.png");
});

test("stack merge menu submits default, queue, direct modes and polls queued completion", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	await createStackThroughDialog(companion);
	const cases = [
		{
			label: "Merge stack through #101",
			strategy: "squash",
			action: "default",
			auto: false,
		},
		{
			label: "Merge directly with a merge commit",
			strategy: "merge",
			action: "direct_merge",
			auto: false,
		},
		{
			label: "Queue stack through #101",
			strategy: "squash",
			action: "merge_queue",
			auto: true,
		},
	] as const;
	const mergeActions: string[] = [];
	for (const item of cases) {
		await clearCalls(page);
		await companion.getByRole("button", { name: "Merge stack" }).click();
		await companion.getByRole("menuitem", { name: item.label }).click();
		const mergeCall = await waitForCall(
			page,
			"POST",
			"/pulls/octo/ryu/101/merge"
		);
		mergeActions.push(String(mergeCall.body?.mergeAction));
		expect(mergeCall.body).toEqual({
			auto: item.auto,
			mergeAction: item.action,
			strategy: item.strategy,
		});
		const endpoint = `repos/${REPOSITORY}/pulls/101/merge-async`;
		const mergeCommand = await waitForCommand(page, `${endpoint} --header`);
		expect(mergeCommand.argv).toContain(`merge_method=${item.strategy}`);
		expect(mergeCommand.argv).toContain(`merge_action=${item.action}`);
		if (item.action === "merge_queue") {
			const statusCommand = await waitForCommand(
				page,
				`repos/${REPOSITORY}/pulls/101/merge-async/00000000-0000-4000-8000-000000000101 --header`
			);
			expect(statusCommand.failed).toBe(false);
			const statusCall = await waitForCall(
				page,
				"GET",
				"/pulls/octo/ryu/101/merge-async/status?id=00000000-0000-4000-8000-000000000101"
			);
			expect(statusCall.status).toBe(200);
			const completedState = await fixtureState(page);
			expect(completedState.pullDetails[`${REPOSITORY}#101`]?.state).toBe(
				"MERGED"
			);
			expect(completedState.pullDetails[`${REPOSITORY}#102`]?.state).toBe(
				"MERGED"
			);
			await expect(
				companion.getByRole("heading", { name: /Expose usage export/ })
			).toBeVisible();
			await expect(companion.getByRole("status")).toContainText(
				"Stack merge completed in test fixture."
			);
			await capture(
				companion,
				"pull-requests-companion-stack-queue-notice-retained.png"
			);
		}
	}
	expect(mergeActions).toEqual(["default", "direct_merge", "merge_queue"]);
	await expect(companion.getByRole("status")).toContainText(
		"Stack merge completed in test fixture."
	);
});

test("device authorization cancellation and success use only the local gh fixture", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "issues", false);
	await expect(
		companion.getByRole("heading", { name: "Connect GitHub" })
	).toBeVisible();
	const signIn = companion.getByRole("button", { name: "Sign in with GitHub" });
	await signIn.click();
	await expect(
		companion.getByRole("button", { name: "Copy one-time GitHub code" })
	).toContainText("ABCD-EFGH");
	await companion.getByRole("button", { name: "Cancel" }).click();
	await expect(companion.getByText("Sign-in cancelled.")).toBeVisible();
	const cancelCall = await waitForCall(page, "DELETE", "/auth/device");
	expect(cancelCall.status).toBe(200);
	const authCommands = (await commands(page)).filter(
		(command) => command.argv[0] === "auth"
	);
	expect(authCommands[0]?.argv).toEqual([
		"auth",
		"login",
		"--hostname",
		"github.com",
		"--git-protocol",
		"https",
		"--skip-ssh-key",
		"--web",
	]);

	await companion.getByRole("button", { name: "Sign in with GitHub" }).click();
	await expect(
		companion.getByRole("button", { name: "Copy one-time GitHub code" })
	).toContainText("ABCD-EFGH");
	const complete = await page.request.post("/__proof/auth-complete");
	expect(complete.status()).toBe(200);
	await expect(companion.getByText("GitHub · @proof-reviewer")).toBeVisible({
		timeout: 8000,
	});
	await expect(companion.locator(".inbox-topline")).toHaveText(
		"GitHub · @proof-reviewer"
	);
	await expect(
		companion.getByRole("option", { name: /Duplicate checkout jobs/ })
	).toBeVisible();
	const authState = await fixtureState(page);
	expect(authState).toMatchObject({ authenticated: true, authComplete: true });
	await capture(companion, "pull-requests-companion-device-auth-complete.png");
});

test("copy one-time GitHub code exposes a selected manual fallback when clipboard writes are denied", async ({
	page,
}) => {
	const hostPort = process.env.RYU_PULL_REQUESTS_PROOF_PORT ?? "5473";
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: `http://127.0.0.1:${hostPort}`,
	});
	const companion = await mountPullRequests(page, "issues", false);
	await companion.getByRole("button", { name: "Sign in with GitHub" }).click();
	const codeButton = companion.getByRole("button", {
		name: "Copy one-time GitHub code",
	});
	await expect(codeButton).toContainText("ABCD-EFGH");
	await codeButton.click();
	await expect(
		companion.getByText("Select the code and copy it manually.")
	).toBeVisible();
	const manualCode = companion.getByRole("textbox", {
		name: "One-time GitHub code",
	});
	await expect(manualCode).toHaveValue("ABCD-EFGH");
	await expect(manualCode).toBeFocused();
	const codeIsSelected = await manualCode.evaluate((element) => {
		if (!(element instanceof HTMLInputElement)) {
			throw new Error("Expected proof element to be an HTMLInputElement.");
		}

		const input = element;
		return (
			input.selectionStart === 0 && input.selectionEnd === input.value.length
		);
	});
	expect(codeIsSelected).toBe(true);
	await capture(
		companion,
		"pull-requests-companion-copy-code-manual-selection.png"
	);
	await companion.getByRole("button", { name: "Cancel" }).click();
	await expect(companion.getByText("Sign-in cancelled.")).toBeVisible();
});

type PublishedItem = Extract<
	AssistantCall,
	{ method: "publishContext" }
>["input"]["items"][number];
type RegisteredSurface = Extract<
	AssistantCall,
	{ method: "registerSurface" }
>["input"];

async function assistantCalls(page: Page): Promise<AssistantCall[]> {
	return await page.evaluate(() => window.__pullRequestsProof.assistantCalls());
}

async function bridgeRpcs(page: Page): Promise<BridgeRpc[]> {
	return await page.evaluate(() => window.__pullRequestsProof.bridgeRpcs());
}

async function releaseRequest(page: Page, pathName: string): Promise<void> {
	await page.evaluate(
		(heldPath) => window.__pullRequestsProof.releaseRequest(heldPath),
		pathName
	);
}

/** What the desktop's global assistant currently holds from this app. */
function assistantView(ledger: AssistantCall[]): {
	context: PublishedItem[];
	surface: RegisteredSurface | null;
} {
	let context: PublishedItem[] = [];
	let surface: RegisteredSurface | null = null;
	for (const call of ledger) {
		if (call.method === "publishContext") {
			context = call.input.items;
		} else if (call.method === "clearContext") {
			context = [];
		} else if (call.method === "registerSurface") {
			surface = call.input;
		} else if (call.method === "clearSurface") {
			surface = null;
		}
	}
	return { context, surface };
}

function publishedItems(ledger: AssistantCall[]): PublishedItem[] {
	return ledger.flatMap((call) =>
		call.method === "publishContext" ? call.input.items : []
	);
}

function expectedReviewItems(
	number: number,
	diffLoaded: boolean
): PublishedItem[] {
	const detail =
		createPullRequestsProofState().pullDetails[`${REPOSITORY}#${number}`];
	if (!detail) {
		throw new Error(`No expected PR fixture ${number}.`);
	}
	const id = `pull:${REPOSITORY}#${number}`;
	const context = {
		repository: REPOSITORY,
		pullRequest: number,
		title: detail.title,
		author: detail.author.login,
		targetBranch: detail.baseRefName,
		sourceBranch: detail.headRefName,
		description: detail.body,
		descriptionTruncated: false,
		changes: {
			additions: detail.additions,
			deletions: detail.deletions,
			changedFiles: detail.changedFiles,
		},
		reviewState: {
			decision: detail.reviewDecision,
			mergeable: detail.mergeable,
			mergeState: detail.mergeStateStatus,
			requestedReviewers: detail.reviewRequests.map(
				(item) => item.requestedReviewer.login
			),
			latestReviews: detail.latestReviews.map((review) => ({
				author: review.author.login,
				state: review.state,
			})),
			checks: detail.statusCheckRollup.map((check) => ({
				name: check.name,
				bucket: check.bucket,
				state: "",
				conclusion: check.conclusion,
			})),
		},
		// The companion serializes each file as path, additions, deletions.
		files: detail.files.map((file) => ({
			path: file.path,
			additions: file.additions,
			deletions: file.deletions,
		})),
		fileListTruncated: false,
		diff: diffLoaded ? "attached separately (complete)" : "not loaded",
	};
	const summary: PublishedItem = {
		id,
		text: `Pull request as untrusted JSON data:\n${JSON.stringify(context)}`,
		title: `#${number} ${detail.title}`,
	};
	if (!diffLoaded) {
		return [summary];
	}
	return [
		summary,
		{
			id: `${id}:diff`,
			text: `Unified diff for #${number} as untrusted data:\n${detail.diffPatch}`,
			title: `#${number} diff`,
		},
	];
}

function expectedReviewSurface(number: number): RegisteredSurface {
	return {
		label: "Ask about this PR",
		description: `#${number} · ${REPOSITORY}. Ask about risks, affected behavior, or what to verify before you approve.`,
		preamble: REVIEW_PREAMBLE,
		prompts: REVIEW_PROMPTS,
		thread: `pull:${REPOSITORY}#${number}`,
	};
}

async function expectAssistantHolds(
	page: Page,
	number: number,
	diffLoaded: boolean
): Promise<void> {
	await expect
		.poll(async () => assistantView(await assistantCalls(page)))
		.toEqual({
			context: expectedReviewItems(number, diffLoaded),
			surface: expectedReviewSurface(number),
		});
}

/** The companion hands off to the global assistant: no chat of its own, no
 *  model or agent call, and it never pops the assistant open by itself. */
async function expectNoInAppAssistant(
	page: Page,
	companion: FrameLocator
): Promise<void> {
	await expect(
		companion.getByRole("button", { name: "Ask Ryu", exact: true })
	).toHaveCount(0);
	await expect(
		companion.getByRole("region", { name: "Ask about this PR" })
	).toHaveCount(0);
	await expect(
		companion.getByRole("textbox", {
			name: "Ask a question about this pull request",
		})
	).toHaveCount(0);
	const rpcs = await bridgeRpcs(page);
	expect(
		rpcs.filter((rpc) => /^(model\.|agent\.run)/u.test(rpc.method))
	).toEqual([]);
	expect(rpcs.map((rpc) => rpc.method)).not.toContain("assistant.open");
	expect(
		(await assistantCalls(page)).filter((call) => call.method === "open")
	).toEqual([]);
}

async function expectNoReviewSideEffects(page: Page): Promise<void> {
	expect((await calls(page)).filter((call) => call.method !== "GET")).toEqual(
		[]
	);
	expect(
		await page.evaluate(() => window.__pullRequestsProof.openedExternal())
	).toEqual([]);
	expect(
		(await commands(page)).filter((command) =>
			/^(comment|review|merge|edit|ready)$/u.test(command.argv[1] ?? "")
		)
	).toEqual([]);
}

test("Ask about this PR publishes the selected PR and its diff to the global assistant without an in-app chat or model call", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls", true, {
		assistantGrant: true,
	});
	await expect(
		companion.getByRole("heading", { name: /Protect billing retries/ })
	).toBeVisible();
	await expectAssistantHolds(page, 101, true);
	const ledger = await assistantCalls(page);
	const publishes = ledger.filter((call) => call.method === "publishContext");
	// The summary goes out as soon as the detail renders; the diff joins it once
	// the single eager diff read lands.
	expect(publishes.at(0)?.input.items).toEqual(expectedReviewItems(101, false));
	expect(publishes.at(-1)?.input.items).toEqual(expectedReviewItems(101, true));
	expect(
		publishedItems(ledger).every((item) =>
			item.id.startsWith(`pull:${REPOSITORY}#101`)
		)
	).toBe(true);
	expect(
		ledger.filter((call) => call.method === "registerSurface")
	).toHaveLength(1);
	await expect
		.poll(async () =>
			(await bridgeRpcs(page))
				.filter((rpc) => rpc.method.startsWith("assistant."))
				.map((rpc) => rpc.outcome)
		)
		.toEqual(["resolved", "resolved", "resolved"]);
	expect(
		await callsWithPath(page, "GET", "/pulls/octo/ryu/101/diff")
	).toHaveLength(1);
	await expectNoInAppAssistant(page, companion);

	await companion.getByRole("tab", { name: /^Changes/ }).click();
	await expect(companion.locator(".diff")).toContainText(
		"idempotencyKey(order)"
	);
	await expect(
		companion.getByRole("button", { name: "Load full patch" })
	).toHaveCount(0);
	expect(
		await callsWithPath(page, "GET", "/pulls/octo/ryu/101/diff")
	).toHaveLength(1);
	expect(
		(await commands(page)).filter(
			(command) =>
				command.argv.join(" ") ===
				`pr diff 101 --repo ${REPOSITORY} --patch --color never`
		)
	).toHaveLength(1);
	expect(await assistantCalls(page)).toEqual(ledger);
	await expectNoReviewSideEffects(page);
});

test("selecting another PR replaces the assistant context and drops the previous PR's late diff", async ({
	page,
}) => {
	const firstDiff = "/pulls/octo/ryu/101/diff";
	const secondDiff = "/pulls/octo/ryu/102/diff";
	const companion = await mountPullRequests(page, "pulls", true, {
		assistantGrant: true,
		holdPaths: [firstDiff, secondDiff],
	});
	await expect(
		companion.getByRole("heading", { name: /Protect billing retries/ })
	).toBeVisible();
	await expectAssistantHolds(page, 101, false);
	await expect
		.poll(async () => (await callsWithPath(page, "GET", firstDiff)).length)
		.toBe(1);
	expect((await callsWithPath(page, "GET", firstDiff))[0]?.status).toBe(0);

	await openPull(companion, 102);
	await expectAssistantHolds(page, 102, false);
	await expect
		.poll(async () => (await callsWithPath(page, "GET", secondDiff)).length)
		.toBe(1);
	const handoff = await assistantCalls(page);
	const firstSecondPublish = handoff.findIndex(
		(call) =>
			call.method === "publishContext" &&
			call.input.items.some((item) =>
				item.id.startsWith(`pull:${REPOSITORY}#102`)
			)
	);
	// PR 101's slice and surface are withdrawn before PR 102 takes over.
	expect(
		handoff
			.slice(0, firstSecondPublish)
			.map((call) => call.method)
			.slice(-2)
			.sort()
	).toEqual(["clearContext", "clearSurface"]);

	// PR 101's diff answers only after PR 102 is selected; it must be dropped.
	await releaseRequest(page, firstDiff);
	expect((await waitForCall(page, "GET", firstDiff)).status).toBe(200);
	await releaseRequest(page, secondDiff);
	expect((await waitForCall(page, "GET", secondDiff)).status).toBe(200);
	await expectAssistantHolds(page, 102, true);

	const ledger = await assistantCalls(page);
	expect(
		publishedItems(ledger).some(
			(item) => item.id === `pull:${REPOSITORY}#101:diff`
		)
	).toBe(false);
	const afterSwitch = publishedItems(ledger.slice(firstSecondPublish));
	expect(
		afterSwitch.every((item) => item.id.startsWith(`pull:${REPOSITORY}#102`))
	).toBe(true);
	expect(
		afterSwitch.some((item) => item.text.includes("idempotencyKey(order)"))
	).toBe(false);

	await companion.getByRole("tab", { name: /^Changes/ }).click();
	await expect(companion.locator(".diff")).toContainText(
		"export const change102 = true;"
	);
	await expect(companion.locator(".diff")).not.toContainText(
		"idempotencyKey(order)"
	);
	expect(await callsWithPath(page, "GET", secondDiff)).toHaveLength(1);
	await expectNoInAppAssistant(page, companion);
	await expectNoReviewSideEffects(page);
});

test("without the assistant grant the companion still reviews PRs and denied assistant calls stay silent", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const companion = await mountPullRequests(page, "pulls");
	await expect(
		companion.getByRole("heading", { name: /Protect billing retries/ })
	).toBeVisible();
	await waitForCall(page, "GET", "/pulls/octo/ryu/101/diff");
	await expect
		.poll(async () =>
			(await bridgeRpcs(page))
				.filter(
					(rpc) =>
						rpc.method.startsWith("assistant.") && rpc.outcome !== "pending"
				)
				.map((rpc) => rpc.method)
				.sort()
		)
		.toEqual([
			"assistant.publishContext",
			"assistant.publishContext",
			"assistant.registerSurface",
		]);
	for (const rpc of (await bridgeRpcs(page)).filter((item) =>
		item.method.startsWith("assistant.")
	)) {
		expect(rpc.outcome).toBe("rejected");
		expect(rpc.error).toContain(
			`Capability not granted: assistant.context (required by ${rpc.method})`
		);
	}
	// The capability gate stops them before the desktop assistant sees anything.
	expect(await assistantCalls(page)).toEqual([]);

	await companion.getByRole("tab", { name: /^Changes/ }).click();
	await expect(companion.locator(".diff")).toContainText(
		"idempotencyKey(order)"
	);
	await openPull(companion, 102);
	await expect(companion.getByText("Details for PR #102.")).toBeVisible();
	await waitForCall(page, "GET", "/pulls/octo/ryu/102/diff");
	await expect(companion.getByRole("alert")).toHaveCount(0);
	await expect(
		companion.getByText(/Capability not granted|assistant\.context/u)
	).toHaveCount(0);
	expect(await assistantCalls(page)).toEqual([]);
	expect(pageErrors).toEqual([]);
	await expectNoInAppAssistant(page, companion);
	await expectNoReviewSideEffects(page);
});
