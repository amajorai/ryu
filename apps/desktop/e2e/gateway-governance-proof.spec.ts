import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type {
	GitGovernanceSettings,
	WorktreeGovernanceSettings,
} from "../src/lib/api/governance.ts";

type GovernanceKind = "git" | "worktrees";
interface GovernanceProofCall {
	body: unknown;
	method: string;
	path: string;
	status: number;
}
interface GovernanceProofSnapshot {
	layers: Array<{
		scope: string;
		values: {
			git?: GitGovernanceSettings;
			worktrees?: WorktreeGovernanceSettings;
		};
	}>;
	schemaVersion: number;
}

function governanceFixture(page: Page) {
	return page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-governance-proof.tsx installs __GATEWAY_GOVERNANCE_PROOF__ before this proof page is evaluated. */ (
				window as Window & {
					__GATEWAY_GOVERNANCE_PROOF__?: {
						armFailure: (kind: GovernanceKind) => void;
						calls: () => GovernanceProofCall[];
						releaseHeldRead: () => void;
						snapshot: () => GovernanceProofSnapshot;
					};
				}
			).__GATEWAY_GOVERNANCE_PROOF__;
		return proof
			? {
					calls: proof.calls(),
					snapshot: proof.snapshot(),
				}
			: null;
	});
}

async function governanceCalls(page: Page): Promise<GovernanceProofCall[]> {
	return (
		(await governanceFixture(page)
			.then((fixture) => fixture?.calls)
			.catch(() => null)) ?? []
	);
}

async function armGovernanceFailure(
	page: Page,
	kind: GovernanceKind
): Promise<void> {
	await page.evaluate((failureKind) => {
		const proof =
			/* SAFETY: gateway-governance-proof.tsx installs __GATEWAY_GOVERNANCE_PROOF__ before this proof page is evaluated. */ (
				window as Window & {
					__GATEWAY_GOVERNANCE_PROOF__?: {
						armFailure: (value: GovernanceKind) => void;
					};
				}
			).__GATEWAY_GOVERNANCE_PROOF__;
		proof?.armFailure(failureKind);
	}, kind);
}

async function waitForGovernanceWrite(
	page: Page,
	kind: GovernanceKind,
	count: number,
	scope: "node" | "user",
	values: GitGovernanceSettings | WorktreeGovernanceSettings,
	status = 200
): Promise<void> {
	const path = `/api/gateway/governance/${kind}`;
	await expect
		.poll(
			async () =>
				(await governanceCalls(page)).filter(
					(call) => call.path === path && call.method === "PUT"
				).length
		)
		.toBe(count);
	const writes = (await governanceCalls(page)).filter(
		(call) => call.path === path && call.method === "PUT"
	);
	expect(writes.at(-1)).toEqual({
		body: { scope, values },
		method: "PUT",
		path,
		status,
	});
}

async function persistedGovernance(
	page: Page
): Promise<GovernanceProofSnapshot> {
	const fixture = await governanceFixture(page);
	if (!fixture) {
		throw new Error("Gateway governance fixture was not installed.");
	}
	return fixture.snapshot;
}

async function fillAndBlur(locator: Locator, value: string): Promise<void> {
	await locator.fill(value);
	await locator.evaluate((element) => element.blur());
}

