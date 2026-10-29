import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ProjectEnvironment } from "../src/store/useWorkspaceStore.ts";
import type { ProjectSettingsProofSnapshot } from "./harness/project-settings-proof.mock.ts";

const PROJECT_PATH = "/fixture/projects/project-settings";
const SECONDARY_PATH = "/fixture/projects/shared";
const ADDED_PATH = "/fixture/projects/added-source";
const CLONED_PATH = "/fixture/cloned/fixture-repo";
const ORIGINAL_NAME = "Project Settings Fixture";
const ORIGINAL_INSTRUCTIONS = "Keep project settings in the local fixture.\n";

interface ProjectSettingsWindow extends Window {
	__PROJECT_SETTINGS_PROOF__: NonNullable<Window["__PROJECT_SETTINGS_PROOF__"]>;
	__READ_PROJECT_SETTINGS_STORE__: () => {
		activeProjectEnvironments: Record<string, string>;
		projectEnvironments: Record<string, ProjectEnvironment[]>;
		projectNames: Record<string, string>;
		projects: { folders: string[]; id: string; name?: string }[];
		recentFolders: string[];
		removedProjects: string[];
	};
}

const evidence = (name: string) =>
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence",
		name
	);

async function openProjectSettings(
	page: Page,
	path = PROJECT_PATH,
	url = "/project-settings-proof.html?reset=true"
) {
	await page.goto(url);
	await expect(
		page.getByRole("heading", { name: "Project environments", exact: true })
	).toBeVisible();
	await page.locator("button").filter({ hasText: path }).first().click();
	const dialog = page.getByRole("dialog").first();
	await expect(
		dialog.getByRole("heading", { name: "Edit project" })
	).toBeVisible();
	return dialog;
}

async function readFixture(page: Page): Promise<ProjectSettingsProofSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: project-settings-proof.mock.ts installs __PROJECT_SETTINGS_PROOF__ before this proof page is evaluated. */ (
			window as ProjectSettingsWindow
		).__PROJECT_SETTINGS_PROOF__.snapshot()
	);
}

async function readWorkspace(page: Page) {
	return await page.evaluate(() =>
		/* SAFETY: project-settings-proof.tsx installs __READ_PROJECT_SETTINGS_STORE__ before this proof page is evaluated. */ (
			window as ProjectSettingsWindow
		).__READ_PROJECT_SETTINGS_STORE__()
	);
}

test.describe.configure({ timeout: 90_000 });

