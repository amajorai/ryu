// Continues titlebar-actions-proof.spec.ts (split under the file token limit); helpers live in titlebar-actions-proof.helpers.ts.

import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	EVIDENCE,
	focusedTitlebarTab,
	installBackendFixture,
	openTitlebarContextMenu,
	openWorkspace,
	readSession,
	showTitlebar,
} from "./titlebar-actions-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("tab context menus create, collapse, rename, and ungroup a tab group", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await page
		.getByRole("button", { name: "Draft brief", exact: true })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Add to group" }).hover();
	await page.getByRole("menuitem", { name: "New group", exact: true }).click();
	const groupHeader = page.getByTestId("tab-group-header");
	await expect(groupHeader).toHaveText("Group");
	await groupHeader.hover();
	await expect(
		page.locator('[data-slot="tooltip-content"]').filter({
			hasText: "Collapse group",
		})
	).toHaveText("Collapse group");
	await groupHeader.click();
	await expect(
		page.getByRole("button", { name: "Draft brief", exact: true })
	).toHaveCount(0);
	await groupHeader.click();
	await expect(
		page.getByRole("button", { name: "Draft brief", exact: true })
	).toBeVisible();
	await groupHeader.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Collapse group", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Draft brief", exact: true })
	).toHaveCount(0);
	await groupHeader.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Expand group", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Draft brief", exact: true })
	).toBeVisible();
	await groupHeader.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Rename group", exact: true })
		.click();
	const groupName = page.getByRole("textbox").last();
	await groupName.fill("Daily notes");
	await groupName.press("Enter");
	await expect(page.getByTestId("tab-group-header")).toHaveText("Daily notes");
	await groupHeader.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Color", exact: true }).hover();
	await page
		.getByRole("menuitemradio", { name: "Purple", exact: true })
		.click();
	// Since 0db714a247 (ui(P1): quiet shell frame) the group colour is identity
	// data shown only as the header's 6px dot; the pill itself stays neutral.
	await expect(
		groupHeader.locator('span[aria-hidden="true"]').first()
	).toHaveClass(/\bbg-purple-500\b/u);
	await expect(groupHeader).not.toHaveClass(/purple/u);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await page
		.getByRole("button", { name: "Release checklist", exact: true })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Add to group" }).hover();
	await page
		.getByRole("menuitem", { name: "Daily notes", exact: true })
		.click();
	await expect(page.getByTestId("tab-group-header")).toHaveText("Daily notes");
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-group-actions.png"),
		fullPage: false,
	});
	await page
		.getByRole("button", { name: "Draft brief", exact: true })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Add to group" }).hover();
	await page
		.getByRole("menuitem", { name: "Remove from group", exact: true })
		.click();
	await expect(page.getByTestId("tab-group-header")).toHaveText("Daily notes");
	await expect(
		page.getByRole("button", { name: "Draft brief", exact: true })
	).toBeVisible();
	await groupHeader.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Ungroup", exact: true }).click();
	await expect(page.getByTestId("tab-group-header")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Draft brief", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Release checklist", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Split view" }).hover();
	await page
		.getByRole("menuitem", { name: "Split with new chat", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.length)
		.toBe(1);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Split view" }).hover();
	await page.getByRole("menuitem", { name: "Add tab to split" }).hover();
	await page
		.getByRole("menuitem", { name: "Draft brief", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.[0]?.c?.length)
		.toBe(3);
	await (await focusedTitlebarTab(page, "Tab tear-out notes")).click({
		button: "right",
	});
	await page.getByRole("menuitem", { name: "Split view" }).hover();
	await page
		.getByRole("menuitem", { name: "Add new chat to split", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.[0]?.c?.length)
		.toBe(4);
	await (await focusedTitlebarTab(page, "Tab tear-out notes")).click({
		button: "right",
	});
	await page.getByRole("menuitem", { name: "Split view" }).hover();
	await page
		.getByRole("menuitem", { name: "Remove from split", exact: true })
		.click();
	// Under the workbench a pane is a Center group: removing a tab moves it
	// behind another pane's active tab, and its own pane closes only when it
	// held nothing else (DesktopCenterSplits.test.tsx). This pane also holds
	// Release checklist, which takes its place, so four panes remain and the
	// notes tab is no longer any pane's member, though still open.
	await expect
		.poll(async () => {
			const session = await readSession(page);
			const notes = session?.tabs.findIndex(
				(tab) => tab.title === "Tab tear-out notes"
			);
			const members = (session?.splits?.[0]?.c ?? []).map((leaf) => leaf.i);
			return {
				open: notes !== undefined && notes >= 0,
				member: members.includes(notes),
				panes: members.length,
			};
		})
		.toEqual({ member: false, open: true, panes: 4 });
	await (await focusedTitlebarTab(page, "Draft brief")).click({
		button: "right",
	});
	await page.getByRole("menuitem", { name: "Split view" }).hover();
	await page.getByRole("menuitem", { name: "Unsplit", exact: true }).click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.length ?? 0)
		.toBe(0);
	await page
		.getByRole("button", { name: "Draft brief", exact: true })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Add to group" }).hover();
	await page.getByRole("menuitem", { name: "New group", exact: true }).click();
	await page.getByTestId("tab-group-header").click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Close group", exact: true })
		.click();
	await expect(page.getByTestId("tab-group-header")).toHaveCount(0);
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.not.toContain("Draft brief");
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
});

test("Connect to node assigns and clears a per-tab override", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	const noteTab = page.getByRole("button", {
		name: "Tab tear-out notes",
		exact: true,
	});
	await noteTab.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Connect to node" }).hover();
	await page
		.getByRole("menuitemradio", { name: "Remote", exact: true })
		.click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				Object.values(window.__getNodeTabOverrides()).includes("remote")
			)
		)
		.toBe(true);
	const nodeFixtureState = await page.evaluate(() =>
		window.__getNodeTabFixtureState()
	);
	expect(nodeFixtureState).toMatchObject({
		defaultNode: "local",
		nodes: ["local", "remote"],
	});
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu_node_tab_override_enabled"))
		)
		.toBe("true");
	const nodeIndicator = page.locator("span.bg-success");
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await nodeIndicator.hover();
	await expect(
		page.locator('[data-slot="tooltip-content"]').filter({
			hasText: "Connected to Remote",
		})
	).toHaveText("Connected to Remote");
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-node-override.png"),
		fullPage: false,
	});
	await expect(nodeIndicator).toHaveCount(1);

	await noteTab.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Connect to node" }).hover();
	await expect(
		page.getByRole("menuitemradio", { name: "Remote", exact: true })
	).toHaveAttribute("aria-checked", "true");
	await page
		.getByRole("menuitemradio", { name: "Default (Local)", exact: true })
		.click();
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await expect(nodeIndicator).toHaveCount(0);
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
});

