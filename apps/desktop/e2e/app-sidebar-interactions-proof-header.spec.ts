import { expect, test } from "@playwright/test";
import { sidebarStringsSchema } from "./app-sidebar-interactions-proof.contracts.ts";
import {
	activeTabPath,
	fixtureFor,
	openChromeContextMenu,
	openGlobalContextMenu,
	openRowContextMenu,
	registerAppSidebarProofHooks,
	storageValue,
	tabs,
} from "./app-sidebar-interactions-proof.fixture.ts";
import {
	EVIDENCE_DIRECTORY,
	STORY_URL,
} from "./app-sidebar-interactions-proof.fixture-data.ts";

registerAppSidebarProofHooks();

test("header navigation context menus open routes and windows, reorder and hide buttons, and restore visibility", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=tabs,channels&auth=off&mode=sections&seed=${Date.now()}`
	);
	const libraryButton = page
		.getByTestId("sidebar-header-actions")
		.getByRole("button", { name: "Library", exact: true });
	await expect(libraryButton).toBeVisible();
	await page.getByRole("button", { name: "Library", exact: true }).click();
	await expect.poll(() => activeTabPath(page)).toBe("/library");

	let menu = await openChromeContextMenu(page, "Library");
	await menu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.filter((tab) => tab.path === "/library").length;
		})
		.toBe(2);

	menu = await openChromeContextMenu(page, "Library");
	await menu
		.getByRole("menuitem", { name: "Open in new window", exact: true })
		.click();
	let nativeCalls = await page.evaluate(
		() =>
			/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
				.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
	);
	expect(nativeCalls).toContainEqual({
		args: {
			conversationId: null,
			entityKey: null,
			node: null,
			path: "/library",
			title: "Library",
		},
		command: "open_tab_window",
	});

	menu = await openChromeContextMenu(page, "Library");
	await menu.getByRole("menuitem", { name: "Move up", exact: true }).click();
	const chromeOrder = sidebarStringsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu:sidebar-chrome-order") ?? "[]")
		)
	);
	expect(chromeOrder.indexOf("library")).toBeGreaterThan(0);
	expect(chromeOrder.indexOf("library")).toBeLessThan(
		chromeOrder.indexOf("store")
	);

	const headerActions = page.getByTestId("sidebar-header-actions");
	const newChatShell = headerActions
		.getByRole("button", { name: "New chat", exact: true })
		.locator("xpath=../..");
	const computeShell = headerActions
		.getByRole("button", { name: "Compute", exact: true })
		.locator("xpath=../..");
	await expect(newChatShell).toHaveAttribute("draggable", "true");
	await newChatShell.dragTo(computeShell);
	const draggedChromeOrder = sidebarStringsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu:sidebar-chrome-order") ?? "[]")
		)
	);
	expect(draggedChromeOrder.indexOf("new-chat")).toBe(
		draggedChromeOrder.indexOf("compute") + 1
	);

	menu = await openChromeContextMenu(page, "Library");
	await menu
		.getByRole("menuitem", { name: "Hide Library", exact: true })
		.click();
	await expect
		.poll(async () => {
			const hidden = await storageValue(page, "ryu:sidebar-hidden-chrome");
			return sidebarStringsSchema.parse(JSON.parse(hidden ?? "[]"));
		})
		.toContain("library");
	await expect(
		page.getByTestId("sidebar-header-actions").getByRole("button", {
			name: "Library",
			exact: true,
		})
	).toHaveCount(0);

	menu = await openGlobalContextMenu(page);
	await menu
		.getByRole("menuitem", { name: "Customize sidebar", exact: true })
		.click();
	const customize = page.getByRole("dialog", { name: "Customize sidebar" });
	await expect(customize).toBeVisible();
	const libraryRow = customize
		.getByText("Library", { exact: true })
		.locator("xpath=../..");
	await libraryRow.getByRole("button", { name: "Show button" }).click();
	await expect
		.poll(async () => {
			const hidden = await storageValue(page, "ryu:sidebar-hidden-chrome");
			return sidebarStringsSchema.parse(JSON.parse(hidden ?? "[]"));
		})
		.not.toContain("library");
	await customize.getByRole("button", { name: "Done", exact: true }).click();
	await expect(libraryButton).toBeVisible();

	await page
		.getByTestId("sidebar-header-actions")
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page.getByTestId("chat-state")).toContainText("sidebar-new-");
	await expect.poll(() => activeTabPath(page)).toBe("/chat");
	nativeCalls = await page.evaluate(
		() =>
			/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
				.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
	);
	expect(
		nativeCalls.filter((call) => call.command === "open_tab_window")
	).toHaveLength(1);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-header-navigation.png`,
		animations: "disabled",
	});
});

