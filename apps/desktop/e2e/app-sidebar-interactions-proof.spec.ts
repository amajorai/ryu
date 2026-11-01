import { expect, test } from "@playwright/test";
import { DEFAULT_SECTION_ORDER } from "../src/components/layout/sidebar-sections.ts";
import { sidebarStringsSchema } from "./app-sidebar-interactions-proof.contracts.ts";
import {
	activeTabPath,
	fixtureFor,
	openGlobalContextMenu,
	registerAppSidebarProofHooks,
	storageValue,
	tabs,
} from "./app-sidebar-interactions-proof.fixture.ts";
import {
	DEFAULT_PROOF_HIDDEN_CHROME,
	DEFAULT_PROOF_HIDDEN_SECTIONS,
	EVIDENCE_DIRECTORY,
	STORY_URL,
} from "./app-sidebar-interactions-proof.fixture-data.ts";

registerAppSidebarProofHooks();

test("mounts the production AppSidebar with stateful local Core fixtures", async ({
	page,
}) => {
	const channelRead = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/channels" &&
			response.request().method() === "GET" &&
			response.ok()
	);
	await page.goto(
		`${STORY_URL}?focus=channels,agents,chats,integrations,identities,skills,mcp,tools,plugins,engines&seed=${Date.now()}`
	);
	await channelRead;
	try {
		await expect(page.getByTestId("tab-state")).toBeVisible();
	} catch (error) {
		throw new Error(
			"AppSidebar proof did not mount: " +
				(await page.locator("body").innerText()),
			{ cause: error }
		);
	}

	await expect(page.getByTestId("chat-state")).toContainText("chat-loose");
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();
	const sidebarText = await page.getByTestId("app-sidebar-mount").innerText();
	if (!sidebarText.includes("Proof Telegram")) {
		const storage = await page.evaluate(() => ({
			hiddenChrome: localStorage.getItem("ryu:sidebar-hidden-chrome"),
			hiddenSections: localStorage.getItem("ryu:sidebar-hidden-sections"),
			mode: localStorage.getItem("ryu:sidebar-mode"),
			productMode: localStorage.getItem("ryu:product-mode"),
		}));
		throw new Error(
			"Channel fixture did not render: " +
				JSON.stringify({
					requests: fixtureFor(page).requests.map((request) => ({
						method: request.method,
						path: request.path,
					})),
					storage,
					sidebarText,
				})
		);
	}
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();
	await expect(page.getByText("Proof skill", { exact: true })).toBeVisible();
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-populated-sections.png`,
		animations: "disabled",
	});
	expect(fixtureFor(page).requests.length).toBeGreaterThan(0);
});

test("production sidebar proof fixture is reachable", async ({ page }) => {
	await page.goto(`${STORY_URL}?seed=${Date.now()}`);
	await expect(page.getByTestId("tab-state")).toBeVisible();
});

test("sidebar-wide mode, appearance, tab view, and collapse actions persist through real context menu", async ({
	page,
}) => {
	const channelRead = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/channels" &&
			response.request().method() === "GET" &&
			response.ok()
	);
	await page.goto(
		`${STORY_URL}?focus=tabs,agents,chats,channels,skills,plugin:proof-app:proof-records&seed=${Date.now()}`
	);
	await channelRead;
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();

	const initialTabs = await tabs(page);
	await page.getByRole("button", { name: "New tab", exact: true }).click();
	await expect
		.poll(async () => (await tabs(page)).tabs.length)
		.toBe(initialTabs.tabs.length + 1);
	await expect.poll(() => activeTabPath(page)).toBe("/chat");

	let menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Tabbed sidebar" }).click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-mode"))
		.toBe("tabbed");
	const sectionTabs = page.getByRole("tablist", { name: "Sidebar sections" });
	await expect(sectionTabs).toBeVisible();
	await sectionTabs.getByRole("tab", { name: "Channels", exact: true }).click();
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();
	await expect(
		sectionTabs.getByRole("tab", { name: "Channels", exact: true })
	).toHaveAttribute("aria-selected", "true");

	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Agents view" }).click();
	await expect.poll(() => storageValue(page, "ryu:sidebar-mode")).toBe("agent");
	await expect(page.getByText("Agent Alpha", { exact: true })).toBeVisible();
	// Agent rows are one line since 306ce31b7f: the latest-message preview
	// lives in the name's tooltip, not on a second row line.
	await expect(page.getByTestId("agent-chat-preview-agent-alpha")).toHaveCount(
		0
	);
	await page.getByText("Agent Alpha", { exact: true }).hover();
	await expect(
		page.getByTestId("agent-chat-preview-agent-alpha")
	).toBeVisible();
	await page.mouse.move(0, 0);

	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Floating" }).click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-variant"))
		.toBe("floating");
	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Inset" }).click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-variant"))
		.toBe("inset");

	menu = await openGlobalContextMenu(page);
	await menu
		.getByRole("menuitemcheckbox", { name: "Group lists by date" })
		.click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-group-chats-by-date"))
		.toBe("true");
	menu = await openGlobalContextMenu(page);
	await menu
		.getByRole("menuitemcheckbox", { name: "Projects & Spaces as pickers" })
		.click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-grouped-nav"))
		.toBe("false");
	menu = await openGlobalContextMenu(page);
	await menu
		.getByRole("menuitemcheckbox", { name: "Show latest message / tool state" })
		.click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-chat-preview"))
		.toBe("true");
	menu = await openGlobalContextMenu(page);
	await menu
		.getByRole("menuitemcheckbox", {
			name: "Search section overflow in a popover",
		})
		.click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-overflow-popover"))
		.toBe("true");

	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitemradio", { name: "Infinite canvas" }).click();
	await expect.poll(() => storageValue(page, "ryu_tab_layout")).toBe("canvas");
	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitemradio", { name: "Vertical tabs" }).click();
	await expect
		.poll(() => storageValue(page, "ryu_tab_layout"))
		.toBe("vertical");

	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Sections", exact: true }).click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-mode"))
		.toBe("sections");

	const sectionOrderBefore = sidebarStringsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu:sidebar-section-order") ?? "[]")
		)
	);
	await page
		.locator("#sidebar-sec-tabs")
		.getByRole("button", { name: "Tabs", exact: true })
		.dragTo(page.locator("#sidebar-sec-channels"));
	const sectionOrderAfter = sidebarStringsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu:sidebar-section-order") ?? "[]")
		)
	);
	expect(sectionOrderAfter.indexOf("tabs")).toBeGreaterThan(
		sectionOrderBefore.indexOf("tabs")
	);
	expect(sectionOrderAfter.indexOf("tabs")).toBeGreaterThan(
		sectionOrderAfter.indexOf("channels")
	);

	await page
		.locator("#sidebar-sec-channels")
		.getByRole("button", { name: "Channels", exact: true })
		.click();
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeHidden();
	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Expand all sections" }).click();
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-expanded-sections.png`,
		animations: "disabled",
	});

	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Collapse all sections" }).click();
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeHidden();
	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Customize sidebar" }).click();
	const customize = page.getByRole("dialog", { name: "Customize sidebar" });
	await expect(customize).toBeVisible();
	const agentVisibility = customize
		.getByText("Agents", { exact: true })
		.locator("xpath=../..");
	await agentVisibility.getByRole("button", { name: "Hide section" }).click();
	await expect
		.poll(async () => {
			const hidden = await storageValue(page, "ryu:sidebar-hidden-sections");
			return sidebarStringsSchema.parse(JSON.parse(hidden ?? "[]"));
		})
		.toContain("agents");
	await expect(
		agentVisibility.getByRole("button", { name: "Show section" })
	).toBeVisible();
	await agentVisibility.getByRole("button", { name: "Show section" }).click();
	await expect
		.poll(async () => {
			const hidden = await storageValue(page, "ryu:sidebar-hidden-sections");
			return sidebarStringsSchema.parse(JSON.parse(hidden ?? "[]"));
		})
		.not.toContain("agents");
	await customize.getByRole("button", { name: "Done" }).click();

	await page.reload();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-mode"))
		.toBe("sections");
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-variant"))
		.toBe("inset");
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-group-chats-by-date"))
		.toBe("true");
	await expect(page.getByTestId("tab-state")).toContainText("/chat");
});

