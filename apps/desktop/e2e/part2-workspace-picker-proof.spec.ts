// Continues workspace-picker-proof.spec.ts (split under the file token limit); helpers live in workspace-picker-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	ALPHA_PATH,
	apiRequests,
	BETA_PATH,
	EVIDENCE_DIR,
	openMenu,
	openPage,
	openPicker,
	requests,
	storedValue,
} from "./workspace-picker-proof.helpers.ts";

test.describe.configure({ timeout: 90_000 });

test("branch creation keeps validation drafts, retries with Enter, and blocks dirty trees", async ({
	page,
}) => {
	await openPage(page, { folder: "alpha" });
	const branchMenu = await openPicker(page, "main");
	await branchMenu.menu
		.getByRole("option", { name: "Create a new branch", exact: true })
		.click();
	let dialog = page.getByRole("dialog", { name: "Create a new branch" });
	await expect(dialog).toBeVisible();
	let input = dialog.getByPlaceholder("feature/my-branch");
	const createButton = dialog.getByRole("button", {
		name: "Create branch",
		exact: true,
	});
	await expect(input).toBeFocused();
	await expect(createButton).toBeDisabled();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(
		apiRequests(await requests(page), "POST", "/api/git/create-branch")
	).toHaveLength(0);

	const retryMenu = await openPicker(page, "main");
	await retryMenu.menu
		.getByRole("option", { name: "Create a new branch", exact: true })
		.click();
	dialog = page.getByRole("dialog", { name: "Create a new branch" });
	input = dialog.getByPlaceholder("feature/my-branch");
	await input.fill(" feature/taken ");
	await input.press("Enter");
	await expect(
		dialog.getByText("That branch already exists.", { exact: true })
	).toBeVisible();
	await expect(input).toHaveValue(" feature/taken ");
	await input.fill(" feature/workspace-proof ");
	await createButton.click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("button", { name: "feature/workspace-proof", exact: true })
	).toBeVisible();
	const creations = apiRequests(
		await requests(page),
		"POST",
		"/api/git/create-branch"
	);
	expect(creations.map((request) => request.body)).toEqual([
		{ cwd: ALPHA_PATH, branch: "feature/taken" },
		{ cwd: ALPHA_PATH, branch: "feature/workspace-proof" },
	]);

	await page.evaluate(() => {
		localStorage.setItem("proof:workspace-picker:dirty", "true");
	});
	await page.reload();
	await expect(
		page.getByRole("button", { name: /feature\/workspace-proof/ })
	).toBeVisible();
	const dirtyMenu = await openPicker(page, /feature\/workspace-proof/);
	await dirtyMenu.menu
		.getByPlaceholder("Search Alpha project branches")
		.fill("main");
	const blockedCreate = dirtyMenu.menu.getByRole("option", {
		name: "Create a new branch",
	});
	await expect(blockedCreate).toBeDisabled();
	const dirtyReason = dirtyMenu.menu.getByText("Commit those changes first", {
		exact: true,
	});
	await expect(dirtyReason).toBeVisible();
	await expect(blockedCreate).toHaveAttribute(
		"aria-describedby",
		(await dirtyReason.getAttribute("id")) ?? ""
	);
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIR}desktop-workspace-picker-branch-dirty-disabled.png`,
	});
	await expect(
		apiRequests(await requests(page), "POST", "/api/git/create-branch")
	).toHaveLength(2);
});

test("stacked summary variant uses direct controls and keeps all dialogs reachable", async ({
	page,
}) => {
	await openPage(page, { folder: "alpha", variant: "stacked" });
	await expect(
		page.getByRole("button", { name: "Alpha project", exact: true })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIR}desktop-workspace-picker-stacked.png`,
	});
	const stackedEnvironment = await openMenu(page, "Build profile");
	await stackedEnvironment.menu
		.getByRole("menuitem", { name: "Test profile", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Test profile", exact: true })
	).toBeVisible();

	const folderMenu = await openPicker(page, "Alpha project");
	await folderMenu.menu
		.getByRole("option", { name: "Open Beta project" })
		.click();
	await expect(
		page.getByRole("button", { name: "Beta project", exact: true })
	).toBeVisible();
	const stackedRunMode = await openPicker(page, "Local");
	await stackedRunMode.menu
		.getByRole("option", { name: "New worktree", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "New worktree", exact: true })
	).toBeVisible();
	const stackedRunMenu = await openPicker(page, "New worktree");
	await stackedRunMenu.menu
		.getByRole("option", { name: "Local", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Local", exact: true })
	).toBeVisible();

	const projectMenu = await openPicker(page, "Beta project");
	await projectMenu.menu
		.getByRole("option", { name: "Start from scratch" })
		.click();
	let dialog = page.getByRole("dialog", { name: "Start from scratch" });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();

	const nextProjectMenu = await openPicker(page, "Beta project");
	await nextProjectMenu.menu
		.getByRole("option", { name: "Clone from Git" })
		.click();
	dialog = page.getByRole("dialog", { name: "Clone Git repository" });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();

	const browserMenu = await openPicker(page, "Beta project");
	await browserMenu.menu
		.getByRole("option", { name: "New project", exact: true })
		.click();
	dialog = page.getByRole("dialog", { name: "Add a project folder to Ryu" });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();

	const betaBranch = page.getByRole("button", { name: "main", exact: true });
	await betaBranch.click();
	const branchMenu = page.getByRole("dialog", { name: "Switch branch" });
	await expect(branchMenu).toBeVisible();
	await branchMenu
		.getByRole("option", { name: "Create a new branch", exact: true })
		.click();
	const branchDialog = page.getByRole("dialog", {
		name: "Create a new branch",
	});
	await expect(branchDialog).toBeVisible();
	await branchDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(branchDialog).toBeHidden();
	await expect
		.poll(() => storedValue(page, "ryu_workspace_folder"))
		.toBe(BETA_PATH);
});