test("all remaining built-in header destinations open exact routes, tabs, and native requests", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=tabs&auth=off&mode=sections&seed=${Date.now()}`
	);
	const routes = [
		["Compute", "/compute"],
		["Share", "/share"],
		["Customize", "/store"],
	] as const;
	for (const [title, path] of routes) {
		const button = page
			.getByTestId("sidebar-header-actions")
			.getByRole("button", { name: title, exact: true });
		await expect(button).toBeVisible();
		await button.click();
		await expect.poll(() => activeTabPath(page)).toBe(path);

		const menu = await openChromeContextMenu(page, title);
		await expect(
			menu.getByRole("menuitem", { name: "Move down", exact: true })
		).toBeVisible();
		if (title === "Compute") {
			const before = (
				await page
					.getByTestId("sidebar-header-actions")
					.locator("button")
					.allTextContents()
			).map((label) => label.trim());
			await menu
				.getByRole("menuitem", { name: "Move down", exact: true })
				.click();
			const after = (
				await page
					.getByTestId("sidebar-header-actions")
					.locator("button")
					.allTextContents()
			).map((label) => label.trim());
			expect(after.indexOf(title), JSON.stringify({ before, after })).toBe(
				before.indexOf(title) + 1
			);
		}
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();

		const newTabMenu = await openChromeContextMenu(page, title);
		const beforeTabs = await tabs(page);
		const beforeCount = beforeTabs.tabs.filter(
			(tab) => tab.path === path
		).length;
		await newTabMenu
			.getByRole("menuitem", { name: "Open in new tab", exact: true })
			.click();
		await expect
			.poll(
				async () =>
					(await tabs(page)).tabs.filter((tab) => tab.path === path).length
			)
			.toBe(beforeCount + 1);
		const newWindowMenu = await openChromeContextMenu(page, title);
		await newWindowMenu
			.getByRole("menuitem", { name: "Open in new window", exact: true })
			.click();
		const nativeCalls = await page.evaluate(
			() =>
				/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
					.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
		);
		expect(nativeCalls).toContainEqual({
			args: {
				conversationId: null,
				entityKey: null,
				node: null,
				path,
				title,
			},
			command: "open_tab_window",
		});
	}

	const newChatMenu = await openChromeContextMenu(page, "New chat");
	await expect(
		newChatMenu.getByRole("menuitem", { name: "Hide New chat", exact: true })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(newChatMenu).toBeHidden();
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-header-nav-targets.png`,
		animations: "disabled",
	});
});

test("contributed sidebar row, declarative create/action, mode, button route, and native request use exact local fixtures", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=plugin:proof-app:proof-records&auth=off&seed=${Date.now()}`
	);
	await expect(page.getByText("Proof record A", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: /Proof record A/ }).click();
	await expect
		.poll(async () => (await tabs(page)).tabs.at(-1)?.path)
		.toBe("/proof/records/proof-record-a");
	await expect
		.poll(async () => (await tabs(page)).tabs.at(-1)?.title)
		.toBe("Proof record A");
	const recordRow = page
		.getByRole("button", { name: /Proof record A/ })
		.first();
	await recordRow.focus();
	await recordRow.press("Enter");
	await expect
		.poll(() => activeTabPath(page))
		.toBe("/proof/records/proof-record-a");

	const recordMenu = await openRowContextMenu(page, "Proof record A");
	await recordMenu
		.getByRole("menuitem", { name: "Archive proof record", exact: true })
		.click();
	await expect
		.poll(() =>
			fixtureFor(page).requests.some(
				(request) =>
					request.method === "POST" &&
					request.path === "/api/proof/records/proof-record-a/archive" &&
					JSON.stringify(request.body) ===
						JSON.stringify({ record_id: "proof-record-a" })
			)
		)
		.toBe(true);

	const recordPath = "/proof/records/proof-record-a";
	const tabsBeforeNewRecord = await tabs(page);
	const newTabMenu = await openRowContextMenu(page, "Proof record A");
	await newTabMenu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await tabs(page)).tabs.filter((tab) => tab.path === recordPath).length
		)
		.toBe(
			tabsBeforeNewRecord.tabs.filter((tab) => tab.path === recordPath).length +
				1
		);
	const newWindowMenu = await openRowContextMenu(page, "Proof record A");
	await newWindowMenu
		.getByRole("menuitem", { name: "Open in new window", exact: true })
		.click();
	const recordNativeCalls = await page.evaluate(
		() =>
			/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
				.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
	);
	expect(recordNativeCalls).toContainEqual({
		args: {
			conversationId: null,
			entityKey: null,
			node: null,
			path: recordPath,
			title: "Proof record A",
		},
		command: "open_tab_window",
	});
	const inspectMenu = await openRowContextMenu(page, "Proof record A");
	await inspectMenu
		.getByRole("menuitem", { name: "Inspect record", exact: true })
		.click();
	expect(fixtureFor(page).requests).toContainEqual({
		body: {
			args: { record_id: "proof-record-a", source: "sidebar" },
			method: "proof.inspect-record",
		},
		method: "POST",
		path: "/api/plugins/proof-app/host",
	});

	await page
		.getByRole("button", { name: "Create proof record", exact: true })
		.click();
	await expect
		.poll(async () => (await tabs(page)).tabs.at(-1)?.path)
		.toBe("/proof/records/proof-record-created");
	expect(
		fixtureFor(page).requests.filter(
			(request) =>
				request.method === "POST" && request.path === "/api/proof/records"
		)
	).toContainEqual({
		body: { name: "Created proof record" },
		method: "POST",
		path: "/api/proof/records",
	});

	let menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Proof mode", exact: true }).click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-mode"))
		.toBe("plugin:proof-app:proof-mode");
	await expect(
		page.getByRole("button", { name: /Proof record B/ }).first()
	).toBeVisible();

	const proofHome = page.getByRole("button", {
		name: "Proof home",
		exact: true,
	});
	await proofHome.click();
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.find((tab) => tab.id === state.activeTabId)?.path;
		})
		.toBe("/proof/home");
	menu = await openChromeContextMenu(page, "Proof home");
	await menu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.find((tab) => tab.id === state.activeTabId)?.path;
		})
		.toBe("/proof/home");
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.filter((tab) => tab.path === "/proof/home").length;
		})
		.toBe(2);

	menu = await openChromeContextMenu(page, "Proof home");
	await menu
		.getByRole("menuitem", { name: "Open in new window", exact: true })
		.click();
	const nativeCalls = await page.evaluate(
		() =>
			/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
				.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
	);
	expect(nativeCalls).toContainEqual({
		args: {
			conversationId: null,
			entityKey: null,
			node: null,
			path: "/proof/home",
			title: "Proof home",
		},
		command: "open_tab_window",
	});

	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-contributed-section.png`,
		animations: "disabled",
	});
});