test("sidebar-wide Reset restores the default order, visibility, and section controls", async ({
	page,
}) => {
	await page.goto(`${STORY_URL}?focus=tabs,chats,agents&seed=${Date.now()}`);
	await expect(
		page.getByTestId("sidebar-header-actions").getByRole("button", {
			name: "Proof home",
			exact: true,
		})
	).toBeVisible();
	const headerLabels = async () =>
		(
			await page
				.getByTestId("sidebar-header-actions")
				.locator("button")
				.allTextContents()
		).map((label) => label.trim());
	const defaultHeaderLabels = await headerLabels();
	await page.evaluate(
		({ defaultSectionOrder }) => {
			localStorage.setItem(
				"ryu:sidebar-section-order",
				JSON.stringify([...defaultSectionOrder].reverse())
			);
			localStorage.setItem(
				"ryu:sidebar-chrome-order",
				JSON.stringify(["store", "share", "compute", "library", "new-chat"])
			);
			localStorage.setItem("ryu:sidebar-hidden-sections", '["channels"]');
			localStorage.setItem(
				"ryu:sidebar-hidden-chrome",
				'["new-chat","library"]'
			);
			localStorage.setItem("ryu:sidebar-section-page-sizes", '{"chats":5}');
			localStorage.setItem("ryu:sidebar-section-sorts", '{"chats":"name-asc"}');
		},
		{ defaultSectionOrder: DEFAULT_SECTION_ORDER }
	);
	await page.reload();
	await expect(
		page.getByTestId("sidebar-header-actions").getByRole("button", {
			name: "New chat",
			exact: true,
		})
	).toHaveCount(0);

	const menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Reset sidebar layout" }).click();
	await expect
		.poll(async () =>
			JSON.parse(
				(await storageValue(page, "ryu:sidebar-section-order")) ?? "[]"
			)
		)
		.toEqual(DEFAULT_SECTION_ORDER);
	await expect
		.poll(async () =>
			JSON.parse(
				(await storageValue(page, "ryu:sidebar-hidden-sections")) ?? "[]"
			)
		)
		.toEqual(DEFAULT_PROOF_HIDDEN_SECTIONS);
	await expect
		.poll(async () =>
			JSON.parse(
				(await storageValue(page, "ryu:sidebar-hidden-chrome")) ?? "[]"
			)
		)
		.toEqual(DEFAULT_PROOF_HIDDEN_CHROME);
	await expect
		.poll(async () =>
			JSON.parse(
				(await storageValue(page, "ryu:sidebar-section-page-sizes")) ?? "{}"
			)
		)
		.toEqual({});
	await expect
		.poll(async () =>
			JSON.parse(
				(await storageValue(page, "ryu:sidebar-section-sorts")) ?? "{}"
			)
		)
		.toEqual({});
	await expect(
		page.getByTestId("sidebar-header-actions").getByRole("button", {
			name: "New chat",
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByTestId("sidebar-header-actions").getByRole("button", {
			name: "Library",
			exact: true,
		})
	).toBeVisible();
	await expect.poll(headerLabels).toEqual(defaultHeaderLabels);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-reset-layout.png`,
		animations: "disabled",
	});
});
