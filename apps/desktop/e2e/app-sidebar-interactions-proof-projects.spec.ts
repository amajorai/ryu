import { expect, test } from "@playwright/test";
import { sidebarStringsSchema } from "./app-sidebar-interactions-proof.contracts.ts";
import {
	activeTabPath,
	chooseChatsMenuAction,
	fixtureFor,
	registerAppSidebarProofHooks,
	tabs,
} from "./app-sidebar-interactions-proof.fixture.ts";
import {
	EVIDENCE_DIRECTORY,
	PROJECT_PATH,
	STORY_URL,
} from "./app-sidebar-interactions-proof.fixture-data.ts";

registerAppSidebarProofHooks();

test("Projects scope actions change the active workspace, routes, dialogs, and removed-project persistence", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=projects,tabs&grouped=on&behavior=current&auth=off&active=off&mode=sections&seed=${Date.now()}`
	);
	const picker = page.getByRole("combobox").first();
	await expect(picker).toContainText("All projects");
	await picker.click();
	await page
		.getByRole("option", { name: "Project Alpha", exact: true })
		.click();
	await expect(picker).toContainText("Project Alpha");

	const scopeOptions = page.getByRole("button", {
		name: "Project Alpha options",
		exact: true,
	});
	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "Set as active project", exact: true })
		.click();
	await expect(page.getByTestId("workspace-state")).toHaveText(PROJECT_PATH);

	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "Open Git graph", exact: true })
		.click();
	await expect
		.poll(() => activeTabPath(page))
		.toBe(`/project/graph/${encodeURIComponent(PROJECT_PATH)}`);

	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "New chat in this folder", exact: true })
		.click();
	await expect(page.getByTestId("workspace-state")).toHaveText(PROJECT_PATH);
	await expect.poll(() => activeTabPath(page)).toBe("/chat");
	await expect
		.poll(async () => (await tabs(page)).tabs.length)
		.toBeGreaterThan(1);

	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "Edit project…", exact: true })
		.click();
	const settingsDialog = page.getByRole("dialog", { name: "Edit project" });
	await expect(settingsDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(settingsDialog).toBeHidden();

	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "Change icon…", exact: true })
		.click();
	const iconDialog = page.getByRole("dialog", { name: /Project icon/i });
	await expect(iconDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(iconDialog).toBeHidden();

	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "Remove from app", exact: true })
		.click();
	const removed = sidebarStringsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu_workspace_removed") ?? "[]")
		)
	);
	expect(removed).toContain(PROJECT_PATH);
	await page.reload();
	await expect(page.getByTestId("workspace-state")).toHaveText("(none)");
	// Since 306ce31b7f an empty Projects group collapses to its label: no
	// "No projects yet" row, and the header's "+" still imports a folder.
	const projectsSection = page.locator("#sidebar-sec-projects");
	await expect(
		projectsSection.getByRole("button", { name: /^Project Alpha/ })
	).toHaveCount(0);
	await expect(
		projectsSection.getByRole("button", { name: "Add project", exact: true })
	).toHaveCount(1);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-project-scope-actions.png`,
		animations: "disabled",
	});
});