function evidencePath(name: string): string {
	// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
	// the tracked proof ledger; without it the committed evidence is refreshed.
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	if (override) {
		return path.join(override, `${name}.png`);
	}
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

test.describe.configure({ timeout: 120_000 });

test("shows hook governance, developer tabs, and client surfaces", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});

	await page.goto("/gateway-governance-proof.html");
	await page.waitForLoadState("networkidle");
	await expect(
		page.getByRole("heading", { name: /Hooks, developer defaults/ })
	).toBeVisible();
	await expect(page.getByText("From plugins")).toBeVisible();
	await expect(page.getByText("From config")).toBeVisible();
	await expect(page.getByText("Security Guidance")).toBeVisible();
	await expect(page.getByText("1 needs review")).toBeVisible();
	await page.getByRole("button", { name: "Show details for review" }).click();
	await expect(page.getByText("Sandboxed JavaScript")).toBeVisible();
	await expect(page.getByText("hooks/review.js")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Trust review" })
	).toBeVisible();
	await page.getByRole("button", { name: "Trust review" }).click();
	await expect(
		page.getByRole("button", { name: "Remove trust from review" })
	).toBeVisible();
	const reviewSwitch = page.getByRole("switch", { name: "Disable review" });
	await expect(reviewSwitch).toBeChecked();
	await reviewSwitch.click();
	await expect(
		page.getByRole("switch", { name: "Enable review" })
	).not.toBeChecked();

	const gitSettings = page.getByTestId("proof-git");
	await gitSettings.getByRole("tab", { name: "User", exact: true }).click();
	const draftPullRequests = gitSettings.getByRole("switch", {
		name: "Create draft pull requests",
	});
	await expect(draftPullRequests).not.toBeChecked();
	await draftPullRequests.click();
	await expect(draftPullRequests).toBeChecked();
	await gitSettings.getByRole("tab", { name: "Node", exact: true }).click();
	await gitSettings.getByRole("tab", { name: "User", exact: true }).click();
	await expect(draftPullRequests).toBeChecked();
	const squash = gitSettings.getByRole("button", {
		name: "Squash",
		exact: true,
	});
	await squash.click();
	await expect(squash).toHaveAttribute("aria-pressed", "true");

	const worktreeSettings = page.getByTestId("proof-worktrees");
	await worktreeSettings
		.getByRole("tab", { name: "User", exact: true })
		.click();
	const autoDelete = worktreeSettings.getByRole("switch", {
		name: "Automatically delete old worktrees",
	});
	await expect(autoDelete).toBeChecked();
	await autoDelete.click();
	await expect(autoDelete).not.toBeChecked();
	await worktreeSettings
		.getByRole("tab", { name: "Node", exact: true })
		.click();
	await worktreeSettings
		.getByRole("tab", { name: "User", exact: true })
		.click();
	await expect(autoDelete).not.toBeChecked();

	for (const heading of [
		"Git",
		"Worktrees",
		"Environments",
		"Connected devices",
	]) {
		await expect(
			page.getByRole("heading", { name: heading, exact: true })
		).toBeVisible();
	}
	const connectedDevices = page
		.getByRole("heading", { name: "Connected devices", exact: true })
		.locator("xpath=../..");
	const deviceList = connectedDevices.getByRole("list");
	for (const clientText of [
		"Jiawei",
		"release shell",
		"Chrome",
		"Desktop app",
		"CLI",
		"Mobile",
		"Browser extension",
	]) {
		await expect(deviceList).toContainText(clientText);
	}

	const nodeTrigger = page.getByRole("button", { name: /local/i }).first();
	if (await nodeTrigger.isVisible()) {
		await nodeTrigger.click();
		await expect(page.getByText("CLI", { exact: false }).last()).toBeVisible();
		await nodeTrigger.click();
		await expect(page.getByText("Choose a device")).not.toBeVisible();
	}

	if (errors.length > 0) {
		throw new Error(
			`Gateway governance proof logged browser errors: ${errors.join(" | ")}`
		);
	}

	await page.screenshot({
		fullPage: true,
		path: evidencePath("gateway-connected-devices-surfaces"),
	});
});

test("connected-device settings explains an empty presence list", async ({
	page,
}) => {
	await page.goto("/gateway-governance-proof.html?connections=empty");
	const connectedDevices = page
		.getByRole("heading", { name: "Connected devices", exact: true })
		.locator("xpath=../..");
	await expect(
		connectedDevices.getByText("No other devices have connected recently.")
	).toBeVisible();
});

test("connected-device settings recovers its safe unavailable message on Core failure", async ({
	page,
}) => {
	await page.goto("/gateway-governance-proof.html?connections=error");
	const connectedDevices = page
		.getByRole("heading", { name: "Connected devices", exact: true })
		.locator("xpath=../..");
	await expect(
		connectedDevices.getByText(
			"Connected-device presence is unavailable on this node."
		)
	).toBeVisible();
	await expect(
		connectedDevices.getByText("No other devices have connected recently.")
	).toHaveCount(0);
});

