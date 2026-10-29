import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { InvokeArgs } from "@tauri-apps/api/core";

const COMMIT_SHA = "abcdef012345678901234567890123456789abcd";
const LOG_COMMAND = "git log -n 50 --pretty=format:%H%x09%s";
const BRANCH_COMMAND = 'git branch --format="%(refname:short)"';

interface PatchDiffCall {
	args?: InvokeArgs;
	command: string;
}

interface PatchDiffProofFixture {
	failNextCommand: (command: string, message?: string) => void;
	holdNextCommand: (command: string) => void;
	resolveHeldCommand: (command: string) => void;
}

declare global {
	interface Window {
		__patchDiffCalls: PatchDiffCall[];
		__patchDiffFixture: PatchDiffProofFixture;
	}
}

async function calls(page: import("@playwright/test").Page) {
	return page.evaluate(() => window.__patchDiffCalls);
}

async function openSourceMenu(page: import("@playwright/test").Page) {
	await page
		.getByRole("button", {
			name: /Working tree|Staged|Initial baseline|feature\/review/,
		})
		.click();
	return page.getByRole("menu");
}

test("diff source controls render the selected Git result and patch preferences", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	const consoleIssues: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" || message.type() === "warning") {
			consoleIssues.push(message.text());
		}
	});
	await page.goto("/patch-diff-panel-proof.html");

	await expect(
		page.getByRole("heading", { name: "Project changes" })
	).toBeVisible();
	await expect(page.getByText("src/working.ts", { exact: true })).toBeVisible();
	await expect(page.getByText("working tree", { exact: true })).toBeVisible();
	await expect(
		page.getByText("No changes for this selection.", { exact: true })
	).toHaveCount(0);
	const evidenceDir = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, "desktop-patch-diff-working-tree.png"),
	});

	const initialCalls = await calls(page);
	expect(initialCalls).toEqual(
		expect.arrayContaining([
			{
				args: {
					command: "git diff HEAD",
					cwd: "/Users/demo/demo-repo",
					shell: null,
				},
				command: "shell_execute",
			},
			{
				args: {
					command: LOG_COMMAND,
					cwd: "/Users/demo/demo-repo",
					shell: null,
				},
				command: "shell_execute",
			},
			{
				args: {
					command: BRANCH_COMMAND,
					cwd: "/Users/demo/demo-repo",
					shell: null,
				},
				command: "shell_execute",
			},
		])
	);

	const stacked = page.getByRole("button", { name: "Stacked", exact: true });
	await stacked.click();
	await expect(stacked).toHaveAttribute("aria-pressed", "true");
	expect(
		await page.evaluate(() => localStorage.getItem("ryu:diff-view-prefs"))
	).toContain('"diffStyle":"unified"');
	const split = page.getByRole("button", { name: "Split", exact: true });
	await split.click();
	await expect(split).toHaveAttribute("aria-pressed", "true");

	const edit = page.getByRole("button", { name: "Edit", exact: true });
	await edit.click();
	const editing = page.getByRole("button", { name: "Editing", exact: true });
	await expect(editing).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByText("Edit mode", { exact: true })).toBeVisible();

	let menu = await openSourceMenu(page);
	await menu.getByRole("menuitem", { name: "Staged", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Staged", exact: true })
	).toBeVisible();
	const readOnlyEdit = page.getByRole("button", { name: "Edit", exact: true });
	await expect(readOnlyEdit).toBeDisabled();
	await expect(readOnlyEdit).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByText("src/staged.ts", { exact: true })).toBeVisible();
	await expect(page.locator("body")).toContainText("staged change");
	expect(await calls(page)).toContainEqual({
		args: {
			command: "git diff --staged",
			cwd: "/Users/demo/demo-repo",
			shell: null,
		},
		command: "shell_execute",
	});

	menu = await openSourceMenu(page);
	await menu.getByRole("menuitem", { name: "Commit", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "abcdef0 Initial baseline", exact: true })
		.click();
	await expect(
		page.getByText("abcdef0 Initial baseline", { exact: true })
	).toBeVisible();
	await expect(page.getByText("src/commit.ts", { exact: true })).toBeVisible();
	await expect(page.locator("body")).toContainText("selected commit");
	expect(await calls(page)).toContainEqual({
		args: {
			command: `git diff-tree -p --no-commit-id --root ${COMMIT_SHA}`,
			cwd: "/Users/demo/demo-repo",
			shell: null,
		},
		command: "shell_execute",
	});

	menu = await openSourceMenu(page);
	await menu.getByRole("menuitem", { name: "Branch", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "feature/review", exact: true })
		.click();
	await expect(
		page.getByText("feature/review…HEAD", { exact: true })
	).toBeVisible();
	await expect(readOnlyEdit).toBeDisabled();
	await expect(page.getByText("src/branch.ts", { exact: true })).toBeVisible();
	await expect(page.locator("body")).toContainText("branch change");
	expect(await calls(page)).toContainEqual({
		args: {
			command: "git diff feature/review...HEAD",
			cwd: "/Users/demo/demo-repo",
			shell: null,
		},
		command: "shell_execute",
	});

	const evidencePath = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-patch-diff-sources.png"
	);
	await mkdir(path.dirname(evidencePath), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath,
	});

	menu = await openSourceMenu(page);
	await menu
		.getByRole("menuitem", { name: "Working tree", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Working tree", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Edit", exact: true })
	).toBeEnabled();
	await expect(page.getByText("src/working.ts", { exact: true })).toBeVisible();
	expect(await calls(page)).toContainEqual({
		args: {
			command: "git diff HEAD",
			cwd: "/Users/demo/demo-repo",
			shell: null,
		},
		command: "shell_execute",
	});
	expect(pageErrors).toEqual([]);
	expect(consoleIssues).toEqual([]);
});