test("validates, cancels, saves and reloads project name/instructions with file-write recovery and managed mapping", async ({
	page,
}) => {
	let settings = await openProjectSettings(page);
	const name = settings.getByLabel("Name", { exact: true });
	const instructions = settings.locator(
		"#project-settings-instructions [data-slate-editor='true']"
	);
	const initialFixture = await readFixture(page);
	expect(initialFixture.files).toEqual({
		[`${PROJECT_PATH}/AGENTS.md`]: ORIGINAL_INSTRUCTIONS,
	});
	expect(initialFixture.fileReads).toContain(`${PROJECT_PATH}/AGENTS.md`);
	await expect(name).toHaveValue(ORIGINAL_NAME);
	await expect(instructions).toHaveText(ORIGINAL_INSTRUCTIONS.trim());

	await name.fill("Discarded name");
	await instructions.fill("Discarded project instructions.");
	await settings.getByRole("button", { name: "Close" }).click();
	await expect(settings).toBeHidden();
	let fixture = await readFixture(page);
	expect(fixture.fileWrites).toEqual([]);
	let workspace = await readWorkspace(page);
	expect(workspace.projects[0]?.name).toBe(ORIGINAL_NAME);

	settings = await openProjectSettings(
		page,
		PROJECT_PATH,
		"/project-settings-proof.html"
	);
	await expect(settings.getByLabel("Name", { exact: true })).toHaveValue(
		ORIGINAL_NAME
	);
	const savedEditor = settings.locator(
		"#project-settings-instructions [data-slate-editor='true']"
	);
	await expect(savedEditor).toHaveText(ORIGINAL_INSTRUCTIONS.trim());

	const nameInput = settings.getByLabel("Name", { exact: true });
	const save = settings.getByRole("button", { name: "Save", exact: true });
	await nameInput.fill("   ");
	await expect(save).toBeDisabled();
	await nameInput.fill(" Project Atlas ");
	await nameInput.press("Enter");
	await expect(settings).toBeVisible();
	fixture = await readFixture(page);
	expect(fixture.fileWrites).toEqual([]);

	await savedEditor.fill(
		"Use the fixture-backed API and keep paths on this node."
	);
	await settings.getByLabel("Organization ID").fill("org-fixture");
	await save.click();
	await expect(
		page.getByText(
			"Organization ID and project ID are both required for a mapping"
		)
	).toBeVisible();
	fixture = await readFixture(page);
	expect(fixture.fileWrites).toEqual([]);
	expect(
		fixture.apiCalls.filter(
			(call) =>
				call.path === "/api/org-project-mappings" && call.method === "PUT"
		)
	).toEqual([]);

	await settings.getByLabel("Project ID").fill("project-fixture");
	await page.evaluate(() =>
		/* SAFETY: project-settings-proof.mock.ts installs __PROJECT_SETTINGS_PROOF__ before this proof page is evaluated. */ (
			window as ProjectSettingsWindow
		).__PROJECT_SETTINGS_PROOF__.armFileWriteFailure()
	);
	await save.click();
	await expect(settings.getByRole("alert")).toContainText(
		"Check that the project folder and node are writable"
	);
	await expect(nameInput).toHaveValue(" Project Atlas ");
	await expect(savedEditor).toHaveText(
		"Use the fixture-backed API and keep paths on this node."
	);
	await expect(save).toBeEnabled();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-project-settings-save-retry.png"),
	});

	await save.click();
	await expect(settings).toBeHidden();
	fixture = await readFixture(page);
	expect(fixture.fileWrites).toEqual([
		{
			content: "Use the fixture-backed API and keep paths on this node.\n",
			path: `${PROJECT_PATH}/AGENTS.md`,
			status: "failed",
		},
		{
			content: "Use the fixture-backed API and keep paths on this node.\n",
			path: `${PROJECT_PATH}/AGENTS.md`,
			status: "saved",
		},
	]);
	expect(
		fixture.apiCalls
			.filter(
				(call) =>
					call.path === "/api/org-project-mappings" && call.method === "PUT"
			)
			.map((call) => ({ body: call.body, status: call.status }))
	).toEqual([
		{
			body: {
				organizationId: "org-fixture",
				projectId: "project-fixture",
				root: PROJECT_PATH,
			},
			status: 200,
		},
	]);
	workspace = await readWorkspace(page);
	expect(workspace.projects[0]?.name).toBe("Project Atlas");
	expect(workspace.projectNames[PROJECT_PATH]).toBe("Project Atlas");
	expect(fixture.mappings).toEqual([
		{
			organizationId: "org-fixture",
			projectId: "project-fixture",
			root: PROJECT_PATH,
		},
	]);

	await page.reload();
	settings = await openProjectSettings(
		page,
		PROJECT_PATH,
		"/project-settings-proof.html"
	);
	await expect(settings.getByLabel("Name", { exact: true })).toHaveValue(
		"Project Atlas"
	);
	await expect(
		settings.locator(
			"#project-settings-instructions [data-slate-editor='true']"
		)
	).toHaveText("Use the fixture-backed API and keep paths on this node.");
	await expect(settings.getByLabel("Organization ID")).toHaveValue(
		"org-fixture"
	);
	await expect(settings.getByLabel("Project ID")).toHaveValue(
		"project-fixture"
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-project-settings-saved.png"),
	});
	await settings.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(settings).toBeHidden();
	expect((await readFixture(page)).fileWrites).toHaveLength(0);
});

