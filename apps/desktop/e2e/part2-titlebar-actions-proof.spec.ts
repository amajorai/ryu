// Continues titlebar-actions-proof.spec.ts (split under the file token limit); helpers live in titlebar-actions-proof.helpers.ts.

import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	EVIDENCE,
	openNonHorizontalTitlebarContextMenu,
	openTitlebarContextMenu,
	openWorkspace,
	readNativeCalls,
	readSession,
	showTitlebar,
} from "./titlebar-actions-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

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
