import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const STORY_URL = "/app-sidebar-entity-rows-proof.html";
const PROJECT_PATH = "/workspace/project-alpha";
const SPACE_ID = "space-research";

async function openProof(
	page: Page,
	options: {
		failDelete?: boolean;
		failRename?: boolean;
		failSpaceIcon?: boolean;
		failProjectWrite?: boolean;
		failDocumentRead?: boolean;
	} = {}
) {
	await page.goto(STORY_URL);
	await page.evaluate(
		(fixture) => {
			localStorage.clear();
			for (const [key, value] of Object.entries(fixture)) {
				if (value) {
					localStorage.setItem(key, "true");
				}
			}
		},
		{
			"proof:fail-space-delete-once": options.failDelete,
			"proof:fail-space-rename-once": options.failRename,
			"proof:fail-space-icon-once": options.failSpaceIcon,
			"proof:fail-project-write-once": options.failProjectWrite,
			"proof:fail-document-read-once": options.failDocumentRead,
		}
	);
	await page.reload();
}

async function openSpaceMenu(page: Page, rowId = "space-row-research") {
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	const menu = page.locator('[data-slot="context-menu-content"]').last();
	if (await menu.isVisible().catch(() => false)) {
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
	}
	const row = page.getByTestId(rowId).locator('[role="button"]').first();
	await row.click({ button: "right", force: true });
	await expect(menu).toBeVisible();
	return menu;
}

async function openProjectMenu(page: Page, rowId = "project-row-alpha") {
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	const menu = page.locator('[data-slot="context-menu-content"]').last();
	if (await menu.isVisible().catch(() => false)) {
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
	}
	const header = page.getByTestId(rowId).getByRole("button").first();
	await header.click({ button: "right", force: true });
	await expect(menu).toBeVisible();
	return menu;
}

async function chooseFixtureIcon(page: Page) {
	const dialog = page.getByRole("dialog", { name: /icon/i });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("tab", { name: "Icon", exact: true }).click();
	const search = dialog.getByRole("textbox", { name: "Search icons" });
	await search.fill("folder");
	const icon = dialog.getByRole("button", {
		name: "lucide:folder",
		exact: true,
	});
	await expect(icon).toBeVisible();
	await icon.click();
	await dialog.getByRole("button", { name: "Use icon", exact: true }).click();
	await expect(dialog).toBeHidden();
}