test("Open in side panel opens a non-chat tab in the workbench Right region", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Open in side panel", exact: true })
		.click();
	// Under the workbench frame the shell serves the request at once as a Right
	// region tab (WorkbenchDockRequests), so nothing is queued for a chat and
	// the menu no longer claims it was.
	await expect
		.poll(() => page.evaluate(() => window.__getPendingSidePanelRoute()))
		.toBeNull();
	await expect(
		page.getByText("Queued for the side panel", { exact: true })
	).toHaveCount(0);
	const rightRegion = page.locator('[data-region="right"]');
	await expect(
		rightRegion.getByRole("tab", { name: /Tab tear-out notes/u })
	).toBeVisible();
	await expect(
		rightRegion
			.frameLocator('iframe[title="Tab tear-out notes"]')
			.getByText("TITLEBAR-ACTIONS-01")
	).toBeVisible();
	// The title-bar tab stays where it was.
	await expect(
		page
			.locator("div[data-tab-appearance][data-tauri-drag-region]")
			.first()
			.getByRole("button", { name: "Tab tear-out notes", exact: true })
	).toHaveCount(1);
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-side-panel-route.png"),
		fullPage: false,
	});
});

test("split orientation survives reload and the split header can unsplit", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Split view" }).hover();
	await page
		.getByRole("menuitem", {
			name: "Split with Release checklist",
			exact: true,
		})
		.click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.length)
		.toBe(1);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Split view" }).hover();
	await page
		.getByRole("menuitemradio", { name: "Stacked", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.[0]?.o)
		.toBe("rows");

	await page.reload({ waitUntil: "domcontentloaded" });
	const notice = page.getByRole("button", { name: "Got it", exact: true });
	if (await notice.count()) {
		await notice.click();
	}
	await expect
		.poll(async () => (await readSession(page))?.splits?.[0]?.o)
		.toBe("rows");
	const splitHeader = page.getByRole("button", {
		name: "Split view",
		exact: true,
	});
	await expect(splitHeader).toBeVisible();
	await splitHeader.hover();
	await expect(
		page
			.locator('[data-slot="tooltip-content"]')
			.filter({ hasText: "Split view" })
	).toHaveText("Split view");
	const draftTab = page
		.locator('[data-tab-appearance][draggable="true"]')
		.filter({ hasText: "Draft brief" });
	await draftTab.dragTo(splitHeader);
	await expect
		.poll(async () => (await readSession(page))?.splits?.[0]?.c?.length)
		.toBe(3);
	await expect(
		page
			.frameLocator('iframe[title="Tab tear-out notes"]')
			.getByText("TITLEBAR-ACTIONS-01")
	).toBeVisible();
	await expect(
		page
			.frameLocator('iframe[title="Release checklist"]')
			.getByText("TITLEBAR-ACTIONS-01")
	).toBeVisible();
	await expect(
		page
			.frameLocator('iframe[title="Draft brief"]')
			.getByText("TITLEBAR-ACTIONS-01")
	).toBeVisible();
	await splitHeader.click({ button: "right" });
	await expect(
		page.getByRole("menuitemradio", { name: "Stacked", exact: true })
	).toHaveAttribute("aria-checked", "true");
	await page
		.getByRole("menuitemradio", { name: "Side by side", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.[0]?.o)
		.toBe("columns");
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-split-restored.png"),
		fullPage: false,
	});
	await splitHeader.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Unsplit", exact: true }).click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.length ?? 0)
		.toBe(0);
	await expect(
		page.getByRole("button", { name: "Tab tear-out notes", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Release checklist", exact: true })
	).toBeVisible();
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
});

