import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
	decodeWorkspaceEnvironments,
	decodeWorkspaceRecents,
	decodeWorkspaceRequests,
	decodeWorkspaceTerminalRequest,
	isExactWorkspaceTrigger,
	type WorkspaceFixtureRequest,
} from "./workspace-picker-proof.contracts.ts";

const STORY_URL = "/workspace-picker-proof.html";
const EVIDENCE_DIR = fileURLToPath(
	new URL(
		"../../../docs/proof/test-coverage-sweep-20260924/evidence/",
		import.meta.url
	)
);
const HOME_PATH = "/fixture/home";
const PROJECTS_PATH = `${HOME_PATH}/Projects`;
const ALPHA_PATH = `${PROJECTS_PATH}/alpha`;
const BETA_PATH = `${PROJECTS_PATH}/beta`;
const CREATED_FOLDER_PATH = `${HOME_PATH}/Documents/Ryu/Fresh Project`;
const CLONED_FOLDER_PATH = `${HOME_PATH}/Documents/Ryu/agent-runtime`;
const REQUESTS_KEY = "proof:workspace-picker:requests";

declare global {
	interface Window {
		__workspacePickerProof?: {
			releaseBranches: () => void;
			releaseHomeListing: () => void;
		};
	}
}

async function openPage(
	page: Page,
	options: { cloud?: boolean; folder?: "alpha"; variant?: "stacked" } = {}
) {
	const query = new URLSearchParams({ reset: "1" });
	if (options.folder) {
		query.set("folder", options.folder);
	}
	if (options.variant) {
		query.set("variant", options.variant);
	}
	if (options.cloud) {
		query.set("cloud", "1");
	}
	await page.setViewportSize({ height: 980, width: 1440 });
	await page.goto(`${STORY_URL}?${query.toString()}`);
	await expect(page.getByTestId("workspace-picker-proof")).toBeVisible();
}

async function requests(page: Page): Promise<WorkspaceFixtureRequest[]> {
	const raw = await page.evaluate(
		(key) => localStorage.getItem(key),
		REQUESTS_KEY
	);
	return raw ? decodeWorkspaceRequests(raw) : [];
}