test("Projects add menu opens node folder browsing and new/clone dialogs with stateful retry payloads", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=projects,tabs&grouped=off&behavior=current&auth=off&active=off&mode=sections&seed=${Date.now()}`
	);
	const addProject = page.getByRole("button", {
		name: "Add project",
		exact: true,
	});
	// "+" opens the "Choose a project" command dialog; its actions are options.
	await addProject.click();
	await page.getByRole("option", { name: "New project", exact: true }).click();
	const browserDialog = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	await expect(browserDialog).toBeVisible();
	await expect(
		browserDialog.getByText("Documents", { exact: true })
	).toBeVisible();
	await browserDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(browserDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "GET" && request.path === "/api/workspace/list"
		)
	).toBe(true);

	await addProject.click();
	await page
		.getByRole("option", { name: "Start from scratch", exact: true })
		.click();
	const createDialog = page.getByRole("dialog", { name: "Start from scratch" });
	await expect(createDialog).toBeVisible();
	fixtureFor(page).failFolderCreateOnce = true;
	await createDialog
		.getByPlaceholder("New project name")
		.fill("  Proof workspace  ");
	await createDialog
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(
		createDialog.getByText("Fixture project folder collision")
	).toBeVisible();
	await expect(createDialog.getByPlaceholder("New project name")).toHaveValue(
		"  Proof workspace  "
	);
	await createDialog
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(createDialog).toBeHidden();
	await expect(page.getByTestId("workspace-state")).toHaveText(
		"/Users/proof/Documents/Ryu/Proof workspace"
	);
	expect(
		fixtureFor(page)
			.requests.filter(
				(request) =>
					request.method === "POST" &&
					request.path === "/api/workspace/new-folder"
			)
			.map((request) => request.body)
	).toEqual([{ name: "Proof workspace" }, { name: "Proof workspace" }]);

	await page.getByRole("button", { name: "Add project", exact: true }).click();
	await page
		.getByRole("option", { name: "Clone from Git", exact: true })
		.click();
	const cloneDialog = page.getByRole("dialog", {
		name: "Clone Git repository",
	});
	await expect(cloneDialog).toBeVisible();
	fixtureFor(page).failFolderCloneOnce = true;
	await cloneDialog
		.getByLabel("Repository URL")
		.fill("  https://dev.azure.com/proof/platform/_git/clone-repo  ");
	await cloneDialog
		.getByRole("button", { name: "Clone repository", exact: true })
		.click();
	await expect(cloneDialog.getByText("Fixture clone failed")).toBeVisible();
	await expect(cloneDialog.getByLabel("Repository URL")).toHaveValue(
		"  https://dev.azure.com/proof/platform/_git/clone-repo  "
	);
	await cloneDialog
		.getByRole("button", { name: "Clone repository", exact: true })
		.click();
	await expect(cloneDialog).toBeHidden();
	await expect(page.getByTestId("workspace-state")).toHaveText(
		"/Users/proof/Documents/Ryu/clone-repo"
	);
	expect(
		fixtureFor(page)
			.requests.filter(
				(request) =>
					request.method === "POST" && request.path === "/api/workspace/clone"
			)
			.map((request) => request.body)
	).toEqual([
		{
			name: "clone-repo",
			url: "https://dev.azure.com/proof/platform/_git/clone-repo",
		},
		{
			name: "clone-repo",
			url: "https://dev.azure.com/proof/platform/_git/clone-repo",
		},
	]);
	await page.reload();
	await expect(page.getByTestId("workspace-state")).toHaveText(
		"/Users/proof/Documents/Ryu/clone-repo"
	);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-project-picker-retry.png`,
		animations: "disabled",
	});
});