test("manages source folders with node-browser and clone fixtures and persists the new primary order", async ({
	page,
}) => {
	const settings = await openProjectSettings(page);
	const sourceRows = settings.locator("[data-project-source-folder]");
	await expect(sourceRows).toHaveCount(2);
	await settings
		.getByRole("button", { name: `Remove ${SECONDARY_PATH}` })
		.click();
	await expect(sourceRows).toHaveCount(1);
	await settings
		.getByRole("button", { name: `Remove ${PROJECT_PATH}` })
		.click();
	await expect(sourceRows).toHaveCount(0);
	const emptyFolders = settings.getByRole("button", {
		name: "Add folders agents can read and edit",
	});
	await expect(emptyFolders).toBeVisible();
	await emptyFolders.click();
	let folderPicker = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	await expect(folderPicker).toBeVisible();
	await expect(
		folderPicker.getByRole("button", { name: "Add folder to Ryu" })
	).toBeDisabled();
	await folderPicker
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(folderPicker).toBeHidden();
	await expect(sourceRows).toHaveCount(0);

	await settings
		.getByRole("button", { name: "Add folder", exact: true })
		.click();
	folderPicker = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	const pathInput = folderPicker.getByPlaceholder(
		"Type a folder path, or pick one below…"
	);
	await pathInput.fill(ADDED_PATH);
	const addFolder = folderPicker.getByRole("button", {
		name: "Add folder to Ryu",
	});
	await expect(addFolder).toBeEnabled();
	await addFolder.click();
	await expect(folderPicker).toBeHidden();
	await expect(sourceRows).toHaveCount(1);
	await expect(sourceRows.first()).toContainText(ADDED_PATH);

	await settings.getByRole("button", { name: "Clone from Git" }).click();
	const cloneDialog = page.getByRole("dialog", {
		name: "Clone Git repository",
	});
	await expect(
		cloneDialog.getByRole("heading", { name: "Clone Git repository" })
	).toBeVisible();
	const repositoryUrl = "https://gitlab.com/owner/fixture-repo.git";
	await cloneDialog.getByLabel("Repository URL").fill(repositoryUrl);
	await expect(cloneDialog.getByLabel("Folder name")).toHaveValue(
		"fixture-repo"
	);
	await page.evaluate(() =>
		/* SAFETY: project-settings-proof.mock.ts installs __PROJECT_SETTINGS_PROOF__ before this proof page is evaluated. */ (
			window as ProjectSettingsWindow
		).__PROJECT_SETTINGS_PROOF__.armCloneFailure()
	);
	await cloneDialog.getByRole("button", { name: "Clone repository" }).click();
	await expect(cloneDialog.getByRole("alert")).toHaveText(
		"Fixture clone denied"
	);
	await expect(cloneDialog.getByLabel("Repository URL")).toHaveValue(
		repositoryUrl
	);
	await cloneDialog.getByRole("button", { name: "Clone repository" }).click();
	await expect(cloneDialog).toBeHidden();
	await expect(sourceRows).toHaveCount(2);
	await expect(sourceRows.filter({ hasText: CLONED_PATH })).toBeVisible();
	await settings
		.getByRole("button", { name: `Make ${CLONED_PATH} primary` })
		.click();
	await expect(sourceRows.first()).toContainText(CLONED_PATH);
	await expect(sourceRows.first()).toContainText("Primary");

	const requests = await readFixture(page);
	expect(
		requests.apiCalls.filter((call) => call.path === "/api/workspace/clone")
	).toEqual([
		{
			body: { name: "fixture-repo", url: repositoryUrl },
			headers: expect.objectContaining({
				authorization: "Bearer project-settings-proof-token",
			}),
			method: "POST",
			path: "/api/workspace/clone",
			status: 403,
		},
		{
			body: { name: "fixture-repo", url: repositoryUrl },
			headers: expect.objectContaining({
				authorization: "Bearer project-settings-proof-token",
			}),
			method: "POST",
			path: "/api/workspace/clone",
			status: 200,
		},
	]);
	expect(
		requests.apiCalls.some(
			(call) =>
				call.path ===
					`/api/workspace/list?path=${encodeURIComponent(ADDED_PATH)}` &&
				call.method === "GET" &&
				call.status === 200
		)
	).toBe(true);

	await settings.getByRole("button", { name: "Save", exact: true }).click();
	await expect(settings).toBeHidden();
	let workspace = await readWorkspace(page);
	expect(workspace.projects[0]?.folders).toEqual([CLONED_PATH, ADDED_PATH]);

	await page.reload();
	const reloadedProject = page
		.locator("button")
		.filter({ hasText: CLONED_PATH })
		.first();
	await reloadedProject.click();
	const reloadedSettings = page.getByRole("dialog").first();
	const reloadedRows = reloadedSettings.locator("[data-project-source-folder]");
	await expect(reloadedRows).toHaveCount(2);
	await expect(reloadedRows.nth(0)).toContainText(CLONED_PATH);
	await expect(reloadedRows.nth(0)).toContainText("Primary");
	await expect(reloadedRows.nth(1)).toContainText(ADDED_PATH);
	await expect(
		reloadedSettings.locator(
			"#project-settings-instructions [data-slate-editor='true']"
		)
	).toBeVisible();
	workspace = await readWorkspace(page);
	expect(workspace.projects[0]?.folders).toEqual([CLONED_PATH, ADDED_PATH]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-project-settings-source-folders.png"),
	});
});