async function storedValue(page: Page, key: string) {
	return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

async function openMenu(page: Page, triggerName: string | RegExp) {
	const trigger = page.getByRole("button", {
		name: triggerName,
		exact: isExactWorkspaceTrigger(triggerName),
	});
	await trigger.click();
	const menu = page.getByRole("menu").last();
	await expect(menu).toBeVisible();
	return { menu, trigger };
}

/** Project, run-location and branch controls open command dialogs. */
async function openPicker(page: Page, triggerName: string | RegExp) {
	const trigger = page.getByRole("button", {
		name: triggerName,
		exact: isExactWorkspaceTrigger(triggerName),
	});
	await trigger.click();
	const menu = page.getByRole("dialog").last();
	await expect(menu).toBeVisible();
	return { menu, trigger };
}

function apiRequests(
	items: WorkspaceFixtureRequest[],
	method: string,
	path: string
): WorkspaceFixtureRequest[] {
	return items.filter((item) => item.method === method && item.path === path);
}

test.describe.configure({ timeout: 90_000 });

test("the real composer picker selects, clears, and restores the active project", async ({
	page,
}) => {
	await openPage(page);
	const { menu, trigger } = await openPicker(page, "Project");
	await expect(menu.getByPlaceholder("Search projects")).toBeVisible();
	await menu.press("Escape");
	await expect(menu).toBeHidden();
	await expect(trigger).toBeFocused();

	const picker = await openPicker(page, "Project");
	await picker.menu.getByRole("option", { name: "Open Alpha project" }).click();
	await expect(picker.menu).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Alpha project", exact: true })
	).toBeVisible();
	await expect
		.poll(() => storedValue(page, "ryu_workspace_folder"))
		.toBe(ALPHA_PATH);
	await expect
		.poll(async () => {
			const recent = await storedValue(page, "ryu_workspace_recents");
			return recent ? decodeWorkspaceRecents(recent)[0] : null;
		})
		.toBe(ALPHA_PATH);
	const alphaValidation = apiRequests(
		await requests(page),
		"GET",
		`/api/workspace/list?path=${encodeURIComponent(ALPHA_PATH)}`
	);
	expect(alphaValidation.length).toBeGreaterThan(0);
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIR}desktop-workspace-picker-selected.png`,
	});

	const selected = await openPicker(page, "Alpha project");
	await selected.menu
		.getByRole("option", { name: "Do not work in a project", exact: true })
		.click();
	await expect(selected.menu).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Project", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "main", exact: true })
	).toHaveCount(0);
	await expect.poll(() => storedValue(page, "ryu_workspace_folder")).toBeNull();

	await page.reload();
	await expect(
		page.getByRole("button", { name: "Project", exact: true })
	).toBeVisible();
	await expect.poll(() => storedValue(page, "ryu_workspace_folder")).toBeNull();
	await expect
		.poll(async () => {
			const recent = await storedValue(page, "ryu_workspace_recents");
			return recent
				? decodeWorkspaceRecents(recent).includes(ALPHA_PATH)
				: false;
		})
		.toBe(true);
});

test("clones Azure DevOps, GitLab, and custom Git URLs onto the active node", async ({
	page,
}) => {
	await openPage(page, { cloud: true });
	const { menu } = await openPicker(page, "Project");
	await menu.getByRole("option", { name: "Clone from Git" }).click();
	const dialog = page.getByRole("dialog", { name: "Clone Git repository" });
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByText(/GitHub, GitLab, Azure DevOps, or other Git repository/)
	).toBeVisible();

	const repositoryUrl = dialog.getByLabel("Repository URL");
	const folderName = dialog.getByLabel("Folder name");
	await repositoryUrl.fill("https://gitlab.com/group/subgroup/frontend.git");
	await expect(folderName).toHaveValue("frontend");
	await repositoryUrl.fill("git@git.example.test:team/custom-service.git");
	await expect(folderName).toHaveValue("custom-service");
	const azureUrl = "https://dev.azure.com/acme/p/_git/agent-runtime";
	await repositoryUrl.fill(azureUrl);
	await expect(folderName).toHaveValue("agent-runtime");
	await expect(
		dialog.getByText('onto the "Sandbox Cloud" node', { exact: false })
	).toBeVisible();
	await repositoryUrl.evaluate((input: HTMLInputElement) =>
		input.setSelectionRange(0, 0)
	);
	const dialogScreenshotPath =
		process.env.RYU_SANDBOX_PROVIDER_DIALOG_PROOF_PATH;
	if (dialogScreenshotPath) {
		await dialog.screenshot({
			animations: "disabled",
			path: dialogScreenshotPath,
		});
	}
	await dialog.getByRole("button", { name: "Clone repository" }).click();
	await expect(dialog).toBeHidden();
	await expect
		.poll(() => storedValue(page, "ryu_workspace_folder"))
		.toBe(CLONED_FOLDER_PATH);
	await expect(
		page.getByRole("button", { name: "agent-runtime", exact: true })
	).toBeVisible();
	expect(
		apiRequests(await requests(page), "POST", "/api/workspace/clone").map(
			(request) => request.body
		)
	).toEqual([{ name: "agent-runtime", url: azureUrl }]);
	expect(
		apiRequests(await requests(page), "POST", "/api/workspace/clone").map(
			(request) => request.origin
		)
	).toEqual(["http://sandbox-cloud.example.test:7980"]);

	const screenshotPath = process.env.RYU_SANDBOX_PROVIDER_PROOF_PATH;
	if (screenshotPath) {
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: screenshotPath,
		});
	}
});

test("Start from scratch keeps validation drafts, retries the exact Core write, and reloads", async ({
	page,
}) => {
	await openPage(page);
	const projectMenu = await openPicker(page, "Project");
	await projectMenu.menu
		.getByRole("option", { name: "Start from scratch" })
		.click();
	const dialog = page.getByRole("dialog", { name: "Start from scratch" });
	await expect(dialog).toBeVisible();
	const input = dialog.getByPlaceholder("New project name");
	const create = dialog.getByRole("button", {
		name: "Create project",
		exact: true,
	});
	await expect(input).toBeFocused();
	await expect(create).toBeDisabled();

	await input.fill(" Taken ");
	await input.press("Enter");
	await expect(
		dialog.getByText("A project with that name already exists.", {
			exact: true,
		})
	).toBeVisible();
	await expect(input).toHaveValue(" Taken ");
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIR}desktop-workspace-picker-project-validation.png`,
	});

	await input.fill("Fresh Project");
	await create.click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Fresh Project", exact: true })
	).toBeVisible();
	await expect
		.poll(() => storedValue(page, "ryu_workspace_folder"))
		.toBe(CREATED_FOLDER_PATH);
	const creates = apiRequests(
		await requests(page),
		"POST",
		"/api/workspace/new-folder"
	);
	expect(creates.map((request) => request.body)).toEqual([
		{ name: "Taken" },
		{ name: "Fresh Project" },
	]);
	await expect
		.poll(() => storedValue(page, "ryu_workspace_projects_v1"))
		.toContain(CREATED_FOLDER_PATH);
	const cloneMenu = await openPicker(page, "Fresh Project");
	await cloneMenu.menu.getByRole("option", { name: "Clone from Git" }).click();
	const cloneDialog = page.getByRole("dialog", {
		name: "Clone Git repository",
	});
	await expect(cloneDialog).toBeVisible();
	await cloneDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(cloneDialog).toBeHidden();
	await expect(
		apiRequests(await requests(page), "POST", "/api/workspace/clone")
	).toHaveLength(0);

	await page.reload();
	await expect(
		page.getByRole("button", { name: "Fresh Project", exact: true })
	).toBeVisible();
	await expect
		.poll(() => storedValue(page, "ryu_workspace_folder"))
		.toBe(CREATED_FOLDER_PATH);
});

