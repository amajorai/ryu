import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	type PanelTabBarProofSnapshot,
	panelTabBarProofSnapshotSchema,
} from "./panel-tab-bar-proof.contracts.ts";

function screenshotPath(name: string): string {
	return path.resolve(
		import.meta.dirname,
		"../../..",
		"docs/proof/test-coverage-sweep-20260924/evidence",
		name
	);
}

async function readState(page: Page): Promise<PanelTabBarProofSnapshot> {
	const raw = await page.getByTestId("callback-readback").textContent();
	if (!raw) {
		throw new Error("Panel tab callback readback was empty");
	}
	return panelTabBarProofSnapshotSchema.parse(JSON.parse(raw));
}

async function openContextMenu(
	dock: Locator,
	tabLabel: string
): Promise<Locator> {
	await dock.getByRole("button", { name: tabLabel, exact: true }).click({
		button: "right",
	});
	const menu = dock.page().locator('[data-slot="context-menu-content"]');
	await expect(menu).toBeVisible();
	return menu;
}

test.describe.configure({ timeout: 60_000 });

test("title activation, X close, and middle-click close update the exact bottom tab state", async ({
	page,
}) => {
	await page.goto("/panel-tab-bar-proof.html");
	await expect(
		page.getByRole("heading", { name: "Workspace panel tabs", exact: true })
	).toBeVisible();
	const bottom = page.getByTestId("bottom-dock");
	let state = await readState(page);
	expect(state.active.bottom).toBe("bottom-terminal");
	expect(state.tabs.bottom.map((tab) => tab.uid)).toEqual([
		"bottom-terminal",
		"bottom-files",
		"bottom-changes",
	]);

	await bottom.getByRole("button", { name: "Files", exact: true }).click();
	await expect(page.getByTestId("bottom-active")).toHaveText("bottom-files");
	state = await readState(page);
	expect(state.events).toEqual([
		{ action: "activate", from: "bottom", uid: "bottom-files" },
	]);

	await bottom
		.getByRole("button", { name: "Close tab", exact: true })
		.nth(1)
		.click();
	await expect(page.getByTestId("bottom-active")).toHaveText("bottom-changes");
	state = await readState(page);
	expect(state.tabs.bottom.map((tab) => tab.uid)).toEqual([
		"bottom-terminal",
		"bottom-changes",
	]);
	expect(state.events.at(-1)).toEqual({
		action: "close-tab",
		from: "bottom",
		uid: "bottom-files",
	});

	await bottom
		.getByRole("button", { name: "Terminal", exact: true })
		.click({ button: "middle" });
	state = await readState(page);
	expect(state.tabs.bottom.map((tab) => tab.uid)).toEqual(["bottom-changes"]);
	expect(state.active.bottom).toBe("bottom-changes");
	expect(state.events.slice(-1)).toEqual([
		{
			action: "close-tab",
			from: "bottom",
			uid: "bottom-terminal",
		},
	]);
	expect(
		state.events.filter((event) => event.action === "activate")
	).toHaveLength(1);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("panel-tab-bar-activation-middle-close.png"),
	});
});

