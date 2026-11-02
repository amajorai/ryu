// Continues gateway-governance-proof.spec.ts (split under the file token limit); helpers live in gateway-governance-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	armGovernanceFailure,
	evidencePath,
	governanceCalls,
	persistedGovernance,
	waitForGovernanceWrite,
} from "./gateway-governance-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

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
