import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { z } from "zod";

const STORY_URL = "/project-picker-proof.html";
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

const REQUESTS_KEY = "proof:project-picker:requests";

interface FixtureRequest {
	body: unknown;
	hasAuthorization: boolean;
	method: string;
	origin: string;
	path: string;
	status: number;
}

declare global {
	interface Window {
		__projectPickerProof?: { requests: () => FixtureRequest[] };
	}
}

test.describe.configure({ timeout: 90_000 });

const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	browserErrors.set(page, errors);
});

test.afterEach(({ page }) => {
	expect(browserErrors.get(page) ?? []).toEqual([]);
});

async function openPage(
	page: Page,
	options: { active?: "alpha"; empty?: boolean; remote?: boolean } = {}
) {
	const query = new URLSearchParams({ reset: "1" });
	if (options.active) {
		query.set("active", options.active);
	}
	if (options.empty) {
		query.set("empty", "1");
	}
	if (options.remote) {
		query.set("node", "remote");
	}
	await page.setViewportSize({ height: 900, width: 1440 });
	await page.goto(`${STORY_URL}?${query.toString()}`);
	await expect(page).toHaveURL(/project-picker-proof\.html/);
	await expect(page).toHaveTitle("Project picker proof");
	await expect(page.getByTestId("project-picker-proof")).toBeVisible();
	await expect(
		page.getByRole("dialog", { name: "Choose a project to edit" })
	).toBeVisible();
}

async function openProjectMenu(page: Page) {
	const trigger = page.getByRole("button", {
		name: "Select project folder",
	});
	await trigger.click();
	const menu = page.getByRole("dialog", {
		name: "Choose a project",
		exact: true,
	});
	await expect(menu).toBeVisible();
	return { menu, trigger };
}

async function requests(page: Page): Promise<FixtureRequest[]> {
	const raw = await page.evaluate(
		(key) => localStorage.getItem(key),
		REQUESTS_KEY
	);
	return z
		.array(
			z.object({
				body: z.json(),
				hasAuthorization: z.boolean(),
				method: z.string(),
				origin: z.string(),
				path: z.string(),
				status: z.number(),
			})
		)
		.parse(raw ? JSON.parse(raw) : []);
}

async function storedValue(page: Page, key: string): Promise<string | null> {
	return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

function apiRequests(
	items: FixtureRequest[],
	method: string,
	path: string
): FixtureRequest[] {
	return items.filter((item) => item.method === method && item.path === path);
}

async function capture(page: Page, testInfo: TestInfo, filename: string) {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	const screenshot = await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: `${EVIDENCE_DIR}${filename}`,
	});
	await testInfo.attach(filename, {
		body: screenshot,
		contentType: "image/png",
	});
}