test("shows empty commit and branch menus without hiding the empty diff state", async ({
	page,
}) => {
	await page.goto("/patch-diff-panel-proof.html?empty=1");
	await expect(
		page.getByText("No changes for this selection.", { exact: true })
	).toBeVisible();

	const menu = await openSourceMenu(page);
	await menu.getByRole("menuitem", { name: "Commit", exact: true }).click();
	await expect(
		page.getByRole("menuitem", { name: "No commits", exact: true })
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(
		menu.getByRole("menuitem", { name: "Branch", exact: true })
	).toBeVisible();
	await menu.getByRole("menuitem", { name: "Branch", exact: true }).hover();
	await expect(
		page.getByRole("menuitem", { name: "No branches", exact: true })
	).toBeDisabled();
});

test("refresh displays nonzero Git results, retries successfully, and exposes pending work", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	const consoleIssues: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" || message.type() === "warning") {
			consoleIssues.push(message.text());
		}
	});
	await page.goto("/patch-diff-panel-proof.html");
	await expect(page.getByText("src/working.ts", { exact: true })).toBeVisible();

	const refresh = page.getByRole("button", { name: "Refresh diff" });
	await refresh.hover();
	await expect(page.getByText("Refresh diff", { exact: true })).toBeVisible();
	await page.evaluate(() => {
		window.__patchDiffFixture.failNextCommand(
			"git diff HEAD",
			"fatal: fixture repository is unavailable"
		);
	});
	await refresh.click();
	await expect(page.getByRole("alert")).toHaveText(
		"fatal: fixture repository is unavailable"
	);
	await refresh.click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByText("src/working.ts", { exact: true })).toBeVisible();
	await expect(page.getByText("working tree", { exact: true })).toBeVisible();

	await page.evaluate(() => {
		window.__patchDiffFixture.holdNextCommand("git diff HEAD");
	});
	await refresh.click();
	await expect(page.getByText("Loading diff…", { exact: true })).toBeVisible();
	await page.evaluate(() => {
		window.__patchDiffFixture.resolveHeldCommand("git diff HEAD");
	});
	await expect(page.getByText("Loading diff…", { exact: true })).toHaveCount(0);
	await expect(page.getByText("src/working.ts", { exact: true })).toBeVisible();
	expect(pageErrors).toEqual([]);
	expect(consoleIssues).toEqual([]);
});
