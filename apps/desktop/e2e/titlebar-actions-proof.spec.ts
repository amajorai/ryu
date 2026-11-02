import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	EVIDENCE,
	openTitlebarContextMenu,
	openWorkspace,
	readNativeCalls,
	readSession,
} from "./titlebar-actions-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("pin state survives a reload, and unpin restores a named full tab", async ({
	page,
}, testInfo) => {
	const errors = await openWorkspace(page);
	const checklist = page.getByRole("button", {
		name: "Release checklist",
		exact: true,
	});
	await checklist.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Pin tab", exact: true }).click();
	await expect
		.poll(async () => {
			const session = await readSession(page);
			return session?.tabs.find((tab) => tab.title === "Release checklist")
				?.pinned;
		})
		.toBe(true);
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-pinned-tab.png"),
		fullPage: false,
	});

	await page.reload({ waitUntil: "domcontentloaded" });
	const notice = page.getByRole("button", { name: "Got it", exact: true });
	if (await notice.count()) {
		await notice.click();
	}
	const pinnedChecklist = page.getByRole("button", {
		name: "Release checklist",
		exact: true,
	});
	await expect(pinnedChecklist).toBeVisible();
	await pinnedChecklist.hover();
	await expect(
		page.locator('[data-slot="tooltip-content"]').filter({
			hasText: "Release checklist",
		})
	).toHaveText("Release checklist");
	await expect
		.poll(async () => {
			const session = await readSession(page);
			return session?.tabs.find((tab) => tab.title === "Release checklist")
				?.pinned;
		})
		.toBe(true);
	await expect(
		page.getByRole("button", { name: "Close Release checklist", exact: true })
	).toHaveCount(0);
	await pinnedChecklist.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Open in new window", exact: true })
		.click();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const host = window.__titlebarHost;
				return host.calls
					.filter((call) => call.command === "open_tab_window")
					.at(-1)?.args;
			})
		)
		.toEqual({
			entityKey: null,
			path: "/artifact/checklist",
			conversationId: null,
			node: null,
			title: "Release checklist",
		});
	await expect(pinnedChecklist).toBeVisible();

	const beforeDuplicate = (await readSession(page))?.tabs.length ?? 0;
	await pinnedChecklist.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Duplicate tab", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.length)
		.toBe(beforeDuplicate + 1);
	const duplicateRows = (await readSession(page))?.tabs.filter(
		(tab) => tab.title === "Release checklist"
	);
	expect(duplicateRows).toHaveLength(2);
	expect(duplicateRows?.filter((tab) => tab.pinned)).toHaveLength(1);
	await page
		.getByRole("button", { name: "Close Release checklist", exact: true })
		.last()
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.length)
		.toBe(beforeDuplicate);

	await pinnedChecklist.click({ button: "right" });
	const unload = page.getByRole("menuitem", {
		name: "Unload tab",
		exact: true,
	});
	await expect(unload).toBeEnabled();
	await unload.click();
	await pinnedChecklist.click();
	await expect(pinnedChecklist).toHaveAttribute("data-active", "true");
	await pinnedChecklist.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Unload tab", exact: true })
	).toBeDisabled();
	await page.getByRole("menuitem", { name: "Unpin tab", exact: true }).click();
	await expect
		.poll(async () => {
			const session = await readSession(page);
			return (
				session?.tabs.find((tab) => tab.title === "Release checklist")
					?.pinned ?? false
			);
		})
		.toBe(false);
	await expect(
		page.getByRole("button", { name: "Release checklist", exact: true })
	).toBeVisible();
	const pinnedOverview = page.getByRole("button", {
		name: "Workspace overview",
		exact: true,
	});
	await pinnedOverview.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Close tab", exact: true }).click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.not.toContain("Workspace overview");
	await page
		.getByRole("button", { name: "Release checklist", exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Restore closed tab", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.toContain("Workspace overview");
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
	await page.screenshot({
		path: testInfo.outputPath("desktop-titlebar-pin-roundtrip.png"),
		fullPage: false,
	});
});

