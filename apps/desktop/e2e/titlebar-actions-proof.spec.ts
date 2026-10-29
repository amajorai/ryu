import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	parseTitlebarSession,
	type TitlebarFixtureHooks,
} from "./titlebar-fixture-contract.ts";

test.describe.configure({ timeout: 120_000 });

const EVIDENCE = path.resolve(
	process.cwd(),
	"../../docs/proof/test-coverage-sweep-20260924/evidence"
);

// The harness installs these immutable hooks before rendering the workspace.
declare global {
	interface Window extends TitlebarFixtureHooks {}
}

async function installBackendFixture(page: Page) {
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin === "http://127.0.0.1:5177") {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({
				error: "TitleBar proof fixture: Core unavailable",
			}),
		});
	});
}

async function openWorkspace(page: Page, url = "/titlebar-actions-proof.html") {
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (
			message.type() === "error" &&
			!message.text().includes("server responded with a status of 503")
		) {
			consoleErrors.push(message.text());
		}
	});
	await installBackendFixture(page);
	await page.goto(url, { waitUntil: "domcontentloaded" });
	const notice = page.getByRole("button", { name: "Got it", exact: true });
	if (await notice.count()) {
		await notice.click();
	}
	await expect(
		page.locator('[data-tab-appearance][draggable="true"]')
	).toHaveCount(url.includes("rename=1") ? 4 : 3);
	await expect(
		page.getByRole("button", { name: "Workspace overview", exact: true })
	).toBeVisible();
	return { consoleErrors, pageErrors };
}

async function readSession(page: Page) {
	return parseTitlebarSession(
		await page.evaluate(() => localStorage.getItem("ryu_session_tabs"))
	);
}

async function showTitlebar(page: Page) {
	const titlebar = page
		.locator("div[data-tab-appearance][data-tauri-drag-region]")
		.first();
	if (
		await titlebar.evaluate(
			(element) => getComputedStyle(element).opacity === "0"
		)
	) {
		const peekZone = page.locator(
			'[aria-hidden="true"][class~="h-4"][class~="w-full"]'
		);
		const box = await peekZone.boundingBox();
		if (!box) {
			throw new Error("Auto-hide top-edge reveal zone is not visible");
		}
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	}
	await expect(titlebar).toHaveCSS("opacity", "1");
}

async function openTitlebarContextMenu(page: Page) {
	await showTitlebar(page);
	const newTab = page.getByRole("button", {
		name: "New chat tab",
		exact: true,
	});
	await newTab.click({ button: "right" });
}

async function openNonHorizontalTitlebarContextMenu(page: Page) {
	await showTitlebar(page);
	const titlebar = page
		.locator("div[data-tab-appearance][data-tauri-drag-region]")
		.first();
	const trigger = titlebar.locator(
		'[data-slot="context-menu-trigger"][data-tauri-drag-region]'
	);
	await expect(trigger).toHaveCount(1);
	if (!(await trigger.isVisible())) {
		const layout = await trigger.evaluate((element) => {
			const describe = (node: Element | null) => {
				if (!node) {
					return null;
				}
				const style = getComputedStyle(node);
				const rect = node.getBoundingClientRect();
				return {
					className: node.getAttribute("class"),
					display: style.display,
					height: rect.height,
					opacity: style.opacity,
					width: rect.width,
				};
			};
			return [
				describe(element),
				describe(element.parentElement),
				describe(element.parentElement?.parentElement ?? null),
			];
		});
		throw new Error(`Non-horizontal trigger layout: ${JSON.stringify(layout)}`);
	}
	await trigger.click({ button: "right" });
	await expect(
		page.getByRole("menuitemcheckbox", {
			name: "Auto-hide title bar",
			exact: true,
		})
	).toBeVisible();
	return titlebar;
}