test("titlebar context menu saves auto-hide and calls the native fullscreen command", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await openTitlebarContextMenu(page);
	const autoHide = page.getByRole("menuitemcheckbox", {
		name: "Auto-hide title bar",
		exact: true,
	});
	await expect(autoHide).toBeVisible();
	await autoHide.click();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:auto-hide-titlebar"))
		)
		.toBe("true");
	const titlebar = page
		.locator("div[data-tab-appearance][data-tauri-drag-region]")
		.first();
	await expect(titlebar).toHaveCSS("opacity", "0");
	await showTitlebar(page);

	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitem", { name: "Enter full screen", exact: true })
		.click();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const host = window.__titlebarHost;
				return host.calls.filter((call) => call.command === "toggle_fullscreen")
					.length;
			})
		)
		.toBe(1);
	await openTitlebarContextMenu(page);
	await expect(
		page.getByRole("menuitem", { name: "Exit full screen", exact: true })
	).toBeVisible();
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-auto-hide-fullscreen.png"),
		fullPage: false,
	});
	await page
		.getByRole("menuitem", { name: "Exit full screen", exact: true })
		.click();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const host = window.__titlebarHost;
				return host.calls.filter((call) => call.command === "toggle_fullscreen")
					.length;
			})
		)
		.toBe(2);
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
});

test("fullscreen denial surfaces a recoverable error without changing the native state", async ({
	page,
}) => {
	await installBackendFixture(page);
	await page.goto("/titlebar-actions-proof.html?fullscreen-error=1");
	const notice = page.getByRole("button", { name: "Got it", exact: true });
	if (await notice.count()) {
		await notice.click();
	}
	await expect(
		page.locator('[data-tab-appearance][draggable="true"]')
	).toHaveCount(3);
	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitem", { name: "Enter full screen", exact: true })
		.click();
	await expect(
		page.getByText("Couldn't toggle full screen in this window.", {
			exact: true,
		})
	).toBeVisible();
	const state = await page.evaluate(() => {
		const host = window.__titlebarHost;
		return {
			fullscreen: host.fullscreen,
			toggleCalls: host.calls.filter(
				(call) => call.command === "toggle_fullscreen"
			).length,
		};
	});
	expect(state).toEqual({ fullscreen: false, toggleCalls: 1 });
});