test("close-to-right preserves pinned tabs and the closed tab can be restored", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Close tabs after this one", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.toEqual(["Workspace overview", "Tab tear-out notes"]);
	await expect(page.getByRole("button", { name: "Draft brief" })).toHaveCount(
		0
	);

	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	const restore = page.getByRole("menuitem", {
		name: "Restore closed tab",
		exact: true,
	});
	await expect(restore).toBeEnabled();
	await restore.click();
	await expect.poll(async () => (await readSession(page))?.tabs.length).toBe(3);
	const restored = await readSession(page);
	expect(restored?.tabs.map((tab) => tab.title)).toContain("Draft brief");
	expect(
		restored?.tabs.find((tab) => tab.title === "Workspace overview")?.pinned
	).toBe(true);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Close other tabs", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.toEqual(["Workspace overview", "Tab tear-out notes"]);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Close other tabs", exact: true })
	).toBeDisabled();
	await expect(
		page.getByRole("menuitem", {
			name: "Close tabs before this one",
			exact: true,
		})
	).toBeDisabled();
	await page
		.getByRole("menuitem", { name: "Restore closed tab", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.toContain("Draft brief");
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-close-restore.png"),
		fullPage: false,
	});
});

test("TitleBar tab actions create and restore tabs and disable no-op bulk closes", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await openTitlebarContextMenu(page);
	await expect(
		page.getByRole("menuitem", { name: "Restore closed tab", exact: true })
	).toBeDisabled();
	await expect(
		page.getByRole("menuitem", {
			name: "Close tabs before this one",
			exact: true,
		})
	).toBeDisabled();
	await expect(
		page.getByRole("menuitem", {
			name: "Close tabs after this one",
			exact: true,
		})
	).toBeEnabled();
	await page.keyboard.press("Escape");

	await page
		.getByRole("button", { name: "Release checklist", exact: true })
		.click();
	await openTitlebarContextMenu(page);
	const closeLeft = page.getByRole("menuitem", {
		name: "Close tabs before this one",
		exact: true,
	});
	await expect(closeLeft).toBeEnabled();
	await closeLeft.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.toEqual(["Workspace overview", "Release checklist", "Draft brief"]);
	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitem", { name: "Restore closed tab", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.toContain("Tab tear-out notes");

	await page
		.getByRole("button", { name: "Release checklist", exact: true })
		.click();
	await openTitlebarContextMenu(page);
	const closeRight = page.getByRole("menuitem", {
		name: "Close tabs after this one",
		exact: true,
	});
	await expect(closeRight).toBeEnabled();
	await closeRight.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.toEqual(["Workspace overview", "Tab tear-out notes", "Release checklist"]);
	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitem", { name: "Restore closed tab", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.toContain("Draft brief");

	const originalCount = (await readSession(page))?.tabs.length ?? 0;
	await page.getByRole("button", { name: "New chat tab", exact: true }).click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.length)
		.toBe(originalCount + 1);
	let session = await readSession(page);
	const plusTab = session?.tabs.at(-1);
	expect(plusTab?.path).toBe("/chat");
	await page
		.getByRole("button", { name: `Close ${plusTab?.title}`, exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.length)
		.toBe(originalCount);

	await openTitlebarContextMenu(page);
	const restore = page.getByRole("menuitem", {
		name: "Restore closed tab",
		exact: true,
	});
	await expect(restore).toBeEnabled();
	await restore.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.length)
		.toBe(originalCount + 1);

	await openTitlebarContextMenu(page);
	await page.getByRole("menuitem", { name: "New tab", exact: true }).click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.length)
		.toBe(originalCount + 2);
	session = await readSession(page);
	expect(session?.tabs.at(-1)?.path).toBe("/chat");

	await openTitlebarContextMenu(page);
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-main-menu-actions.png"),
		fullPage: false,
	});
	await page
		.getByRole("menuitem", { name: "Close all tabs", exact: true })
		.click();
	await expect
		.poll(() =>
			page.evaluate(() => window.__readSealedLocalStorage("ryu_session_tabs"))
		)
		.toBeNull();
	await openTitlebarContextMenu(page);
	await expect(
		page.getByRole("menuitem", { name: "Close all tabs", exact: true })
	).toBeDisabled();
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
});