test("the node folder browser shows loading/error, can be retried, validates typed paths, and selects", async ({
	page,
}) => {
	await openPage(page);
	await page.evaluate(() => {
		localStorage.setItem("proof:workspace-picker:hold-home-list-once", "true");
		localStorage.setItem(
			"proof:workspace-picker:fail-held-home-list-once",
			"true"
		);
	});
	let menu = await openPicker(page, "Project");
	await menu.menu
		.getByRole("option", { name: "New project", exact: true })
		.click();
	let dialog = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByRole("status", { exact: true, name: "Loading" })
	).toBeVisible();
	await page.evaluate(() =>
		window.__workspacePickerProof?.releaseHomeListing()
	);
	await expect(
		dialog.getByText("Fixture folder listing is temporarily unavailable.", {
			exact: true,
		})
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIR}desktop-workspace-picker-folder-browser-error.png`,
	});
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();

	menu = await openPicker(page, "Project");
	await menu.menu
		.getByRole("option", { name: "New project", exact: true })
		.click();
	dialog = page.getByRole("dialog", { name: "Add a project folder to Ryu" });
	await expect(dialog.getByText("Projects", { exact: true })).toBeVisible();
	const pathInput = dialog.getByPlaceholder(
		"Type a folder path, or pick one below…"
	);
	await pathInput.fill(`${HOME_PATH}/missing`);
	await expect(pathInput).toHaveAttribute("aria-invalid", "true");
	await pathInput.fill(ALPHA_PATH);
	await pathInput.press("Enter");
	await expect(pathInput).not.toHaveAttribute("aria-invalid", "true");
	await expect(pathInput).toHaveValue(ALPHA_PATH);
	const addFolder = dialog.getByRole("button", {
		name: "Add folder to Ryu",
	});
	await expect(addFolder).toBeEnabled();
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIR}desktop-workspace-picker-folder-browser-selected.png`,
	});
	await addFolder.click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Alpha project", exact: true })
	).toBeVisible();
	await expect
		.poll(() => storedValue(page, "ryu_workspace_folder"))
		.toBe(ALPHA_PATH);
	const validations = apiRequests(
		await requests(page),
		"GET",
		`/api/workspace/list?path=${encodeURIComponent(ALPHA_PATH)}`
	);
	expect(validations.length).toBeGreaterThan(0);
});

