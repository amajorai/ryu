import { expect, type Page, test } from "@playwright/test";
import { DEFAULT_SECTION_ORDER } from "../src/components/layout/sidebar-sections.ts";
import { sidebarStringsSchema } from "./app-sidebar-interactions-proof.contracts.ts";
import {
	openGlobalContextMenu,
	registerAppSidebarProofHooks,
	storageValue,
	unexpectedBrowserErrors,
} from "./app-sidebar-interactions-proof.fixture.ts";
import {
	DEFAULT_PROOF_HIDDEN_SECTIONS,
	EVIDENCE_DIRECTORY,
	STORY_URL,
} from "./app-sidebar-interactions-proof.fixture-data.ts";

registerAppSidebarProofHooks();

test.describe("Customize sidebar production dialog", () => {
	test.afterEach(async ({ page }) => {
		expect(unexpectedBrowserErrors.get(page)).toEqual([]);
	});
	async function openCustomize(page: Page) {
		const menu = await openGlobalContextMenu(page);
		await menu
			.getByRole("menuitem", { name: "Customize sidebar", exact: true })
			.click();
		const dialog = page.getByRole("dialog", { name: "Customize sidebar" });
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: "All off", exact: true })
		).toBeVisible();
		await expect(page.getByRole("menu")).toHaveCount(0);
		return dialog;
	}
	async function readList(page: Page, key: string) {
		return sidebarStringsSchema.parse(
			JSON.parse((await storageValue(page, key)) ?? "[]")
		);
	}
	test("bulk visibility covers contributed buttons and sections, survives Done and reload, and resets defaults", async ({
		page,
	}) => {
		await page.goto(`${STORY_URL}?focus=agents,chats`);
		let dialog = await openCustomize(page);
		await expect(dialog.getByText("Proof home", { exact: true })).toBeVisible();
		await dialog.getByRole("button", { name: "All off", exact: true }).click();
		expect(await readList(page, "ryu:sidebar-hidden-chrome")).toContain(
			"plugin:proof-app:proof-home"
		);
		expect(await readList(page, "ryu:sidebar-hidden-sections")).toContain(
			"plugin:proof-app:proof-records"
		);
		await dialog.getByRole("button", { name: "Done", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Proof home", exact: true })
		).toBeHidden();
		await page.reload();
		expect(await readList(page, "ryu:sidebar-hidden-chrome")).toContain(
			"plugin:proof-app:proof-home"
		);
		// Hidden content still has its production background context-menu entry.
		await page
			.locator('[data-sidebar="content"]')
			.click({ button: "right", position: { x: 10, y: 10 } });
		await page
			.getByRole("menuitem", { name: "Customize sidebar", exact: true })
			.click();
		dialog = page.getByRole("dialog", { name: "Customize sidebar" });
		await dialog.getByRole("button", { name: "All on", exact: true }).click();
		expect(await readList(page, "ryu:sidebar-hidden-chrome")).toEqual(["logo"]);
		expect(await readList(page, "ryu:sidebar-hidden-sections")).toEqual([]);
		await dialog
			.getByRole("button", { name: "Reset to default", exact: true })
			.click();
		expect(await readList(page, "ryu:sidebar-hidden-sections")).toEqual(
			DEFAULT_PROOF_HIDDEN_SECTIONS
		);
		expect(await readList(page, "ryu:sidebar-section-order")).toEqual(
			DEFAULT_SECTION_ORDER
		);
		await dialog.getByRole("button", { name: "Done", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Proof home", exact: true })
		).toBeVisible();
		await page.locator('[data-sidebar="sidebar"]').screenshot({
			path: `${EVIDENCE_DIRECTORY}/customize-sidebar-restored.png`,
			animations: "disabled",
		});
	});
	test("group controls are isolated and keyboard visibility changes apply immediately on Escape", async ({
		page,
	}) => {
		await page.goto(`${STORY_URL}?focus=agents,chats`);
		const dialog = await openCustomize(page);
		const groups = ["Top buttons", "Sections", "Bottom buttons"];
		for (const title of groups) {
			const sectionsBefore = await readList(
				page,
				"ryu:sidebar-hidden-sections"
			);
			const chromeBefore = await readList(page, "ryu:sidebar-hidden-chrome");
			const group = dialog
				.getByText(title, { exact: true })
				.locator("xpath=../..");
			await group
				.getByRole("button", { name: "Hide all", exact: true })
				.click();
			await expect(dialog).toBeVisible();
			if (title === "Sections") {
				expect(await readList(page, "ryu:sidebar-hidden-chrome")).toEqual(
					chromeBefore
				);
			} else {
				expect(await readList(page, "ryu:sidebar-hidden-sections")).toEqual(
					sectionsBefore
				);
				expect(
					(await readList(page, "ryu:sidebar-hidden-chrome")).includes(
						title === "Top buttons" ? "settings" : "new-chat"
					)
				).toBe(
					chromeBefore.includes(
						title === "Top buttons" ? "settings" : "new-chat"
					)
				);
			}
			await expect(
				group.getByRole("button", {
					name: title === "Sections" ? "Hide section" : "Hide button",
					exact: true,
				})
			).toHaveCount(0);
			await group
				.getByRole("button", { name: "Show all", exact: true })
				.click();
			await expect(
				group.getByRole("button", {
					name: title === "Sections" ? "Show section" : "Show button",
					exact: true,
				})
			).toHaveCount(0);
		}
		const agents = dialog
			.getByText("Agents", { exact: true })
			.locator("xpath=../..");
		await agents
			.getByRole("button", { name: "Hide section", exact: true })
			.click();
		expect(await readList(page, "ryu:sidebar-hidden-sections")).toEqual([
			"agents",
		]);
		await agents
			.getByRole("button", { name: "Show section", exact: true })
			.focus();
		await page.keyboard.press("Space");
		expect(await readList(page, "ryu:sidebar-hidden-sections")).toEqual([]);
		const node = dialog
			.getByText("Node selector", { exact: true })
			.locator("..");
		await node
			.getByRole("button", { name: "Hide button", exact: true })
			.click();
		expect(await readList(page, "ryu:sidebar-hidden-chrome")).toEqual([
			"logo",
			"node-selector",
		]);
		await node
			.getByRole("button", { name: "Show button", exact: true })
			.click();
		const row = dialog
			.getByText("Proof home", { exact: true })
			.locator("xpath=../..");
		await row.getByRole("button", { name: "Hide button", exact: true }).focus();
		await page.keyboard.press("Enter");
		expect(await readList(page, "ryu:sidebar-hidden-chrome")).toEqual([
			"logo",
			"plugin:proof-app:proof-home",
		]);
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Proof home", exact: true })
		).toBeHidden();
	});
	test("dragging contributed rows persists exact order without mixing sections and top buttons", async ({
		page,
	}) => {
		await page.goto(`${STORY_URL}?focus=agents,chats`);
		let dialog = await openCustomize(page);
		const chromeBefore = await readList(page, "ryu:sidebar-chrome-order");
		const chromeTransfer = await page.evaluateHandle(() => new DataTransfer());
		const chromeSource = dialog.getByRole("button", {
			name: "Proof home",
			exact: true,
		});
		await chromeSource.dispatchEvent("dragstart", {
			dataTransfer: chromeTransfer,
		});
		await expect(chromeSource.locator("..")).toHaveClass(/opacity-50/);
		const chromeTarget = dialog
			.getByRole("button", { name: "New chat", exact: true })
			.locator("..");
		await chromeTarget.dispatchEvent("dragover", {
			dataTransfer: chromeTransfer,
		});
		await chromeTarget.dispatchEvent("drop", { dataTransfer: chromeTransfer });
		await chromeTransfer.dispose();
		const chromeAfter = await readList(page, "ryu:sidebar-chrome-order");
		expect(chromeAfter.indexOf("plugin:proof-app:proof-home")).toBeLessThan(
			chromeAfter.indexOf("new-chat")
		);
		expect(chromeAfter).not.toEqual(chromeBefore);
		const transfer = await page.evaluateHandle(() => new DataTransfer());
		await dialog
			.getByRole("button", { name: "Proof records", exact: true })
			.dispatchEvent("dragstart", { dataTransfer: transfer });
		const target = dialog
			.getByRole("button", { name: "Agents", exact: true })
			.locator("..");
		await target.dispatchEvent("dragover", { dataTransfer: transfer });
		await target.dispatchEvent("drop", { dataTransfer: transfer });
		await transfer.dispose();
		const sectionAfter = await readList(page, "ryu:sidebar-section-order");
		expect(sectionAfter.indexOf("plugin:proof-app:proof-records")).toBeLessThan(
			sectionAfter.indexOf("agents")
		);
		expect(await readList(page, "ryu:sidebar-chrome-order")).toEqual(
			chromeAfter
		);
		await dialog.getByRole("button", { name: "Done", exact: true }).click();
		await expect(dialog).toBeHidden();
		await page.reload();
		dialog = await openCustomize(page);
		expect(await readList(page, "ryu:sidebar-chrome-order")).toEqual(
			chromeAfter
		);
		expect(await readList(page, "ryu:sidebar-section-order")).toEqual(
			sectionAfter
		);
		await dialog.getByRole("button", { name: "Done", exact: true }).click();
		await expect(dialog).toBeHidden();
	});
});