test("regular tab duplicate, native new-window, unload, and middle-close actions work", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	const checklist = page.getByRole("button", {
		name: "Release checklist",
		exact: true,
	});
	const initialCount = (await readSession(page))?.tabs.length ?? 0;
	await checklist.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Duplicate tab", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.length)
		.toBe(initialCount + 1);
	expect(
		(await readSession(page))?.tabs.filter(
			(tab) => tab.title === "Release checklist"
		)
	).toHaveLength(2);
	await page
		.getByRole("button", { name: "Close Release checklist", exact: true })
		.last()
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.length)
		.toBe(initialCount);

	await checklist.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Open in new window", exact: true })
		.click();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const host = window.__titlebarHost;
				return host.calls
					.filter((call) => call.command === "open_tab_window")
					.at(-1)?.args;
			})
		)
		.toEqual({
			entityKey: null,
			path: "/artifact/checklist",
			conversationId: null,
			node: null,
			title: "Release checklist",
		});

	await checklist.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Unload tab", exact: true }).click();
	const tabSurface = page
		.locator('[data-tab-appearance][draggable="true"]')
		.filter({ hasText: "Release checklist" });
	await expect(tabSurface).toHaveClass(/opacity-60/u);
	await checklist.click();
	await expect(tabSurface).not.toHaveClass(/opacity-60/u);
	await expect(
		page
			.frameLocator('iframe[title="Release checklist"]')
			.getByText("TITLEBAR-ACTIONS-01")
	).toBeVisible();
	await checklist.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Unload tab", exact: true })
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-regular-tab-actions.png"),
		fullPage: false,
	});

	await checklist.click({ button: "middle" });
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.not.toContain("Release checklist");
	const noteTab = page.getByRole("button", {
		name: "Tab tear-out notes",
		exact: true,
	});
	await noteTab.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Restore closed tab", exact: true })
	).toBeEnabled();
	await page
		.getByRole("menuitem", { name: "Restore closed tab", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.toContain("Release checklist");
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
});

test("regular tab Move to new window transfers its artifact before removing the source", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Move tab to new window", exact: true })
		.click();

	await expect
		.poll(async () =>
			(await readNativeCalls(page)).filter(
				(call) => call.command === "open_tab_window"
			)
		)
		.toHaveLength(1);
	const moveRequest = (await readNativeCalls(page)).find(
		(call) => call.command === "open_tab_window"
	);
	expect(moveRequest?.args).toMatchObject({
		conversationId: null,
		dragOut: false,
		entityKey: null,
		node: "local",
		path: "/artifact/notes",
		title: "Tab tear-out notes",
		transfer: {
			artifact: {
				id: "notes",
				kind: "html",
				sourceMessageId: "titlebar-actions-fixture",
				title: "Tab tear-out notes",
			},
			node: "local",
			tab: {
				path: "/artifact/notes",
				title: "Tab tear-out notes",
			},
			version: 1,
		},
	});
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.not.toContain("Tab tear-out notes");
	await expect(
		page.getByRole("button", { name: "Tab tear-out notes", exact: true })
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Release checklist", exact: true })
		.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Restore closed tab", exact: true })
	).toBeDisabled();
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
});

test("a pinned tab can move to a new window without returning to closed-tab history", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	const checklist = page.getByRole("button", {
		name: "Release checklist",
		exact: true,
	});
	await checklist.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Pin tab", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await readSession(page))?.tabs.find(
					(tab) => tab.title === "Release checklist"
				)?.pinned
		)
		.toBe(true);

	await checklist.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Move tab to new window", exact: true })
		.click();
	await expect
		.poll(async () =>
			(await readNativeCalls(page)).filter(
				(call) => call.command === "open_tab_window"
			)
		)
		.toHaveLength(1);
	const moveRequest = (await readNativeCalls(page)).find(
		(call) => call.command === "open_tab_window"
	);
	expect(moveRequest?.args).toMatchObject({
		dragOut: false,
		path: "/artifact/checklist",
		title: "Release checklist",
		transfer: {
			tab: {
				path: "/artifact/checklist",
				pinned: true,
				title: "Release checklist",
			},
			version: 1,
		},
	});
	await expect
		.poll(async () => (await readSession(page))?.tabs.map((tab) => tab.title))
		.not.toContain("Release checklist");
	await expect(
		page.getByRole("button", { name: "Release checklist", exact: true })
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Restore closed tab", exact: true })
	).toBeDisabled();
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
});