test("pin, pinned tooltip, and Move to transfer the same tab between both dock caller shapes", async ({
	page,
}) => {
	await page.goto("/panel-tab-bar-proof.html");
	const bottom = page.getByTestId("bottom-dock");
	const right = page.getByTestId("right-dock");
	let menu = await openContextMenu(bottom, "Files");
	await menu.getByRole("menuitem", { name: "Pin tab", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await readState(page)).tabs.bottom.find(
					(tab) => tab.uid === "bottom-files"
				)?.pinned
		)
		.toBe(true);

	await bottom
		.getByRole("button", { name: "Files", exact: true })
		.hover({ position: { x: 5, y: 16 } });
	await expect(
		page
			.locator('[data-slot="tooltip-content"]')
			.filter({ hasText: "Shared across chats in this project" })
	).toHaveText("Shared across chats in this project");
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("panel-tab-bar-pinned-tab-tooltip.png"),
	});
	await page.mouse.move(0, 0);

	menu = await openContextMenu(bottom, "Files");
	await menu.getByRole("menuitem", { name: "Unpin tab", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await readState(page)).tabs.bottom.find(
					(tab) => tab.uid === "bottom-files"
				)?.pinned
		)
		.toBe(false);

	menu = await openContextMenu(bottom, "Files");
	await expect(
		menu.getByRole("menuitem", { name: "Move to right panel", exact: true })
	).toBeVisible();
	await menu
		.getByRole("menuitem", { name: "Move to right panel", exact: true })
		.click();
	let state = await readState(page);
	expect(state.tabs.bottom.map((tab) => tab.uid)).toEqual([
		"bottom-terminal",
		"bottom-changes",
	]);
	expect(state.tabs.right.at(-1)).toEqual({
		kind: "files",
		label: "Files",
		pinned: false,
		uid: "bottom-files",
	});
	expect(state.active.right).toBe("bottom-files");
	expect(state.events.at(-1)).toEqual({
		action: "move-tab",
		from: "bottom",
		to: "right",
		uid: "bottom-files",
	});

	menu = await openContextMenu(right, "Files");
	await expect(
		menu.getByRole("menuitem", { name: "Move to bottom panel", exact: true })
	).toBeVisible();
	await menu
		.getByRole("menuitem", { name: "Move to bottom panel", exact: true })
		.click();
	state = await readState(page);
	expect(state.tabs.right.map((tab) => tab.uid)).toEqual(["right-context"]);
	expect(state.tabs.bottom.at(-1)).toEqual({
		kind: "files",
		label: "Files",
		pinned: false,
		uid: "bottom-files",
	});
	expect(state.active.bottom).toBe("bottom-files");
	expect(state.events.slice(-1)).toEqual([
		{
			action: "move-tab",
			from: "right",
			to: "bottom",
			uid: "bottom-files",
		},
	]);
});

test("context Close, Close others, single-tab disabling, and Close all have exact consequences", async ({
	page,
}) => {
	await page.goto("/panel-tab-bar-proof.html");
	const bottom = page.getByTestId("bottom-dock");
	let menu = await openContextMenu(bottom, "Changes");
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("panel-tab-bar-context-menu.png"),
	});
	await menu.getByRole("menuitem", { name: "Close", exact: true }).click();
	let state = await readState(page);
	expect(state.tabs.bottom.map((tab) => tab.uid)).toEqual([
		"bottom-terminal",
		"bottom-files",
	]);
	expect(state.active.bottom).toBe("bottom-terminal");
	expect(state.events.at(-1)).toEqual({
		action: "close-tab",
		from: "bottom",
		uid: "bottom-changes",
	});

	menu = await openContextMenu(bottom, "Files");
	await menu
		.getByRole("menuitem", { name: "Close others", exact: true })
		.click();
	state = await readState(page);
	expect(state.tabs.bottom.map((tab) => tab.uid)).toEqual(["bottom-files"]);
	expect(state.active.bottom).toBe("bottom-files");
	expect(state.events.at(-1)).toEqual({
		action: "close-others",
		from: "bottom",
		uid: "bottom-files",
	});

	menu = await openContextMenu(bottom, "Files");
	const closeOthers = menu.getByRole("menuitem", {
		name: "Close others",
		exact: true,
	});
	await expect(closeOthers).toBeDisabled();
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("panel-tab-bar-one-tab-close-others-disabled.png"),
	});
	await menu.getByRole("menuitem", { name: "Close all", exact: true }).click();
	state = await readState(page);
	expect(state.tabs.bottom).toEqual([]);
	expect(state.active.bottom).toBe("");
	expect(state.events.at(-1)).toEqual({ action: "close-all", from: "bottom" });
});