test("branch listing retries and checkout errors stay visible until a successful retry", async ({
	page,
}) => {
	await openPage(page, { folder: "alpha" });
	await expect(
		page.getByRole("button", { name: "main", exact: true })
	).toBeVisible();
	await page.evaluate(() => {
		localStorage.setItem("proof:workspace-picker:hold-branches-once", "true");
		localStorage.setItem(
			"proof:workspace-picker:fail-held-branches-once",
			"true"
		);
	});

	let branchMenu = await openPicker(page, "main");
	await expect(
		branchMenu.menu.getByRole("progressbar", {
			exact: true,
			name: "Loading branches",
		})
	).toBeVisible();
	await page.evaluate(() => window.__workspacePickerProof?.releaseBranches());
	await expect(
		branchMenu.menu.getByText("No branches found.", { exact: true })
	).toBeVisible();
	await branchMenu.menu.press("Escape");
	await expect(branchMenu.menu).toBeHidden();

	branchMenu = await openPicker(page, "main");
	await expect(
		branchMenu.menu.getByRole("option", { name: "main", exact: true })
	).toBeVisible();
	const showMore = branchMenu.menu.getByRole("option", {
		name: /^Show \d+ more branches$/,
	});
	await expect(showMore).toBeVisible();
	const search = branchMenu.menu.getByPlaceholder(
		"Search Alpha project branches"
	);
	await search.fill("topic/branch-60");
	await expect(
		branchMenu.menu.getByRole("option", {
			name: "topic/branch-60",
			exact: true,
		})
	).toBeVisible();
	await expect(showMore).toHaveCount(0);
	await search.fill("");
	await expect(showMore).toBeVisible();
	await showMore.click();
	await expect(
		branchMenu.menu.getByRole("option", {
			name: "topic/branch-60",
			exact: true,
		})
	).toBeVisible();
	await expect(
		branchMenu.menu.getByRole("option", { name: /^Show \d+ more branches$/ })
	).toHaveCount(0);
	await page.evaluate(() => {
		localStorage.setItem("proof:workspace-picker:fail-checkout-once", "true");
	});
	await branchMenu.menu
		.getByRole("option", { name: "release", exact: true })
		.click();
	await expect(branchMenu.menu.getByRole("alert")).toContainText(
		"Fixture refused this checkout."
	);
	await expect(branchMenu.menu).toBeVisible();
	// The modal dialog makes the trigger inert, so match it by its title.
	await expect(page.getByTitle("Branch: main", { exact: true })).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIR}desktop-workspace-picker-branch-error.png`,
	});
	await branchMenu.menu
		.getByRole("option", { name: "release", exact: true })
		.click();
	await expect(branchMenu.menu).toBeHidden();
	await expect(
		page.getByRole("button", { name: "release", exact: true })
	).toBeVisible();
	const checkouts = apiRequests(
		await requests(page),
		"POST",
		"/api/git/checkout"
	);
	expect(checkouts.map((request) => request.body)).toEqual([
		{ cwd: ALPHA_PATH, branch: "release" },
		{ cwd: ALPHA_PATH, branch: "release" },
	]);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "release", exact: true })
	).toBeVisible();
});

test("environment selection, terminal action, and run-mode settings persist", async ({
	page,
}) => {
	await openPage(page, { folder: "alpha" });
	await expect(
		page.getByRole("button", { name: "Build profile", exact: true })
	).toBeVisible();
	const environments = await openMenu(page, "Build profile");
	await environments.menu
		.getByRole("menuitem", { name: "Test profile", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Test profile", exact: true })
	).toBeVisible();
	await expect
		.poll(async () => {
			const raw = await storedValue(
				page,
				"ryu_workspace_active_environments_v1"
			);
			return raw ? decodeWorkspaceEnvironments(raw)[ALPHA_PATH] : null;
		})
		.toBe("fixture-test");

	await page
		.getByRole("button", { name: "Run fixture tests", exact: true })
		.click();
	await expect(page.getByTestId("terminal-request")).not.toHaveText(
		"No terminal request"
	);
	const terminalRequest = decodeWorkspaceTerminalRequest(
		(await page.getByTestId("terminal-request").textContent()) ?? "{}"
	);
	expect(terminalRequest).toMatchObject({
		kind: "terminal",
		label: "Terminal",
		side: "bottom",
		command: {
			command: "printf fixture-tests",
			cwd: ALPHA_PATH,
			env: {
				FIXTURE_SUITE: "local-only",
				RYU_PROJECT_PATH: ALPHA_PATH,
				RYU_WORKTREE_PATH: ALPHA_PATH,
			},
			shell: null,
		},
	});

	const localMode = await openPicker(page, "Local");
	await localMode.menu
		.getByRole("option", { name: "New worktree", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "New worktree", exact: true })
	).toBeVisible();
	const worktreeMode = await openPicker(page, "New worktree");
	const branchName = worktreeMode.menu.getByPlaceholder("ryu/my-feature");
	await branchName.fill("ryu/workspace-picker-proof");
	await expect
		.poll(() => storedValue(page, "ryu_workspace_worktree_branch"))
		.toBe("ryu/workspace-picker-proof");
	await branchName.press("Enter");
	await expect(worktreeMode.menu).toBeVisible();
	await worktreeMode.menu
		.getByRole("button", { name: "Suggest a new branch name" })
		.click();
	await expect
		.poll(async () => storedValue(page, "ryu_workspace_worktree_branch"))
		.not.toBe("ryu/workspace-picker-proof");
	await expect
		.poll(async () =>
			(await storedValue(page, "ryu_workspace_worktree_branch"))?.startsWith(
				"ryu/"
			)
		)
		.toBe(true);
	await worktreeMode.menu
		.getByRole("option", { name: "Local", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Local", exact: true })
	).toBeVisible();
	await expect
		.poll(() => storedValue(page, "ryu_workspace_worktree_mode"))
		.toBe("false");

	await page.reload();
	await expect(
		page.getByRole("button", { name: "Test profile", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Local", exact: true })
	).toBeVisible();
});

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