async function readNativeCalls(page: Page) {
	return page.evaluate(() => {
		const host = window.__titlebarHost;
		return host.calls;
	});
}

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
		.getByRole("menuitem", { name: "Close tabs to the right", exact: true })
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
		page.getByRole("menuitem", { name: "Close tabs to the left", exact: true })
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
		page.getByRole("menuitem", { name: "Close tabs to the left", exact: true })
	).toBeDisabled();
	await expect(
		page.getByRole("menuitem", { name: "Close tabs to the right", exact: true })
	).toBeEnabled();
	await page.keyboard.press("Escape");

	await page
		.getByRole("button", { name: "Release checklist", exact: true })
		.click();
	await openTitlebarContextMenu(page);
	const closeLeft = page.getByRole("menuitem", {
		name: "Close tabs to the left",
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
		name: "Close tabs to the right",
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
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_session_tabs")))
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

test("the vertical and scroll tab layouts retain their alternate titlebar context menu", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await openTitlebarContextMenu(page);
	const verticalTabs = page.getByRole("menuitemradio", {
		name: "Vertical tabs",
		exact: true,
	});
	await verticalTabs.focus();
	await page.keyboard.press("Enter");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_tab_layout")))
		.toBe("vertical");
	// The tab-view radio leaves this context menu open after applying its value.
	// Close the old menu before using the alternate blank-region trigger.
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("menuitemradio", { name: "Vertical tabs", exact: true })
	).toHaveCount(0);

	let titlebar = await openNonHorizontalTitlebarContextMenu(page);
	const autoHide = page.getByRole("menuitemcheckbox", {
		name: "Auto-hide title bar",
		exact: true,
	});
	await expect(autoHide).toHaveAttribute("aria-checked", "false");
	await autoHide.click();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:auto-hide-titlebar"))
		)
		.toBe("true");
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("menuitemcheckbox", {
			name: "Auto-hide title bar",
			exact: true,
		})
	).toHaveCount(0);

	titlebar = await openNonHorizontalTitlebarContextMenu(page);
	await expect(autoHide).toHaveAttribute("aria-checked", "true");
	await page.mouse.move(600, 120);
	await expect(titlebar).toHaveCSS("opacity", "1");
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("menuitemcheckbox", {
			name: "Auto-hide title bar",
			exact: true,
		})
	).toHaveCount(0);
	await expect(titlebar).toHaveCSS("opacity", "0");

	await showTitlebar(page);
	await openNonHorizontalTitlebarContextMenu(page);
	await expect(
		page.getByRole("menuitem", { name: "Enter full screen", exact: true })
	).toBeVisible();
	await page
		.getByRole("menuitem", { name: "Enter full screen", exact: true })
		.click();
	await expect
		.poll(async () =>
			(await readNativeCalls(page)).filter(
				(call) => call.command === "toggle_fullscreen"
			)
		)
		.toHaveLength(1);
	await expect
		.poll(() => page.evaluate(() => window.__titlebarHost.fullscreen))
		.toBe(true);
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("menuitem", { name: "Exit full screen", exact: true })
	).toHaveCount(0);

	await showTitlebar(page);
	await openNonHorizontalTitlebarContextMenu(page);
	await page
		.getByRole("menuitem", { name: "Exit full screen", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => window.__titlebarHost.fullscreen))
		.toBe(false);
	await page.keyboard.press("Escape");

	await openNonHorizontalTitlebarContextMenu(page);
	const scrollableTabs = page.getByRole("menuitemradio", {
		name: "Scrollable tabs",
		exact: true,
	});
	await scrollableTabs.focus();
	await page.keyboard.press("Enter");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_tab_layout")))
		.toBe("scroll");
	await expect(page.getByTestId("scrollable-tabs-view")).toBeVisible();
	await page.keyboard.press("Escape");

	await openNonHorizontalTitlebarContextMenu(page);
	await expect(
		page.getByRole("menuitemradio", { name: "Scrollable tabs", exact: true })
	).toHaveAttribute("aria-checked", "true");
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-non-horizontal-menu.png"),
		fullPage: false,
	});
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
});