test("Chats header actions open and cancel both import dialogs, create a real caller chat, and scope delete-all confirmation", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=chats,tabs&behavior=current&auth=off&mode=sections&seed=${Date.now()}`
	);
	await expect(page.getByRole("button", { name: /Proof chat/ })).toBeVisible();

	await chooseChatsMenuAction(page, "Import a past agent thread");
	const threadsDialog = page.getByRole("dialog", { name: "Import a thread" });
	await expect(threadsDialog).toBeVisible();
	await expect(
		threadsDialog.getByRole("button", { name: /Imported proof thread/ })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(threadsDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "GET" &&
				request.path === "/api/agents/agent-alpha/threads"
		)
	).toBe(true);

	await chooseChatsMenuAction(page, "Import a past agent thread");
	const importDialog = page.getByRole("dialog", { name: "Import a thread" });
	await expect(importDialog).toBeVisible();
	await importDialog
		.getByRole("button", { name: /Imported proof thread/ })
		.click();
	await expect(
		importDialog.getByRole("button", { name: "Import 1", exact: true })
	).toBeEnabled();
	await importDialog
		.getByRole("button", { name: "Import 1", exact: true })
		.click();
	await expect(importDialog).toBeHidden();
	expect(fixtureFor(page).requests).toContainEqual({
		body: { dry_run: false, thread_id: "native-thread-proof" },
		method: "POST",
		path: "/api/agents/agent-alpha/threads/import",
	});
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.find((tab) => tab.id === state.activeTabId)
				?.conversationId;
		})
		.toBe("conversation-imported-proof");

	await chooseChatsMenuAction(page, "Import agent setup from a folder");
	const setupDialog = page.getByRole("dialog", { name: "Import agent setup" });
	await expect(setupDialog).toBeVisible();
	await setupDialog.getByRole("button", { name: "Choose a folder…" }).click();
	const folderDialog = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	await expect(folderDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(folderDialog).toBeHidden();
	await expect(setupDialog).toBeVisible();
	await setupDialog
		.getByRole("button", { name: "Close", exact: true })
		.first()
		.click();
	await expect(setupDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "POST" && request.path === "/api/import/scan"
		)
	).toBe(false);

	await chooseChatsMenuAction(page, "Import agent setup from a folder");
	const setupImportDialog = page.getByRole("dialog", {
		name: "Import agent setup",
	});
	await expect(setupImportDialog).toBeVisible();
	await setupImportDialog
		.getByRole("button", { name: "Claude Code", exact: true })
		.click();
	await expect(
		setupImportDialog.getByRole("button", { name: /Proof instructions/ })
	).toBeVisible();
	await setupImportDialog
		.getByRole("button", { name: /Proof instructions/ })
		.click();
	await expect(
		setupImportDialog.getByRole("button", { name: "Import 1", exact: true })
	).toBeEnabled();
	await setupImportDialog
		.getByRole("button", { name: "Import 1", exact: true })
		.click();
	await expect(setupImportDialog.getByText("Imported 1")).toBeVisible();
	expect(fixtureFor(page).requests).toContainEqual({
		body: {
			items: [{ id: "proof-instructions", kind: "instructions" }],
			path: "/Users/proof/.claude",
		},
		method: "POST",
		path: "/api/import/run",
	});
	await expect(page.getByTestId("workspace-project-state")).toContainText(
		"/Users/proof/Imported instructions"
	);
	await setupImportDialog
		.getByRole("button", { name: "Close", exact: true })
		.first()
		.click();
	await expect(setupImportDialog).toBeHidden();
	await page.reload();
	await expect(page.getByTestId("workspace-project-state")).toContainText(
		"/Users/proof/Imported instructions"
	);

	const beforeNew = await tabs(page);
	await page
		.getByRole("button", { name: "New chat", exact: true })
		.last()
		.click();
	await expect
		.poll(async () => (await tabs(page)).tabs.length)
		.toBe(beforeNew.tabs.length + 1);
	const chatStateAfterNew = await page.getByTestId("chat-state").textContent();
	expect(chatStateAfterNew).toContain("sidebar-new-");
	await expect.poll(() => activeTabPath(page)).toBe("/chat");

	const chatsHeader = page
		.locator("#sidebar-sec-chats")
		.getByRole("button", { name: "Chats", exact: true });
	await chatsHeader.click({ button: "right", force: true });
	const deleteMenu = page
		.locator('[data-slot="context-menu-content"]:visible')
		.last();
	await expect(
		deleteMenu.getByRole("menuitem", { name: /Delete all chats/ })
	).toBeVisible();
	const deleteLabel = await deleteMenu
		.getByRole("menuitem", { name: /Delete all chats/ })
		.innerText();
	await deleteMenu.getByRole("menuitem", { name: /Delete all chats/ }).click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toBeVisible();
	const confirmationTitle = await confirmation
		.locator("[data-slot='alert-dialog-title']")
		.innerText();
	const countMatch = confirmationTitle.match(/Delete all (\d+) chats?/);
	expect(countMatch?.[1]).toBeTruthy();
	await confirmation
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(confirmation).toBeHidden();
	await expect(page.getByTestId("chat-state")).toContainText("chat-loose");

	await chatsHeader.click({ button: "right", force: true });
	const confirmMenu = page
		.locator('[data-slot="context-menu-content"]:visible')
		.last();
	await confirmMenu.getByRole("menuitem", { name: /Delete all chats/ }).click();
	const expectedDeleteCount = countMatch?.[1];
	if (!expectedDeleteCount) {
		throw new Error(
			`Could not read delete confirmation count from ${deleteLabel}`
		);
	}
	await page
		.getByRole("alertdialog")
		.getByRole("button", {
			name: `Delete ${expectedDeleteCount} chats`,
			exact: true,
		})
		.click();
	await expect(page.getByRole("alertdialog")).toBeHidden();
	const finalChats = await page.getByTestId("chat-state").textContent();
	expect(finalChats).not.toContain("chat-loose");
	expect(finalChats).not.toContain("chat-agent-alpha");
	expect(finalChats).not.toContain("chat-group-alpha");
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-chat-actions.png`,
		animations: "disabled",
	});
});