test("no-project Pin and Unpin are disabled; chat-only Context tabs omit pin actions", async ({
	page,
}) => {
	await page.goto("/panel-tab-bar-proof.html?pinDisabled=true");
	const bottom = page.getByTestId("bottom-dock");
	let menu = await openContextMenu(bottom, "Terminal");
	const pin = menu.getByRole("menuitem", { name: "Pin tab", exact: true });
	await expect(pin).toBeDisabled();
	await expect(
		menu.getByText("Open a project to pin and share tabs across chats", {
			exact: true,
		})
	).toBeVisible();
	await page.keyboard.press("Escape");

	menu = await openContextMenu(bottom, "Files");
	await expect(
		menu.getByRole("menuitem", { name: "Unpin tab", exact: true })
	).toBeDisabled();
	let state = await readState(page);
	expect(
		state.tabs.bottom.find((tab) => tab.uid === "bottom-files")?.pinned
	).toBe(true);
	expect(state.events).toEqual([]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("panel-tab-bar-pin-disabled.png"),
	});

	await page.goto("/panel-tab-bar-proof.html?nonPinnable=true");
	menu = await openContextMenu(page.getByTestId("bottom-dock"), "Context");
	await expect(
		menu.getByRole("menuitem", { name: /Pin tab|Unpin tab/u })
	).toHaveCount(0);
	state = await readState(page);
	expect(state.events).toEqual([]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("panel-tab-bar-nonpinnable-context.png"),
	});
});

test("bottom New tab stays focused on panels; right New tab and Pages add exact kinds", async ({
	page,
}) => {
	await page.goto("/panel-tab-bar-proof.html");
	const bottom = page.getByTestId("bottom-dock");
	const right = page.getByTestId("right-dock");
	await bottom.getByRole("button", { name: "New tab", exact: true }).click();
	let menu = page.locator('[data-slot="dropdown-menu-content"]');
	await expect(menu).toBeVisible();
	await expect(
		menu.getByRole("menuitem", { name: "Terminal", exact: true })
	).toBeVisible();
	await expect(
		menu.getByRole("menuitem", { name: "Pages", exact: true })
	).toHaveCount(0);
	await page.keyboard.press("Escape");

	await right.getByRole("button", { name: "New tab", exact: true }).click();
	menu = page.locator('[data-slot="dropdown-menu-content"]');
	await menu.getByRole("menuitem", { name: "Files", exact: true }).click();
	let state = await readState(page);
	expect(state.tabs.right.at(-1)).toEqual({
		kind: "files",
		label: "Files 1",
		uid: "right-new-1",
	});
	expect(state.active.right).toBe("right-new-1");
	expect(state.events.at(-1)).toEqual({
		action: "add-tab",
		from: "right",
		uid: "right-new-1",
		kind: "files",
		label: "Files 1",
	});

	await right.getByRole("button", { name: "New tab", exact: true }).click();
	menu = page.locator('[data-slot="dropdown-menu-content"]');
	await menu.getByRole("menuitem", { name: "Pages", exact: true }).click();
	await expect(
		page.getByRole("menuitem", { name: "Store", exact: true })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("panel-tab-bar-pages-menu.png"),
	});
	await page.getByRole("menuitem", { name: "Store", exact: true }).click();
	await expect(menu).toBeHidden();
	state = await readState(page);
	expect(state.tabs.right.at(-1)).toEqual({
		kind: "route:/store",
		label: "Store 2",
		uid: "right-new-2",
	});
	expect(state.active.right).toBe("right-new-2");
	expect(state.events.slice(-1)).toEqual([
		{
			action: "add-tab",
			from: "right",
			uid: "right-new-2",
			kind: "route:/store",
			label: "Store 2",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("panel-tab-bar-added-page-tab.png"),
	});
});

test("Close panel tooltip and button invoke only the current dock's callback", async ({
	page,
}) => {
	await page.goto("/panel-tab-bar-proof.html");
	const bottom = page.getByTestId("bottom-dock");
	const closePanel = bottom.getByRole("button", {
		name: "Close panel",
		exact: true,
	});
	await closePanel.hover();
	await expect(
		page.locator('[data-slot="tooltip-content"]').filter({
			hasText: "Close panel",
		})
	).toHaveText("Close panel");
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("panel-tab-bar-close-panel-tooltip.png"),
	});
	await closePanel.click();
	const state = await readState(page);
	expect(state.closedPanelCount).toEqual({ bottom: 1, right: 0 });
	expect(state.events.at(-1)).toEqual({
		action: "close-panel",
		from: "bottom",
	});
	expect(state.tabs.bottom.map((tab) => tab.uid)).toEqual([
		"bottom-terminal",
		"bottom-files",
		"bottom-changes",
	]);
});