test("ChatPage workspace prompt searches, handles denied selection, and persists the exact retry", async ({
	page,
}, testInfo) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openPage(page);
	const { menu, trigger } = await openProjectMenu(page);
	const search = menu.getByPlaceholder("Search projects");
	await expect(search).toBeVisible();

	// The search box keeps focus while arrow keys move the highlighted row.
	await expect(search).toBeFocused();
	await search.press("ArrowDown");
	await expect(search).toBeFocused();
	await expect(menu.getByRole("option", { selected: true })).toHaveCount(1);
	await expect(page.getByTestId("selected-folder")).toHaveText(
		"No project selected"
	);
	await search.press("Escape");
	await expect(menu).toBeHidden();
	await expect(trigger).toBeFocused();
	await expect(
		page.getByRole("dialog", { name: "Choose a project to edit" })
	).toBeVisible();

	const reopened = await openProjectMenu(page);
	const searchAgain = reopened.menu.getByPlaceholder("Search projects");
	await searchAgain.fill("BETA/PACKAGES/CLIENT");
	await expect(
		reopened.menu.getByRole("option", { name: "Open Beta project" })
	).toBeVisible();
	await expect(
		reopened.menu.getByRole("option", { name: "Open Alpha project" })
	).toHaveCount(0);
	await searchAgain.fill("missing workspace");
	await expect(
		reopened.menu.getByText("No matching projects.", { exact: true })
	).toBeVisible();
	await searchAgain.fill("beta");

	await page.evaluate(() => {
		localStorage.setItem("proof:project-picker:fail-beta-list-once", "true");
	});
	const betaRow = reopened.menu.getByRole("option", {
		name: "Open Beta project",
	});
	await betaRow.click();
	await expect(reopened.menu).toBeVisible();
	await expect(reopened.menu.getByRole("alert")).toHaveText(
		"Could not open this project. Check folder access and try again."
	);
	await expect(page.getByTestId("active-folder")).toHaveText(
		"No active project"
	);
	await expect(page.getByTestId("selected-folder")).toHaveText(
		"No project selected"
	);
	await expect.poll(() => storedValue(page, "ryu_workspace_folder")).toBeNull();

	await betaRow.click();
	await expect(reopened.menu).toBeHidden();
	await expect(page.getByTestId("active-folder")).toHaveText(BETA_PATH);
	await expect(page.getByTestId("selected-folder")).toHaveText(BETA_PATH);
	await expect
		.poll(() => storedValue(page, "ryu_workspace_folder"))
		.toBe(BETA_PATH);
	await expect
		.poll(async () => {
			const raw = await storedValue(page, "ryu_workspace_recents");
			return raw ? JSON.parse(raw)[0] : null;
		})
		.toBe(BETA_PATH);
	const failedSelections = apiRequests(
		await requests(page),
		"GET",
		`/api/workspace/list?path=${encodeURIComponent(BETA_PATH)}`
	);
	expect(failedSelections.map((request) => request.status)).toEqual([403, 200]);
	await capture(page, testInfo, "desktop-project-picker-selected-project.png");

	await page.reload();
	await expect(page.getByTestId("active-folder")).toHaveText(BETA_PATH);
	await expect(
		page.getByRole("dialog", { name: "Choose a project to edit" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Select project folder" })
	).toContainText("Beta project");
	await expect(pageErrors).toEqual([]);
});

test("an empty project list still exposes create, browse, and clone actions", async ({
	page,
}) => {
	await openPage(page, { empty: true });
	const { menu } = await openProjectMenu(page);
	await expect(menu.getByPlaceholder("Search projects")).toHaveCount(0);
	await expect(
		menu.getByText("No matching projects.", { exact: true })
	).toHaveCount(0);
	await expect(menu.getByRole("option", { name: "New project" })).toBeVisible();
	await expect(
		menu.getByRole("option", { name: "Clone from Git" })
	).toBeVisible();
	await expect(
		menu.getByRole("option", { name: "Start from scratch" })
	).toBeVisible();
	await expect(
		menu.getByRole("option", { name: "Do not work in a project" })
	).toHaveCount(0);
});

test("clearing keeps the project recent, while removing it persists the removal", async ({
	page,
}) => {
	await openPage(page, { active: "alpha" });
	let { menu } = await openProjectMenu(page);
	await menu
		.getByRole("option", {
			name: "Do not work in a project",
			exact: true,
		})
		.click();
	await expect(menu).toBeHidden();
	await expect.poll(() => storedValue(page, "ryu_workspace_folder")).toBeNull();
	await expect
		.poll(async () => {
			const raw = await storedValue(page, "ryu_workspace_recents");
			return raw ? JSON.parse(raw).includes(ALPHA_PATH) : false;
		})
		.toBe(true);

	await page.reload();
	({ menu } = await openProjectMenu(page));
	const alphaRow = menu.getByRole("option", { name: "Open Alpha project" });
	await alphaRow.hover();
	// The remove glyph is a pointer-only hit area hidden from assistive tech and
	// holds no focusable content; the option is the row's single interactive
	// element.
	const removeHitArea = alphaRow.locator("[data-remove-project]");
	await expect(removeHitArea).toHaveAttribute("aria-hidden", "true");
	await expect(
		alphaRow.locator("button, a[href], input, select, textarea, [tabindex]")
	).toHaveCount(0);
	await removeHitArea.click();
	await expect(
		menu.getByRole("option", { name: "Open Alpha project" })
	).toHaveCount(0);
	const removed = await storedValue(page, "ryu_workspace_removed");
	expect(removed ? JSON.parse(removed) : []).toContain(ALPHA_PATH);
	const projects = await storedValue(page, "ryu_workspace_projects_v1");
	expect(projects).not.toContain("Alpha project");
	await page.reload();
	({ menu } = await openProjectMenu(page));
	await expect(
		menu.getByRole("option", { name: "Open Alpha project" })
	).toHaveCount(0);
});

test("Delete removes the highlighted project from the keyboard without editing the search", async ({
	page,
}) => {
	await openPage(page);
	let { menu } = await openProjectMenu(page);
	const search = menu.getByPlaceholder("Search projects");
	await expect(search).toBeFocused();
	await search.fill("beta");
	const betaRow = menu.getByRole("option", { name: "Open Beta project" });
	await expect(betaRow).toHaveAttribute(
		"aria-keyshortcuts",
		"Delete Meta+Backspace"
	);

	// With the caret inside the query, Delete edits the text and keeps the row.
	// cmdk owns Home/End for list navigation, so place the caret directly.
	await search.evaluate((input: HTMLInputElement) =>
		input.setSelectionRange(0, 0)
	);
	await search.press("Delete");
	await expect(search).toHaveValue("eta");
	await expect(betaRow).toBeVisible();
	await search.fill("beta");

	await expect(betaRow).toHaveAttribute("aria-selected", "true");
	await search.press("Delete");
	await expect(
		menu.getByRole("option", { name: "Open Beta project" })
	).toHaveCount(0);
	await expect(search).toHaveValue("beta");
	await expect(search).toBeFocused();
	const removed = await storedValue(page, "ryu_workspace_removed");
	expect(removed ? JSON.parse(removed) : []).toContain(BETA_PATH);

	await page.reload();
	({ menu } = await openProjectMenu(page));
	await expect(
		menu.getByRole("option", { name: "Open Beta project" })
	).toHaveCount(0);
	await expect(
		menu.getByRole("option", { name: "Open Alpha project" })
	).toBeVisible();
});

test("Meta+Backspace removes the highlighted project for keyboards without forward Delete", async ({
	page,
}) => {
	await openPage(page);
	const { menu } = await openProjectMenu(page);
	const search = menu.getByPlaceholder("Search projects");
	await search.fill("alpha");
	const alphaRow = menu.getByRole("option", { name: "Open Alpha project" });
	await expect(alphaRow).toHaveAttribute("aria-selected", "true");

	// Plain Backspace still edits the query and keeps the row.
	await search.press("Backspace");
	await expect(search).toHaveValue("alph");
	await expect(alphaRow).toBeVisible();

	// Meta+Backspace (Command+Delete on a Mac) removes it wherever the caret is.
	await search.evaluate((input: HTMLInputElement) =>
		input.setSelectionRange(1, 1)
	);
	await search.press("Meta+Backspace");
	await expect(
		menu.getByRole("option", { name: "Open Alpha project" })
	).toHaveCount(0);
	await expect(search).toHaveValue("alph");
	await expect(search).toBeFocused();
	const removed = await storedValue(page, "ryu_workspace_removed");
	expect(removed ? JSON.parse(removed) : []).toContain(ALPHA_PATH);
});

test("Start from scratch keeps permission errors editable and retries the exact name", async ({
	page,
}, testInfo) => {
	await openPage(page, { empty: true });
	let { menu } = await openProjectMenu(page);
	await menu.getByRole("option", { name: "Start from scratch" }).click();
	let dialog = page.getByRole("dialog", { name: "Start from scratch" });
	await expect(dialog).toBeVisible();
	const firstInput = dialog.getByPlaceholder("New project name");
	await expect(firstInput).toBeFocused();
	await expect(
		dialog.getByRole("button", { name: "Create project", exact: true })
	).toBeDisabled();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(
		apiRequests(await requests(page), "POST", "/api/workspace/new-folder")
	).toHaveLength(0);

	({ menu } = await openProjectMenu(page));
	await menu.getByRole("option", { name: "Start from scratch" }).click();
	dialog = page.getByRole("dialog", { name: "Start from scratch" });
	await page.evaluate(() => {
		localStorage.setItem("proof:project-picker:fail-create-once", "true");
	});
	const input = dialog.getByPlaceholder("New project name");
	await input.fill("Fresh Project");
	await input.press("Enter");
	await expect(dialog.getByRole("alert")).toHaveText(
		"The active node does not permit project creation."
	);
	await expect(input).toHaveValue("Fresh Project");
	await capture(
		page,
		testInfo,
		"desktop-project-picker-create-permission-error.png"
	);

	await dialog
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(dialog).toBeHidden();
	const createdPath = `${HOME_PATH}/Documents/Ryu/Fresh Project`;
	await expect(page.getByTestId("selected-folder")).toHaveText(createdPath);
	await expect
		.poll(() => storedValue(page, "ryu_workspace_folder"))
		.toBe(createdPath);
	const creates = apiRequests(
		await requests(page),
		"POST",
		"/api/workspace/new-folder"
	);
	expect(creates.map((request) => request.body)).toEqual([
		{ name: "Fresh Project" },
		{ name: "Fresh Project" },
	]);
	await expect
		.poll(
			async () =>
				apiRequests(
					await requests(page),
					"GET",
					`/api/workspace/list?path=${encodeURIComponent(createdPath)}`
				).length
		)
		.toBeGreaterThan(0);
});

test("a created folder that cannot open retries activation without creating it twice", async ({
	page,
}) => {
	await openPage(page, { empty: true });
	const { menu } = await openProjectMenu(page);
	await menu.getByRole("option", { name: "Start from scratch" }).click();
	const dialog = page.getByRole("dialog", { name: "Start from scratch" });
	await page.evaluate(() => {
		localStorage.setItem(
			"proof:project-picker:fail-created-folder-once",
			"true"
		);
	});
	await dialog.getByPlaceholder("New project name").fill("Activation Retry");
	await dialog.getByRole("button", { name: "Create project" }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Created the folder, but could not open it. Try again to retry."
	);
	await expect(dialog.getByPlaceholder("New project name")).toBeDisabled();
	const retry = dialog.getByRole("button", {
		name: "Try opening project",
		exact: true,
	});
	await expect(retry).toBeEnabled();
	await retry.click();
	await expect(dialog).toBeHidden();
	const createdPath = `${HOME_PATH}/Documents/Ryu/Activation Retry`;
	await expect(page.getByTestId("selected-folder")).toHaveText(createdPath);
	expect(
		apiRequests(await requests(page), "POST", "/api/workspace/new-folder")
	).toHaveLength(1);
	const validationRequests = apiRequests(
		await requests(page),
		"GET",
		`/api/workspace/list?path=${encodeURIComponent(createdPath)}`
	);
	expect(validationRequests.map((request) => request.status)).toEqual([
		403, 200,
	]);
});

test("the node folder browser surfaces permission denial, reopens, and selects a canonical path", async ({
	page,
}, testInfo) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openPage(page);
	await page.evaluate(() => {
		localStorage.setItem("proof:project-picker:fail-home-list-once", "true");
	});
	let { menu } = await openProjectMenu(page);
	await menu.getByRole("option", { name: "New project" }).click();
	let browser = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	await expect(browser).toBeVisible();
	await expect(
		browser.getByText("The active node denied access to its home folder.", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		browser.getByRole("button", { name: "Add folder to Ryu" })
	).toBeDisabled();
	await capture(
		page,
		testInfo,
		"desktop-project-picker-folder-permission-error.png"
	);
	await browser.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(browser).toBeHidden();

	({ menu } = await openProjectMenu(page));
	await menu.getByRole("option", { name: "New project" }).click();
	browser = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	await expect(browser.getByText("Projects", { exact: true })).toBeVisible();
	await browser.getByText("Projects", { exact: true }).click();
	await expect(browser.getByText("alpha", { exact: true })).toBeVisible();
	await browser.getByText("alpha", { exact: true }).click();
	const pathInput = browser.getByPlaceholder(
		"Type a folder path, or pick one below…"
	);
	await expect(pathInput).toHaveValue(ALPHA_PATH);
	await expect(
		browser.getByRole("button", { name: "Add folder to Ryu" })
	).toBeEnabled();
	await browser.getByRole("button", { name: "Add folder to Ryu" }).click();
	await expect(browser).toBeHidden();
	await expect(page.getByTestId("selected-folder")).toHaveText(ALPHA_PATH);
	await expect
		.poll(() => storedValue(page, "ryu_workspace_folder"))
		.toBe(ALPHA_PATH);
	await expect(pageErrors).toEqual([]);
});

test("Git clone preserves manual names, shows node permission errors, and retries on the selected node", async ({
	page,
}, testInfo) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openPage(page, { empty: true, remote: true });
	let { menu } = await openProjectMenu(page);
	await menu.getByRole("option", { name: "Clone from Git" }).click();
	let dialog = page.getByRole("dialog", { name: "Clone Git repository" });
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByText('onto the "Sandbox Cloud" node', { exact: false })
	).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(
		apiRequests(await requests(page), "POST", "/api/workspace/clone")
	).toHaveLength(0);

	({ menu } = await openProjectMenu(page));
	await menu.getByRole("option", { name: "Clone from Git" }).click();
	dialog = page.getByRole("dialog", { name: "Clone Git repository" });
	const repositoryUrl = dialog.getByLabel("Repository URL");
	const folderName = dialog.getByLabel("Folder name");
	await repositoryUrl.fill("https://gitlab.com/group/subgroup/service.git");
	await expect(folderName).toHaveValue("service");
	await folderName.fill("custom-service");
	await repositoryUrl.fill("git@git.example.test:team/other-repo.git");
	await expect(folderName).toHaveValue("custom-service");
	await page.evaluate(() => {
		localStorage.setItem("proof:project-picker:fail-clone-once", "true");
	});
	await dialog.getByRole("button", { name: "Clone repository" }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"The active node denied Git clone access."
	);
	await expect(repositoryUrl).toHaveValue(
		"git@git.example.test:team/other-repo.git"
	);
	await capture(
		page,
		testInfo,
		"desktop-project-picker-clone-permission-error.png"
	);

	await dialog.getByRole("button", { name: "Clone repository" }).click();
	await expect(dialog).toBeHidden();
	const clonedPath = `${HOME_PATH}/Documents/Ryu/custom-service`;
	await expect(page.getByTestId("selected-folder")).toHaveText(clonedPath);
	await expect
		.poll(() => storedValue(page, "ryu_workspace_folder"))
		.toBe(clonedPath);
	const clones = apiRequests(
		await requests(page),
		"POST",
		"/api/workspace/clone"
	);
	expect(clones.map((request) => request.body)).toEqual([
		{
			name: "custom-service",
			url: "git@git.example.test:team/other-repo.git",
		},
		{
			name: "custom-service",
			url: "git@git.example.test:team/other-repo.git",
		},
	]);
	expect(clones.map((request) => request.origin)).toEqual([
		"http://sandbox-project-picker.example.test:7980",
		"http://sandbox-project-picker.example.test:7980",
	]);
	expect(clones.every((request) => request.hasAuthorization)).toBe(true);
	await capture(page, testInfo, "desktop-project-picker-cloned-project.png");
	await page.reload();
	await expect(page.getByTestId("active-folder")).toHaveText(clonedPath);
	await expect(
		page.getByRole("button", { name: "Select project folder" })
	).toContainText("custom-service");
	await expect(pageErrors).toEqual([]);
});