test("validates, edits, activates, deletes, and reloads local environment profiles", async ({
	page,
}) => {
	let settings = await openProjectSettings(page);
	await settings
		.getByRole("button", { name: "Add a local environment setup" })
		.click();
	await settings.getByLabel("Name", { exact: true }).last().fill("Disposable");
	await settings.getByRole("button", { name: "Add variable" }).click();
	await settings.getByLabel("Variable name").fill("REMOVE_ME");
	await settings.getByLabel("Variable value").fill("temporary");
	await settings.getByRole("button", { name: "Remove REMOVE_ME" }).click();
	await expect(settings.getByLabel("Variable name")).toHaveCount(0);
	await settings.getByRole("button", { name: "Add action" }).click();
	await settings.getByLabel("Action name").fill("Discard action");
	await settings.getByRole("button", { name: "Remove Discard action" }).click();
	await expect(settings.getByLabel("Action name")).toHaveCount(0);

	await settings.getByRole("button", { name: "Add environment" }).click();
	const secondName = settings.getByLabel("Name", { exact: true }).last();
	await secondName.fill("Linux tests");
	await settings.getByRole("button", { name: "Make active" }).click();
	await expect(
		settings.getByRole("button", { name: "Linux tests · Active" })
	).toBeVisible();
	await settings.getByRole("button", { name: "Disposable" }).click();
	await settings.getByRole("button", { name: "Delete Disposable" }).click();
	await expect(
		settings.getByRole("button", { name: "Disposable" })
	).toHaveCount(0);
	await settings.getByRole("button", { name: "Linux tests · Active" }).click();

	await settings.getByLabel("Name", { exact: true }).last().fill("Linux tests");
	await settings.getByRole("button", { name: "Add variable" }).click();
	await settings.getByLabel("Variable name").fill("PROJECT_MODE");
	await settings.getByLabel("Variable value").fill("fixture");
	await settings.getByRole("button", { name: "Add action" }).click();
	await settings.getByLabel("Action name").fill("Run integration tests");
	await settings.getByRole("button", { name: "linux", exact: true }).click();
	const linuxScript = settings.getByPlaceholder("Overrides Default on linux");
	await linuxScript.fill("bun run test:integration");
	await expect(linuxScript).toHaveValue("bun run test:integration");

	const save = settings.getByRole("button", { name: "Save", exact: true });
	await save.click();
	const saveResult = await readFixture(page);
	expect(saveResult.fileWrites).toEqual([
		{
			content: ORIGINAL_INSTRUCTIONS,
			path: `${PROJECT_PATH}/AGENTS.md`,
			status: "saved",
		},
	]);
	await expect(settings.getByRole("alert")).toHaveCount(0);
	await expect(settings).toBeHidden();
	let workspace = await readWorkspace(page);
	const profiles = workspace.projectEnvironments[PROJECT_PATH];
	expect(profiles).toHaveLength(1);
	expect(profiles?.[0]).toMatchObject({
		name: "Linux tests",
		variables: [{ key: "PROJECT_MODE", value: "fixture" }],
		actions: [
			{
				name: "Run integration tests",
				scripts: {
					default: "",
					linux: "bun run test:integration",
					macos: "",
					windows: "",
				},
			},
		],
	});
	const activeId = workspace.activeProjectEnvironments[PROJECT_PATH];
	expect(activeId).toBe(profiles?.[0]?.id);

	await page.reload();
	settings = await openProjectSettings(
		page,
		PROJECT_PATH,
		"/project-settings-proof.html"
	);
	await expect(
		settings.getByRole("button", { name: "Linux tests · Active" })
	).toBeVisible();
	await expect(settings.getByLabel("Variable name")).toHaveValue(
		"PROJECT_MODE"
	);
	await expect(settings.getByLabel("Variable value")).toHaveValue("fixture");
	await settings.getByRole("button", { name: "linux", exact: true }).click();
	await expect(
		settings.getByPlaceholder("Overrides Default on linux")
	).toHaveValue("bun run test:integration");
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-project-settings-environment-profile.png"),
	});

	await settings.getByRole("button", { name: "Remove local project" }).click();
	await expect(settings).toBeHidden();
	workspace = await readWorkspace(page);
	expect(workspace.projects).toHaveLength(0);
	expect(workspace.removedProjects).toContain(PROJECT_PATH);
	expect((await readFixture(page)).fileWrites).toEqual([]);
});

declare global {
	interface Window {
		__READ_PROJECT_SETTINGS_STORE__: ProjectSettingsWindow["__READ_PROJECT_SETTINGS_STORE__"];
	}
}