test("renamable chat tab commits a trimmed title and preserves it after reload", async ({
	page,
}) => {
	const errors = await openWorkspace(
		page,
		"/titlebar-actions-proof.html?rename=1"
	);
	const originalTitle = page.getByRole("button", {
		name: "Original discussion",
		exact: true,
	});
	await expect(originalTitle).toBeVisible();

	await originalTitle.dblclick();
	const canceledInput = page.getByRole("textbox").last();
	await canceledInput.fill("Canceled title");
	await canceledInput.press("Escape");
	await expect(originalTitle).toBeVisible();

	await originalTitle.dblclick();
	const blankInput = page.getByRole("textbox").last();
	await blankInput.fill("   ");
	await blankInput.press("Enter");
	await expect(originalTitle).toBeVisible();
	const noWriteRequests = await page.evaluate(() =>
		window.__getRenameRequests()
	);
	expect(noWriteRequests).toEqual([]);

	await originalTitle.dblclick();
	const renameInput = page.getByRole("textbox").last();
	await renameInput.fill("  Renamed discussion  ");
	await renameInput.press("Enter");
	await expect(
		page.getByRole("button", { name: "Renamed discussion", exact: true })
	).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.__getRenameRequests()))
		.toEqual([
			{
				body: { title: "Renamed discussion" },
				method: "POST",
				path: "/api/conversations/conversation-rename-fixture/title",
			},
		]);
	await expect
		.poll(
			async () =>
				(await readSession(page))?.tabs.find(
					(tab) => tab.conversationId === "conversation-rename-fixture"
				)?.title
		)
		.toBe("Renamed discussion");
	await page.reload({ waitUntil: "domcontentloaded" });
	const notice = page.getByRole("button", { name: "Got it", exact: true });
	if (await notice.count()) {
		await notice.click();
	}
	await expect(
		page.getByRole("button", { name: "Renamed discussion", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click();
	await expect(
		page
			.frameLocator('iframe[title="Tab tear-out notes"]')
			.getByText("TITLEBAR-ACTIONS-01")
	).toBeVisible();
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-chat-rename.png"),
		fullPage: false,
	});
});

test("TitleBar view and appearance settings persist and drive the actual tab surfaces", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitem", { name: "Use fixed-width tabs", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_tab_sizing")))
		.toBe("fixed");
	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitem", { name: "Fit tabs to width", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_tab_sizing")))
		.toBe("fit");

	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitemcheckbox", {
			name: "Show tabs as a dropdown",
			exact: true,
		})
		.click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:tab-dropdown")))
		.toBe("true");
	await expect(
		page.getByRole("button", { name: "Open tabs", exact: true })
	).toBeVisible();
	await openTitlebarContextMenu(page);
	const tabSearchOption = page.getByRole("menuitemcheckbox", {
		name: "Show tab search button",
		exact: true,
	});
	await expect(tabSearchOption).toBeDisabled();
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open tabs", exact: true }).click();
	const search = page.getByPlaceholder("Search open tabs…");
	await expect(search).toBeVisible();
	await expect(page.getByRole("option")).toHaveCount(4);
	await search.fill("Draft brief");
	await expect(page.getByRole("option")).toHaveCount(1);
	await page.getByRole("option").click({ force: true });
	await expect
		.poll(async () => {
			const session = await readSession(page);
			return session?.tabs[session.activeIndex]?.title;
		})
		.toBe("Draft brief");
	const countBeforeDropdownPlus = (await readSession(page))?.tabs.length ?? 0;
	await page.getByRole("button", { name: "New chat tab", exact: true }).click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.length)
		.toBe(countBeforeDropdownPlus + 1);
	const dropdownCreatedTab = (await readSession(page))?.tabs.at(-1);
	expect(dropdownCreatedTab?.path).toBe("/chat");
	await page.getByRole("button", { name: "Open tabs", exact: true }).click();
	await page
		.getByRole("button", {
			name: `Close ${dropdownCreatedTab?.title}`,
			exact: true,
		})
		.click();
	await expect
		.poll(async () => (await readSession(page))?.tabs.length)
		.toBe(countBeforeDropdownPlus);

	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitemcheckbox", {
			name: "Show tabs as a dropdown",
			exact: true,
		})
		.click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:tab-dropdown")))
		.toBe("false");
	await expect(
		page.getByRole("button", { name: "Search open tabs", exact: true })
	).toBeVisible();
	await openTitlebarContextMenu(page);
	const showSearch = page.getByRole("menuitemcheckbox", {
		name: "Show tab search button",
		exact: true,
	});
	await expect(showSearch).toBeEnabled();
	await showSearch.click();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:tab-search-button"))
		)
		.toBe("false");
	await expect(
		page.getByRole("button", { name: "Search open tabs", exact: true })
	).toHaveCount(0);
	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitemcheckbox", {
			name: "Show tab search button",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("button", { name: "Search open tabs", exact: true })
	).toBeVisible();

	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitemcheckbox", { name: "Floating tab pills", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:floating-tabs")))
		.toBe("false");
	await expect(page.locator('[data-tab-appearance="morphing"]')).toHaveCount(4);
	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitemcheckbox", { name: "Floating tab pills", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:floating-tabs")))
		.toBe("true");

	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitem", { name: "Split active tab", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.length)
		.toBe(1);
	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitem", { name: "Unsplit active tab", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.length ?? 0)
		.toBe(0);
	await openTitlebarContextMenu(page);
	await page
		.getByRole("menuitemradio", { name: "Scrollable tabs", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_tab_layout")))
		.toBe("scroll");
	await expect(page.getByTestId("scrollable-tabs-view")).toBeVisible();
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
	await page.screenshot({
		path: path.join(EVIDENCE, "desktop-titlebar-scrollable-view.png"),
		fullPage: false,
	});
});