test("Git settings validate, scope, save, and reload every user-level field", async ({
	page,
}) => {
	await page.goto("/gateway-governance-proof.html");
	const git = page.getByTestId("proof-git");
	const branchPrefix = git.getByRole("textbox", { name: "Branch prefix" });
	await expect(branchPrefix).toHaveValue("codex/");
	await expect(
		git.getByRole("button", { name: "Merge", exact: true })
	).toHaveAttribute("aria-pressed", "true");

	for (const [value, message] of [
		["feature branch", "Branch prefixes cannot contain whitespace or '..'."],
		["feature..branch", "Branch prefixes cannot contain whitespace or '..'."],
		["x".repeat(81), "Branch prefixes must be at most 80 bytes."],
	] as const) {
		await fillAndBlur(branchPrefix, value);
		await expect(branchPrefix).toHaveAttribute("aria-invalid", "true");
		await expect(git.getByRole("alert").getByText(message)).toBeVisible();
	}
	expect(
		(await governanceCalls(page)).filter(
			(call) =>
				call.path === "/api/gateway/governance/git" && call.method === "PUT"
		)
	).toHaveLength(0);

	// The Effective view writes a user override. Whitespace around a valid prefix
	// is trimmed before the API request.
	const maxBranchPrefix = "x".repeat(80);
	await fillAndBlur(branchPrefix, maxBranchPrefix);
	await expect(branchPrefix).toHaveValue(maxBranchPrefix);
	await waitForGovernanceWrite(page, "git", 1, "user", {
		branchPrefix: maxBranchPrefix,
	});
	await fillAndBlur(branchPrefix, "  feature/  ");
	await expect(branchPrefix).toHaveValue("feature/");
	await waitForGovernanceWrite(page, "git", 2, "user", {
		branchPrefix: "feature/",
	});

	await git.getByRole("tab", { name: "User", exact: true }).click();
	const createDraftPullRequests = git.getByRole("switch", {
		name: "Create draft pull requests",
	});
	await expect(createDraftPullRequests).not.toBeChecked();
	await createDraftPullRequests.click();
	await waitForGovernanceWrite(page, "git", 3, "user", {
		branchPrefix: "feature/",
		createDraftPullRequests: true,
	});

	const alwaysForcePush = git.getByRole("switch", {
		name: "Always force push",
	});
	await alwaysForcePush.click();
	await waitForGovernanceWrite(page, "git", 4, "user", {
		alwaysForcePush: true,
		branchPrefix: "feature/",
		createDraftPullRequests: true,
	});

	await git.getByRole("button", { name: "Squash", exact: true }).click();
	await waitForGovernanceWrite(page, "git", 5, "user", {
		alwaysForcePush: true,
		branchPrefix: "feature/",
		createDraftPullRequests: true,
		mergeMethod: "squash",
	});
	await git.getByRole("button", { name: "Detached", exact: true }).click();
	await waitForGovernanceWrite(page, "git", 6, "user", {
		alwaysForcePush: true,
		branchPrefix: "feature/",
		createDraftPullRequests: true,
		mergeMethod: "squash",
		reviewDelivery: "detached",
	});

	const autoMergeWhenReady = git.getByRole("switch", {
		name: "Auto-merge when ready",
	});
	await autoMergeWhenReady.click();
	await waitForGovernanceWrite(page, "git", 7, "user", {
		alwaysForcePush: true,
		autoMergeWhenReady: true,
		branchPrefix: "feature/",
		createDraftPullRequests: true,
		mergeMethod: "squash",
		reviewDelivery: "detached",
	});

	const watchInstructions = git.getByRole("textbox", {
		name: "Watch and fix pull requests",
	});
	await fillAndBlur(
		watchInstructions,
		"Comment only after required checks pass."
	);
	await waitForGovernanceWrite(page, "git", 8, "user", {
		alwaysForcePush: true,
		autoMergeWhenReady: true,
		branchPrefix: "feature/",
		createDraftPullRequests: true,
		mergeMethod: "squash",
		reviewDelivery: "detached",
		watchInstructions: "Comment only after required checks pass.",
	});
	const commitInstructions = git.getByRole("textbox", {
		name: "Commit instructions",
	});
	await fillAndBlur(commitInstructions, "Use an imperative subject.");
	await waitForGovernanceWrite(page, "git", 9, "user", {
		alwaysForcePush: true,
		autoMergeWhenReady: true,
		branchPrefix: "feature/",
		commitInstructions: "Use an imperative subject.",
		createDraftPullRequests: true,
		mergeMethod: "squash",
		reviewDelivery: "detached",
		watchInstructions: "Comment only after required checks pass.",
	});
	const pullRequestInstructions = git.getByRole("textbox", {
		name: "Pull request instructions",
	});
	await fillAndBlur(pullRequestInstructions, "Summarize tests and risk.");
	await waitForGovernanceWrite(page, "git", 10, "user", {
		alwaysForcePush: true,
		autoMergeWhenReady: true,
		branchPrefix: "feature/",
		commitInstructions: "Use an imperative subject.",
		createDraftPullRequests: true,
		mergeMethod: "squash",
		pullRequestInstructions: "Summarize tests and risk.",
		reviewDelivery: "detached",
		watchInstructions: "Comment only after required checks pass.",
	});

	const finalUserSettings = {
		alwaysForcePush: true,
		autoMergeWhenReady: true,
		branchPrefix: "feature/",
		commitInstructions: "Use an imperative subject.",
		createDraftPullRequests: true,
		mergeMethod: "squash",
		pullRequestInstructions: "Summarize tests and risk.",
		reviewDelivery: "detached",
		watchInstructions: "Comment only after required checks pass.",
	};
	let snapshot = await persistedGovernance(page);
	expect(
		snapshot.layers.find((layer) => layer.scope === "user")?.values.git
	).toEqual(finalUserSettings);

	await page.reload();
	await expect(branchPrefix).toHaveValue("feature/");
	await expect(createDraftPullRequests).toBeChecked();
	await expect(alwaysForcePush).toBeChecked();
	await expect(
		git.getByRole("button", { name: "Squash", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		git.getByRole("button", { name: "Detached", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		git.getByRole("switch", { name: "Auto-merge when ready" })
	).toBeChecked();
	await expect(
		git.getByRole("textbox", { name: "Watch and fix pull requests" })
	).toHaveValue("Comment only after required checks pass.");
	await expect(
		git.getByRole("textbox", { name: "Commit instructions" })
	).toHaveValue("Use an imperative subject.");
	await expect(
		git.getByRole("textbox", { name: "Pull request instructions" })
	).toHaveValue("Summarize tests and risk.");
	await git.screenshot({
		animations: "disabled",
		path: evidencePath("gateway-git-settings-persisted"),
	});

	// A selected scope must display its own value even if a narrower override wins
	// the effective setting. Editing Node must not silently rewrite User values.
	await git.getByRole("tab", { name: "Node", exact: true }).click();
	await expect(branchPrefix).toHaveValue("codex/");
	await expect(
		git.getByRole("button", { name: "Merge", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	const autoMergeNode = git.getByRole("switch", {
		name: "Auto-merge when ready",
	});
	await expect(autoMergeNode).not.toBeChecked();
	await autoMergeNode.click();
	await waitForGovernanceWrite(page, "git", 1, "node", {
		branchPrefix: "codex/",
		createDraftPullRequests: true,
		mergeMethod: "merge",
		reviewDelivery: "inline",
		autoMergeWhenReady: true,
	});
	await fillAndBlur(branchPrefix, "node/");
	await waitForGovernanceWrite(page, "git", 2, "node", {
		branchPrefix: "node/",
		createDraftPullRequests: true,
		mergeMethod: "merge",
		reviewDelivery: "inline",
		autoMergeWhenReady: true,
	});
	snapshot = await persistedGovernance(page);
	expect(
		snapshot.layers.find((layer) => layer.scope === "user")?.values.git
	).toEqual(finalUserSettings);
	await git.getByRole("tab", { name: "User", exact: true }).click();
	await expect(branchPrefix).toHaveValue("feature/");
});

test("Worktree settings enforce scope and limits, write only governance, and persist", async ({
	page,
}) => {
	await page.goto("/gateway-governance-proof.html");
	const worktrees = page.getByTestId("proof-worktrees");
	const root = worktrees.getByRole("textbox", { name: "Worktree root" });
	const limit = worktrees.getByRole("spinbutton", {
		name: "Auto-delete limit",
	});
	await expect(root).toHaveValue("/proof/managed-worktrees");
	await expect(root).toBeDisabled();
	await expect(limit).toHaveValue("15");

	await worktrees.getByRole("tab", { name: "User", exact: true }).click();
	await expect(root).toBeDisabled();
	for (const value of ["0", "101", "1.5", ""]) {
		await fillAndBlur(limit, value);
		await expect(limit).toHaveAttribute("aria-invalid", "true");
		await expect(
			worktrees.getByText("Enter a whole number from 1 to 100.", {
				exact: true,
			})
		).toBeVisible();
	}
	expect(
		(await governanceCalls(page)).filter(
			(call) =>
				call.path === "/api/gateway/governance/worktrees" &&
				call.method === "PUT"
		)
	).toHaveLength(0);

	await fillAndBlur(limit, "1");
	await expect(limit).toHaveValue("1");
	await waitForGovernanceWrite(page, "worktrees", 1, "user", {
		autoDeleteLimit: 1,
	});
	await fillAndBlur(limit, "100");
	await expect(limit).toHaveValue("100");
	await waitForGovernanceWrite(page, "worktrees", 2, "user", {
		autoDeleteLimit: 100,
	});
	await fillAndBlur(limit, "42");
	await expect(limit).toHaveValue("42");
	await waitForGovernanceWrite(page, "worktrees", 3, "user", {
		autoDeleteLimit: 42,
	});
	const autoDelete = worktrees.getByRole("switch", {
		name: "Automatically delete old worktrees",
	});
	await expect(autoDelete).toBeChecked();
	await autoDelete.click();
	await waitForGovernanceWrite(page, "worktrees", 4, "user", {
		autoDelete: false,
		autoDeleteLimit: 42,
	});
	const fetchUpstream = worktrees.getByRole("switch", {
		name: "Always fetch upstream before creating worktrees",
	});
	await expect(fetchUpstream).not.toBeChecked();
	await fetchUpstream.click();
	await waitForGovernanceWrite(page, "worktrees", 5, "user", {
		autoDelete: false,
		autoDeleteLimit: 42,
		fetchUpstream: true,
	});

	let snapshot = await persistedGovernance(page);
	expect(
		snapshot.layers.find((layer) => layer.scope === "user")?.values.worktrees
	).toEqual({ autoDelete: false, autoDeleteLimit: 42, fetchUpstream: true });
	await page.reload();
	await expect(limit).toHaveValue("42");
	await expect(autoDelete).not.toBeChecked();
	await expect(fetchUpstream).toBeChecked();

	await worktrees.getByRole("tab", { name: "Node", exact: true }).click();
	await expect(autoDelete).toBeChecked();
	await expect(limit).toHaveValue("15");
	await expect(root).toBeEnabled();
	await expect(root).toHaveValue("/proof/managed-worktrees");
	await fillAndBlur(root, "  /proof/isolated-worktrees  ");
	await waitForGovernanceWrite(page, "worktrees", 1, "node", {
		autoDelete: true,
		autoDeleteLimit: 15,
		fetchUpstream: false,
		root: "/proof/isolated-worktrees",
	});
	snapshot = await persistedGovernance(page);
	expect(
		snapshot.layers.find((layer) => layer.scope === "node")?.values.worktrees
	).toEqual({
		autoDelete: true,
		autoDeleteLimit: 15,
		fetchUpstream: false,
		root: "/proof/isolated-worktrees",
	});

	await page.reload();
	await worktrees.getByRole("tab", { name: "Node", exact: true }).click();
	await expect(root).toHaveValue("/proof/isolated-worktrees");
	await expect(limit).toHaveValue("15");
	await worktrees.screenshot({
		animations: "disabled",
		path: evidencePath("gateway-worktrees-settings-persisted"),
	});
	const calls = await governanceCalls(page);
	expect(
		calls.some(
			(call) =>
				call.path.startsWith("/api/worktree/") &&
				(call.method === "POST" || call.method === "DELETE")
		)
	).toBe(false);
});

test("Git and Worktree settings wait for reads, expose retry, and respect write permissions", async ({
	page,
}) => {
	await page.goto("/gateway-governance-proof.html?holdGovernanceRead=1");
	const git = page.getByTestId("proof-git");
	const worktrees = page.getByTestId("proof-worktrees");
	const branchPrefix = git.getByRole("textbox", { name: "Branch prefix" });
	const fetchUpstream = worktrees.getByRole("switch", {
		name: "Always fetch upstream before creating worktrees",
	});
	await expect(git.getByRole("status")).toHaveText("Loading Git settings…");
	await expect(worktrees.getByRole("status")).toHaveText(
		"Loading Worktree settings…"
	);
	await expect(branchPrefix).toBeDisabled();
	await expect(fetchUpstream).toBeDisabled();
	await page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-governance-proof.tsx installs __GATEWAY_GOVERNANCE_PROOF__ before this proof page is evaluated. */ (
				window as Window & {
					__GATEWAY_GOVERNANCE_PROOF__?: { releaseHeldRead: () => void };
				}
			).__GATEWAY_GOVERNANCE_PROOF__;
		proof?.releaseHeldRead();
	});
	await expect(branchPrefix).toBeEnabled();
	await expect(fetchUpstream).toBeEnabled();

	await page.goto(
		"/gateway-governance-proof.html?failGovernanceReadOnce=1&canConfigure=false"
	);
	const readOnlyGit = page.getByTestId("proof-git");
	const readOnlyWorktrees = page.getByTestId("proof-worktrees");
	await expect
		.poll(async () =>
			(await governanceCalls(page)).filter(
				(call) => call.path === "/api/gateway/governance"
			)
		)
		.toEqual([
			{
				body: null,
				method: "GET",
				path: "/api/gateway/governance",
				status: 503,
			},
		]);
	await expect(
		readOnlyGit
			.getByRole("alert")
			.getByText(
				"We couldn’t load Git settings. Try again before editing them."
			)
	).toBeVisible();
	await expect(
		readOnlyWorktrees
			.getByRole("alert")
			.getByText(
				"We couldn’t load Worktree settings. Try again before editing them."
			)
	).toBeVisible();
	const failedReadCalls = await governanceCalls(page);
	expect(
		failedReadCalls.filter((call) => call.path === "/api/gateway/governance")
	).toEqual([
		{ body: null, method: "GET", path: "/api/gateway/governance", status: 503 },
	]);
	expect(failedReadCalls.filter((call) => call.method === "PUT")).toHaveLength(
		0
	);
	await readOnlyGit.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		readOnlyGit.getByRole("textbox", { name: "Branch prefix" })
	).toBeEnabled();

	await readOnlyGit.getByRole("tab", { name: "Node", exact: true }).click();
	await expect(
		readOnlyGit.getByRole("textbox", { name: "Branch prefix" })
	).toBeDisabled();
	await readOnlyWorktrees
		.getByRole("tab", { name: "Node", exact: true })
		.click();
	await expect(
		readOnlyWorktrees.getByRole("switch", {
			name: "Always fetch upstream before creating worktrees",
		})
	).toBeDisabled();
	await expect(
		readOnlyWorktrees.getByRole("textbox", { name: "Worktree root" })
	).toBeDisabled();
	await readOnlyGit
		.getByRole("tab", { name: "Organization", exact: true })
		.click();
	await expect(
		readOnlyGit.getByRole("switch", { name: "Always force push" })
	).toBeDisabled();
	await readOnlyWorktrees
		.getByRole("tab", { name: "Team", exact: true })
		.click();
	await expect(
		readOnlyWorktrees.getByRole("switch", {
			name: "Automatically delete old worktrees",
		})
	).toBeDisabled();
	await readOnlyGit.getByRole("tab", { name: "User", exact: true }).click();
	const draftSwitch = readOnlyGit.getByRole("switch", {
		name: "Create draft pull requests",
	});
	await expect(draftSwitch).toBeEnabled();
	await draftSwitch.click();
	await waitForGovernanceWrite(page, "git", 1, "user", {
		createDraftPullRequests: true,
	});
	const finalCalls = await governanceCalls(page);
	expect(
		finalCalls.filter((call) => call.path === "/api/gateway/governance")
	).toEqual([
		{ body: null, method: "GET", path: "/api/gateway/governance", status: 503 },
		{ body: null, method: "GET", path: "/api/gateway/governance", status: 200 },
	]);
});

test("Git and Worktree save failures preserve scope and retry the exact request", async ({
	page,
}) => {
	await page.goto("/gateway-governance-proof.html");
	const git = page.getByTestId("proof-git");
	const worktrees = page.getByTestId("proof-worktrees");
	await git.getByRole("tab", { name: "User", exact: true }).click();
	await armGovernanceFailure(page, "git");
	await git.getByRole("button", { name: "Squash", exact: true }).click();
	await expect(
		git
			.getByRole("alert")
			.getByText("We couldn’t save Git settings. Retry the last change.")
	).toBeVisible();
	await waitForGovernanceWrite(
		page,
		"git",
		1,
		"user",
		{
			mergeMethod: "squash",
		},
		503
	);
	expect(
		(await persistedGovernance(page)).layers.find(
			(layer) => layer.scope === "user"
		)?.values.git
	).toBeUndefined();
	await git.getByRole("tab", { name: "Node", exact: true }).click();
	await git
		.getByRole("button", { name: "Retry Git save", exact: true })
		.click();
	await waitForGovernanceWrite(page, "git", 2, "user", {
		mergeMethod: "squash",
	});
	await expect(
		(await persistedGovernance(page)).layers.find(
			(layer) => layer.scope === "user"
		)?.values.git
	).toEqual({ mergeMethod: "squash" });
	await expect(
		git.getByRole("button", { name: "Merge", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await git.getByRole("tab", { name: "User", exact: true }).click();
	await expect(
		git.getByRole("button", { name: "Squash", exact: true })
	).toHaveAttribute("aria-pressed", "true");

	await worktrees.getByRole("tab", { name: "User", exact: true }).click();
	await armGovernanceFailure(page, "worktrees");
	const autoDelete = worktrees.getByRole("switch", {
		name: "Automatically delete old worktrees",
	});
	await autoDelete.click();
	await expect(
		worktrees
			.getByRole("alert")
			.getByText("We couldn’t save Worktree settings. Retry the last change.")
	).toBeVisible();
	await waitForGovernanceWrite(
		page,
		"worktrees",
		1,
		"user",
		{
			autoDelete: false,
		},
		503
	);
	await expect(autoDelete).toBeChecked();
	await worktrees.getByRole("tab", { name: "Node", exact: true }).click();
	await worktrees
		.getByRole("button", { name: "Retry Worktree save", exact: true })
		.click();
	await waitForGovernanceWrite(page, "worktrees", 2, "user", {
		autoDelete: false,
	});
	await expect(
		(await persistedGovernance(page)).layers.find(
			(layer) => layer.scope === "user"
		)?.values.worktrees
	).toEqual({ autoDelete: false });
	await worktrees.getByRole("tab", { name: "User", exact: true }).click();
	await expect(autoDelete).not.toBeChecked();
	await page.reload();
	await worktrees.getByRole("tab", { name: "User", exact: true }).click();
	await expect(autoDelete).not.toBeChecked();
	await expect(
		git.getByRole("button", { name: "Squash", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await git.screenshot({
		animations: "disabled",
		path: evidencePath("gateway-governance-save-retry-reloaded"),
	});
});
