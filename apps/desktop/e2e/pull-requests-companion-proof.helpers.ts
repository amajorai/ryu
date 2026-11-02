import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import {
	REVIEW_PREAMBLE,
	REVIEW_PROMPTS,
} from "../../../apps-store/pull-requests/ui/src/ai-review.ts";
import { createPullRequestsProofState } from "./harness/pull-requests-companion-fixture.ts";
import type { PullRequestsProofApi } from "./harness/pull-requests-companion-proof.tsx";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for pull-requests-companion-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const APP_HTML = `${tmpdir()}/ryu-pull-requests-companion-ui-build/index.html`;
export const EVIDENCE = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);
export const REPOSITORY = "octo/ryu";

export interface PullRequestsCall {
	body?: unknown;
	method: string;
	path: string;
	result?: unknown;
	status: number;
}

export interface GhCommand {
	argv: string[];
	cwd: string | null;
	failed: boolean;
}

export interface ProofState {
	issues: Array<{ number: number; state: string; title: string }>;
	pullDetails: Record<
		string,
		{ isDraft: boolean; state: string; title: string }
	>;
}

export type AssistantCall = ReturnType<
	PullRequestsProofApi["assistantCalls"]
>[number];
export type BridgeRpc = ReturnType<PullRequestsProofApi["bridgeRpcs"]>[number];

export interface MountOptions {
	/** Grant `assistant:context`, as the shipped manifest does. */
	assistantGrant?: boolean;
	/** App requests the harness holds from the first frame load until released. */
	holdPaths?: string[];
}

export async function mountPullRequests(
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

export async function calls(page: Page): Promise<PullRequestsCall[]> {
	return await page.evaluate(() => window.__pullRequestsProof.calls());
}

export async function commands(page: Page): Promise<GhCommand[]> {
	const response = await page.request.get("/__proof/commands");
	expect(response.status()).toBe(200);
	return await response.json();
}

export async function fixtureState(page: Page): Promise<ProofState> {
	const response = await page.request.get("/__proof/state");
	expect(response.status()).toBe(200);
	return await response.json();
}

export async function clearCalls(page: Page): Promise<void> {
	await page.evaluate(() => window.__pullRequestsProof.clearCalls());
}

export async function failNext(
	page: Page,
	match: string,
	message: string
): Promise<void> {
	const response = await page.request.post("/__proof/fail-next", {
		data: { match, message },
	});
	expect(response.status()).toBe(200);
}

export async function callsWithPath(
	page: Page,
	method: string,
	pathName: string
): Promise<PullRequestsCall[]> {
	return (await calls(page)).filter(
		(call) => call.method === method && call.path === pathName
	);
}

export async function waitForCall(
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

export async function waitForCommand(
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

export async function capture(
	companion: FrameLocator,
	filename: string
): Promise<void> {
	await mkdir(EVIDENCE, { recursive: true });
	await companion.locator("body").screenshot({
		animations: "disabled",
		path: path.join(EVIDENCE, filename),
	});
}

export function listPath(
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

export async function openPull(
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

export async function openPullMergeMenu(
	companion: FrameLocator
): Promise<void> {
	await companion.getByRole("button", { name: /^Merge$/ }).click();
}

export async function createStackThroughDialog(
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

export type PublishedItem = Extract<
	AssistantCall,
	{ method: "publishContext" }
>["input"]["items"][number];
export type RegisteredSurface = Extract<
	AssistantCall,
	{ method: "registerSurface" }
>["input"];

export async function assistantCalls(page: Page): Promise<AssistantCall[]> {
	return await page.evaluate(() => window.__pullRequestsProof.assistantCalls());
}

export async function bridgeRpcs(page: Page): Promise<BridgeRpc[]> {
	return await page.evaluate(() => window.__pullRequestsProof.bridgeRpcs());
}

export async function releaseRequest(
	page: Page,
	pathName: string
): Promise<void> {
	await page.evaluate(
		(heldPath) => window.__pullRequestsProof.releaseRequest(heldPath),
		pathName
	);
}

/** What the desktop's global assistant currently holds from this app. */
export function assistantView(ledger: AssistantCall[]): {
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

export function publishedItems(ledger: AssistantCall[]): PublishedItem[] {
	return ledger.flatMap((call) =>
		call.method === "publishContext" ? call.input.items : []
	);
}

export function expectedReviewItems(
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

export function expectedReviewSurface(number: number): RegisteredSurface {
	return {
		label: "Ask about this PR",
		description: `#${number} · ${REPOSITORY}. Ask about risks, affected behavior, or what to verify before you approve.`,
		preamble: REVIEW_PREAMBLE,
		prompts: REVIEW_PROMPTS,
		thread: `pull:${REPOSITORY}#${number}`,
	};
}

export async function expectAssistantHolds(
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
export async function expectNoInAppAssistant(
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

export async function expectNoReviewSideEffects(page: Page): Promise<void> {
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