test.describe("ProjectRow and SpaceSidebarRow", () => {
	test("space row lazily loads documents and routes the row, page, new-tab, native-window, and contributed actions", async ({
		page,
	}) => {
		await openProof(page);
		const row = page
			.getByTestId("space-row-research")
			.locator('[role="button"]')
			.first();
		await expect(page.getByTestId("document-reads")).toHaveText("{}");
		await row.click();
		await expect(page.getByText("Launch brief", { exact: true })).toBeVisible();
		await expect(page.getByTestId("document-reads")).toHaveText(
			JSON.stringify({ [SPACE_ID]: 1 })
		);

		await page
			.getByRole("button", { name: "Launch brief", exact: true })
			.click();
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"space-document","payload":{"forceNew":false,"path":"/spaces/space-research/doc/doc-brief"}'
		);
		await page
			.getByRole("button", { name: "Launch brief", exact: true })
			.click({
				button: "middle",
			});
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"space-document","payload":{"forceNew":true,"path":"/spaces/space-research/doc/doc-brief"}'
		);
		await page
			.getByRole("button", { name: "Launch brief", exact: true })
			.click({ button: "right", force: true });
		const documentMenu = page
			.locator('[data-slot="context-menu-content"]')
			.last();
		await documentMenu
			.getByRole("menuitem", { name: "Open in new window" })
			.click();
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"space-document-window","payload":{"path":"/spaces/space-research/doc/doc-brief"}'
		);

		let menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Open space page" }).click();
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"space-page","payload":{"forceNew":false,"path":"/spaces/space-research"}'
		);
		menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Open in new tab" }).click();
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"space-page","payload":{"forceNew":true,"path":"/spaces/space-research"}'
		);
		menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Open in new window" }).click();
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"space-window","payload":{"path":"/spaces/space-research","title":"Research notes"}'
		);
		menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Review this space" }).click();
		await expect(page.locator("html")).toHaveAttribute(
			"data-space-host-invocation",
			JSON.stringify({
				args: { source: "sidebar", space_id: SPACE_ID },
				method: "space.review",
				plugin: "@ryu/spaces",
			})
		);
		await page.screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-sidebar-space-rows.png"
			),
			fullPage: true,
			animations: "disabled",
		});
	});

	test("space row add does not expand, while rename cancel/failure/retry persists the final name", async ({
		page,
	}) => {
		await openProof(page, { failRename: true });
		const row = page.getByTestId("space-row-research");
		await row.hover();
		await page
			.getByRole("button", { name: "Add to Research notes", exact: true })
			.click();
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"space-add","payload":{"spaceId":"space-research"}'
		);
		await expect(page.getByTestId("document-reads")).toHaveText("{}");

		let menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Rename space" }).click();
		let dialog = page.getByRole("dialog", { name: "Rename space" });
		await dialog.getByRole("textbox", { name: "Name" }).fill("Discarded name");
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId("space-name-space-research")).toHaveText(
			"Research notes"
		);
		expect(
			await page.evaluate(() => localStorage.getItem("proof:spaces"))
		).toBeNull();

		menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Rename space" }).click();
		dialog = page.getByRole("dialog", { name: "Rename space" });
		const name = dialog.getByRole("textbox", { name: "Name" });
		await name.fill("Platform notes");
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(
			dialog.getByText("Space name conflict", { exact: true })
		).toBeVisible();
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId("space-name-space-research")).toHaveText(
			"Platform notes"
		);
		expect(
			JSON.parse(
				(await page.evaluate(() => localStorage.getItem("proof:spaces"))) ??
					"[]"
			).find((space: { id: string }) => space.id === SPACE_ID)?.name
		).toBe("Platform notes");
		await page.reload();
		await expect(page.getByTestId("space-name-space-research")).toHaveText(
			"Platform notes"
		);
	});

	test("space visibility and delete controls respect gates, cancel, then recover from a failed delete", async ({
		page,
	}) => {
		await openProof(page, { failDelete: true });
		let menu = await openSpaceMenu(page, "space-row-team");
		await expect(
			menu.getByRole("menuitem", { name: "Make private (admins only)" })
		).toBeDisabled();
		await expect(
			menu.getByRole("menuitem", { name: "Delete space" })
		).toBeEnabled();
		await menu.press("Escape");
		menu = await openSpaceMenu(page, "space-row-locked");
		await expect(
			menu.getByRole("menuitem", { name: "Delete space" })
		).toBeDisabled();
		await menu.locator('[data-slot="tooltip-trigger"]').last().hover();
		await expect(
			page.getByText(/Only organization members with Space delete permission/)
		).toBeVisible();
		await menu.press("Escape");

		menu = await openSpaceMenu(page, "space-row-system");
		await expect(
			menu.getByRole("menuitem", { name: "Delete space" })
		).toBeDisabled();
		await menu.locator('[data-slot="tooltip-trigger"]').last().hover();
		await expect(
			page.getByText(/System spaces can't be deleted/)
		).toBeVisible();
		await menu.press("Escape");

		menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Share with team" }).click();
		const visibilityDialog = page.getByRole("alertdialog");
		await expect(visibilityDialog).toContainText("Share with your team?");
		await visibilityDialog.getByRole("button", { name: "Cancel" }).click();
		await expect(
			page.getByTestId("space-visibility-space-research")
		).toHaveText("private");
		menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Share with team" }).click();
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "Share with team" })
			.click();
		await expect(
			page.getByTestId("space-visibility-space-research")
		).toHaveText("org");

		menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Delete space" }).click();
		const deleteDialog = page.getByRole("alertdialog");
		await expect(deleteDialog).toContainText("Delete this Space?");
		await deleteDialog.getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByTestId("space-row-research")).toBeVisible();

		menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Delete space" }).click();
		await confirmDestructiveDialog(page, "Delete Research notes");
		await expect(page.getByTestId("space-delete-status")).toHaveText(
			"Delete failed; space retained"
		);
		await expect(page.getByRole("alertdialog")).toBeVisible();
		await confirmDestructiveDialog(page, "Delete Research notes");
		await expect(page.getByTestId("space-row-research")).toHaveCount(0);
		await expect(page.getByTestId("space-delete-status")).toHaveText(
			"Deleted space-research"
		);
		expect(
			JSON.parse(
				(await page.evaluate(() => localStorage.getItem("proof:spaces"))) ??
					"[]"
			).some((space: { id: string }) => space.id === SPACE_ID)
		).toBe(false);
		await page.screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-sidebar-space-delete.png"
			),
			fullPage: true,
			animations: "disabled",
		});
	});

	test("space icon failure can be retried and the selected glyph is saved", async ({
		page,
	}) => {
		await openProof(page, { failSpaceIcon: true });
		let menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Change icon" }).click();
		await chooseFixtureIcon(page);
		await expect(page.getByTestId("space-icon-status")).toHaveText(
			"icon save failed"
		);
		menu = await openSpaceMenu(page);
		await menu.getByRole("menuitem", { name: "Change icon" }).click();
		await chooseFixtureIcon(page);
		await expect(page.getByTestId("space-icon-status")).toHaveText(
			"icon saved: lucide:folder"
		);
		expect(
			JSON.parse(
				(await page.evaluate(() =>
					localStorage.getItem("proof:space-icons")
				)) ?? "{}"
			)[SPACE_ID]
		).toEqual({ kind: "icon", id: "lucide:folder" });
	});

	test("space row keyboard disclosure retries a lazy read and emits the visibility drag payload", async ({
		page,
	}) => {
		await openProof(page, { failDocumentRead: true });
		const row = page
			.getByTestId("space-row-research")
			.locator('[role="button"]')
			.first();
		await row.click();
		await expect(page.getByText("No pages yet", { exact: true })).toBeVisible();
		await row.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByText("No pages yet", { exact: true })).toBeHidden();
		await row.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByText("Launch brief", { exact: true })).toBeVisible();
		await expect(page.getByTestId("document-reads")).toHaveText(
			JSON.stringify({ [SPACE_ID]: 2 })
		);

		await row.dragTo(page.getByTestId("visibility-drop-target"));
		await expect(page.locator("html")).toHaveAttribute(
			"data-space-visibility-drag",
			JSON.stringify({
				effectAllowed: "move",
				marker: "1",
				payload: JSON.stringify({
					from: "private",
					id: SPACE_ID,
					name: "Research notes",
					resourceType: "space",
				}),
				text: JSON.stringify({
					from: "private",
					id: SPACE_ID,
					name: "Research notes",
					resourceType: "space",
				}),
			})
		);
		await expect(
			page.getByTestId("space-row-system").locator('[role="button"]')
		).toHaveAttribute("draggable", "false");
	});

	test("project row shortcuts route to exact targets and set/remove project state persistently", async ({
		page,
	}) => {
		await openProof(page);
		const project = page.getByTestId("project-row-alpha");
		const projectHeader = project.getByRole("button").first();
		await projectHeader.click();
		await expect(page.getByTestId("project-expanded")).toHaveText("true");
		await expect(
			page.getByText("Ship release notes", { exact: true })
		).toBeVisible();
		await projectHeader.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("project-expanded")).toHaveText("false");
		await project.hover();
		await project
			.getByRole("button", { name: "New chat in this folder" })
			.click();
		await project.getByRole("button", { name: "Open project changes" }).click();
		await project.getByRole("button", { name: "Browse project files" }).click();
		await project.getByRole("button", { name: "Open Git graph" }).click();
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"new-chat","payload":{"path":"/workspace/project-alpha"}'
		);
		await expect(page.getByTestId("active-folder")).toHaveText(PROJECT_PATH);
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"tab","payload":{"path":"/project/diff/%2Fworkspace%2Fproject-alpha","title":"Changes · Alpha","forceNew":false}'
		);
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"tab","payload":{"path":"/project/files/%2Fworkspace%2Fproject-alpha","title":"Files · Alpha","forceNew":false}'
		);
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"tab","payload":{"path":"/project/graph/%2Fworkspace%2Fproject-alpha","title":"Git graph · Alpha","forceNew":false}'
		);
		await expect(page.getByTestId("project-expanded")).toHaveText("false");

		let menu = await openProjectMenu(page);
		await menu.getByRole("menuitem", { name: "Open Git graph" }).click();
		await expect(page.getByTestId("navigation-events")).toContainText(
			'"kind":"tab","payload":{"path":"/project/graph/%2Fworkspace%2Fproject-alpha","title":"Git graph · Alpha","forceNew":false}'
		);
		menu = await openProjectMenu(page);
		await menu.getByRole("menuitem", { name: "Set as active project" }).click();
		await expect(page.getByTestId("active-folder")).toHaveText(PROJECT_PATH);
		expect(
			await page.evaluate(() => localStorage.getItem("ryu_workspace_folder"))
		).toBe(PROJECT_PATH);
		await page.reload();
		await expect(page.getByTestId("active-folder")).toHaveText(PROJECT_PATH);
		await page.getByTestId("project-row-alpha").hover();
		await page.screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-sidebar-project-rows.png"
			),
			fullPage: true,
			animations: "disabled",
		});

		await page
			.getByTestId("project-row-alpha")
			.getByRole("button")
			.first()
			.click({
				button: "right",
				force: true,
			});
		menu = page.locator('[data-slot="context-menu-content"]').last();
		await menu.getByRole("menuitem", { name: "Remove from app" }).click();
		await expect(page.getByTestId("project-removed")).toHaveText("true");
		expect(
			JSON.parse(
				(await page.evaluate(() =>
					localStorage.getItem("ryu_workspace_removed")
				)) ?? "[]"
			)
		).toContain(PROJECT_PATH);
		await page.reload();
		await expect(page.getByTestId("project-removed")).toHaveText("true");
		await page.screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-sidebar-project-removed.png"
			),
			fullPage: true,
			animations: "disabled",
		});
	});

	test("project delete-all-chats confirmation cancels safely, deletes exact ids, and gates empty projects", async ({
		page,
	}) => {
		await openProof(page);
		const alphaHeader = page
			.getByTestId("project-row-alpha")
			.getByRole("button")
			.first();
		await alphaHeader.click();
		await expect(page.getByTestId("project-expanded")).toHaveText("true");
		let menu = await openProjectMenu(page);
		await menu.getByRole("menuitem", { name: "Delete all chats" }).click();
		let dialog = page.getByRole("alertdialog");
		await expect(dialog).toContainText("Delete all 2 chats in Alpha?");
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId("deleted-conversations")).toHaveText("[]");

		menu = await openProjectMenu(page);
		await menu.getByRole("menuitem", { name: "Delete all chats" }).click();
		dialog = page.getByRole("alertdialog");
		await dialog.getByRole("button", { name: "Delete 2 chats" }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId("deleted-conversations")).toHaveText(
			'["project-chat-1","project-chat-2"]'
		);
		await expect(
			page
				.getByTestId("project-row-alpha")
				.getByText("No chats", { exact: true })
		).toBeVisible();
		await page.getByTestId("project-row-alpha").screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-sidebar-project-delete-all-closed.png"
			),
			animations: "disabled",
		});
		const emptyMenu = await openProjectMenu(page, "project-row-empty");
		await expect(
			emptyMenu.getByRole("menuitem", { name: "Delete all chats" })
		).toBeDisabled();
	});

	test("project settings dialog save retries native write and project icon persists", async ({
		page,
	}) => {
		await openProof(page, { failProjectWrite: true });
		let menu = await openProjectMenu(page);
		await menu.getByRole("menuitem", { name: /Edit project/ }).click();
		const dialog = page.getByRole("dialog", { name: "Edit project" });
		await expect(dialog).toBeVisible();
		const name = dialog.getByRole("textbox", { name: "Name" });
		await name.fill("Platform Alpha");
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(
			dialog.getByText(/Couldn't save project settings/)
		).toBeVisible();
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId("project-label")).toHaveText(
			"Platform Alpha"
		);
		await page.reload();
		await expect(page.getByTestId("project-label")).toHaveText(
			"Platform Alpha"
		);

		menu = await openProjectMenu(page);
		await menu.getByRole("menuitem", { name: "Change icon" }).click();
		await chooseFixtureIcon(page);
		expect(
			JSON.parse(
				(await page.evaluate(() =>
					localStorage.getItem("ryu_workspace_icons")
				)) ?? "{}"
			)
		).toMatchObject({ [PROJECT_PATH]: { kind: "icon", id: "lucide:folder" } });
	});
});

async function confirmDestructiveDialog(page: Page, label: string) {
	const slider = page.getByRole("slider", { name: label });
	await slider.focus();
	for (let step = 0; step < 5; step += 1) {
		await page.keyboard.press("ArrowRight");
	}
}