test("regular tab context view control switches to the scrollable surface", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitemradio", { name: "Scrollable tabs", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_tab_layout")))
		.toBe("scroll");
	await expect(page.getByTestId("scrollable-tabs-view")).toBeVisible();
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
});

test("pinned tab context view control switches to the scrollable surface", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await page
		.getByRole("button", { name: "Workspace overview", exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitemradio", { name: "Scrollable tabs", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_tab_layout")))
		.toBe("scroll");
	await expect(page.getByTestId("scrollable-tabs-view")).toBeVisible();
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
});

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
	await expect(groupHeader).toHaveClass(/purple/u);
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
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Split view" }).hover();
	await page
		.getByRole("menuitem", { name: "Add new chat to split", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.[0]?.c?.length)
		.toBe(4);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Split view" }).hover();
	await page
		.getByRole("menuitem", { name: "Remove from split", exact: true })
		.click();
	await expect
		.poll(async () => (await readSession(page))?.splits?.[0]?.c?.length)
		.toBe(3);
	await page
		.getByRole("button", { name: "Draft brief", exact: true })
		.click({ button: "right" });
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

test("Open in side panel queues a non-chat tab and opens it when a chat is focused", async ({
	page,
}) => {
	const errors = await openWorkspace(page);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Open in side panel", exact: true })
		.click();
	await expect(
		page.getByText("Queued for the side panel", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("It opens when you switch to a chat tab.", { exact: true })
	).toBeVisible();
	const queuedRoute = await page.evaluate(() =>
		window.__getPendingSidePanelRoute()
	);
	expect(queuedRoute).toMatchObject({
		kind: "route:/artifact/notes",
		label: "Tab tear-out notes",
		nonce: 1,
	});

	await page.getByRole("button", { name: "New chat tab", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => window.__getPendingSidePanelRoute()))
		.toBeNull();
	await expect(
		page.getByRole("button", { name: "Tab tear-out notes", exact: true })
	).toHaveCount(2);
	expect(errors.pageErrors).toEqual([]);
	expect(errors.consoleErrors).toEqual([]);
	await expect(
		page
			.frameLocator('iframe[title="Tab tear-out notes"]:visible')
			.getByText("TITLEBAR-ACTIONS-01")
	).toBeVisible();
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
