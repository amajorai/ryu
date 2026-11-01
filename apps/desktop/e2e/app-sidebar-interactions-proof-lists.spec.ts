import { expect, test } from "@playwright/test";
import {
	activeTabPath,
	fixtureFor,
	openRowContextMenu,
	openSectionRowContextMenu,
	registerAppSidebarProofHooks,
	storageValue,
	tabs,
} from "./app-sidebar-interactions-proof.fixture.ts";
import {
	EVIDENCE_DIRECTORY,
	STORY_URL,
} from "./app-sidebar-interactions-proof.fixture-data.ts";

registerAppSidebarProofHooks();

test("built-in sidebar lists navigate to their real destinations and add controls open their owner flows", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=channels,integrations,identities,skills,mcp,tools,plugins,engines&behavior=current&seed=${Date.now()}`
	);
	const routeRows = [
		["Proof Telegram", "/channels/channel-proof"],
		["proof-profile", "/identities/profile/proof-profile"],
		["Proof skill", "/skills"],
		["Proof MCP", "/tools"],
		["proof_search", "/tools"],
		["Proof Plugin", "/apps"],
		["Proof Engine", "/engines"],
	] as const;
	for (const [rowName, expectedPath] of routeRows) {
		const row = page.getByRole("button", { name: new RegExp(rowName) }).first();
		await expect(row).toBeVisible();
		await row.click();
		await expect.poll(() => activeTabPath(page)).toBe(expectedPath);
		await row.focus();
		await row.press("Enter");
		await expect.poll(() => activeTabPath(page)).toBe(expectedPath);
	}

	const newWindowRows = [
		[
			"identities",
			"proof-profile",
			"/identities/profile/proof-profile",
			"proof-profile",
		],
		["skills", "Proof skill", "/skills", "Skills"],
		["mcp", "Proof MCP", "/tools", "Tools"],
		["tools", "proof_search", "/tools", "Tools"],
		["plugins", "Proof Plugin", "/apps", "Plugins"],
		["engines", "Proof Engine", "/engines", "Engines"],
	] as const;
	for (const [sectionKey, rowName, path, title] of newWindowRows) {
		const menu = await openSectionRowContextMenu(page, sectionKey, rowName);
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
				path,
				title,
			},
			command: "open_tab_window",
		});
	}

	const integrationRow = page
		.getByRole("button", { name: /Proof Mail/ })
		.first();
	await integrationRow.press("Enter");
	await expect(page.getByTestId("gateway-state")).toContainText(
		JSON.stringify({ open: true, section: "integrations" })
	);
	await page
		.getByRole("button", { name: "Add integration", exact: true })
		.click();
	await expect(page.getByTestId("gateway-state")).toContainText("integrations");

	await page.getByRole("button", { name: "Add channel", exact: true }).click();
	const channelDialog = page.getByRole("dialog", { name: "New channel bot" });
	await expect(channelDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(channelDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) => request.method === "POST" && request.path === "/api/channels"
		)
	).toBe(false);

	await page.getByRole("button", { name: "Add identity", exact: true }).click();
	// Name the dialog: the footer's inert Notifications tray is also a dialog.
	const identityDialog = page.getByRole("dialog", { name: "New connection" });
	await expect(identityDialog).toBeVisible();
	await expect(identityDialog.getByLabel("Profile")).toBeVisible();
	await identityDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(identityDialog).toBeHidden();

	for (const [actionName, expectedPath] of [
		["Add skill", "/skills"],
		["Add MCP server", "/tools"],
		["Browse tools", "/tools"],
		["Add plugin", "/apps"],
		["Add engine", "/engines"],
	] as const) {
		await page.getByRole("button", { name: actionName, exact: true }).click();
		await expect.poll(() => activeTabPath(page)).toBe(expectedPath);
	}

	// The section data was loaded using the local session fixture above. Drop the
	// managed billing token before exercising the forced-new-tab branch so this
	// path proves navigation semantics without consuming a fixture plan's tab cap.
	// This bridge answers `undefined` for the sealed `desktop_secret_*` slots (a
	// host without them), so the auth client keeps reading the legacy localStorage
	// token live and removing it does sign the page out.
	await page.evaluate(() => localStorage.removeItem("ryu_session_token"));
	await page
		.locator("#sidebar-sec-channels")
		.getByRole("button", { name: /Proof Telegram/ })
		.click();
	await expect.poll(() => activeTabPath(page)).toBe("/channels/channel-proof");
	const channelMenu = await openSectionRowContextMenu(
		page,
		"channels",
		"Proof Telegram"
	);
	await channelMenu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.filter((tab) => tab.path === "/channels/channel-proof")
				.length;
		})
		.toBeGreaterThan(1);

	const channelContext = await openSectionRowContextMenu(
		page,
		"channels",
		"Proof Telegram"
	);
	await channelContext
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
			path: "/channels/channel-proof",
			title: "Proof Telegram",
		},
		command: "open_tab_window",
	});
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-built-in-sections.png`,
		animations: "disabled",
	});
});

test("identity, skill, server, tool, plugin, and engine rows open every exact new-tab target", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=identities,skills,mcp,tools,plugins,engines&behavior=current&seed=${Date.now()}`
	);
	const newTabRows = [
		["identities", "proof-profile", "/identities/profile/proof-profile"],
		["skills", "Proof skill", "/skills"],
		["mcp", "Proof MCP", "/tools"],
		["tools", "proof_search", "/tools"],
		["plugins", "Proof Plugin", "/apps"],
		["engines", "Proof Engine", "/engines"],
	] as const;
	for (const [sectionKey, rowName, path] of newTabRows) {
		const before = await tabs(page);
		const beforeCount = before.tabs.filter((tab) => tab.path === path).length;
		const menu = await openSectionRowContextMenu(page, sectionKey, rowName);
		await menu
			.getByRole("menuitem", { name: "Open in new tab", exact: true })
			.click();
		await expect
			.poll(
				async () =>
					(await tabs(page)).tabs.filter((tab) => tab.path === path).length
			)
			.toBe(beforeCount + 1);
		await expect.poll(() => activeTabPath(page)).toBe(path);
	}
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-entity-new-tabs.png`,
		animations: "disabled",
	});
});

test("agent rows route, edit, pin, dispatch contributed actions, create agents, and dismiss scheduled-task dialogs", async ({
	page,
}) => {
	fixtureFor(page).calendarEnabled = true;
	await page.goto(
		`${STORY_URL}?focus=agents,chats&auth=off&mode=sections&seed=${Date.now()}`
	);
	const agentSection = page.locator("#sidebar-sec-agents");
	const agentRow = agentSection
		.locator('div[role="button"]')
		.filter({ hasText: "Agent Alpha" })
		.first();
	await expect(agentRow).toBeVisible();
	const editAgentButton = agentSection.getByRole("button", {
		name: "Edit Agent Alpha",
		exact: true,
	});
	await editAgentButton.hover();
	await expect(
		page
			.locator('[data-slot="tooltip-content"]')
			.filter({ hasText: "Edit agent" })
	).toBeVisible();

	const state = await tabs(page);
	const initialChats = state.tabs.filter((tab) => tab.path === "/chat").length;
	await agentRow.click();
	await expect.poll(() => activeTabPath(page)).toBe("/chat");
	await expect
		.poll(
			async () =>
				(await tabs(page)).tabs.filter((tab) => tab.path === "/chat").length
		)
		.toBe(initialChats + 1);
	await agentRow.focus();
	await agentRow.press("Enter");
	await expect.poll(() => activeTabPath(page)).toBe("/chat");
	await expect
		.poll(
			async () =>
				(await tabs(page)).tabs.filter((tab) => tab.path === "/chat").length
		)
		.toBe(initialChats + 2);
	await editAgentButton.click();
	await expect.poll(() => activeTabPath(page)).toBe("/agents/agent-alpha/edit");

	let menu = await openSectionRowContextMenu(page, "agents", "Agent Alpha");
	await menu.getByRole("menuitem", { name: "Pin agent", exact: true }).click();
	expect(
		JSON.parse((await storageValue(page, "ryu:library-favorites")) ?? "[]")
	).toContainEqual({ id: "agent-alpha", type: "agent" });

	menu = await openSectionRowContextMenu(page, "agents", "Agent Alpha");
	await menu
		.getByRole("menuitem", { name: "Inspect agent", exact: true })
		.click();
	expect(fixtureFor(page).requests).toContainEqual({
		body: {
			args: { agent_id: "agent-alpha", source: "sidebar" },
			method: "proof.inspect-agent",
		},
		method: "POST",
		path: "/api/plugins/proof-app/host",
	});

	const beforeAgentTab = await tabs(page);
	menu = await openSectionRowContextMenu(page, "agents", "Agent Alpha");
	await menu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await tabs(page)).tabs.filter(
					(tab) => tab.path === "/agents/agent-alpha/edit"
				).length
		)
		.toBe(
			beforeAgentTab.tabs.filter(
				(tab) => tab.path === "/agents/agent-alpha/edit"
			).length + 1
		);
	menu = await openSectionRowContextMenu(page, "agents", "Agent Alpha");
	await menu
		.getByRole("menuitem", { name: "Open in new window", exact: true })
		.click();
	const agentNativeCalls = await page.evaluate(
		() =>
			/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
				.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
	);
	expect(agentNativeCalls).toContainEqual({
		args: {
			conversationId: null,
			entityKey: null,
			node: null,
			path: "/agents/agent-alpha/edit",
			title: "Agent Alpha",
		},
		command: "open_tab_window",
	});
	menu = await openSectionRowContextMenu(page, "agents", "Agent Alpha");
	await menu
		.getByRole("menuitem", { name: "Unpin agent", exact: true })
		.click();
	expect(
		JSON.parse((await storageValue(page, "ryu:library-favorites")) ?? "[]")
	).not.toContainEqual({ id: "agent-alpha", type: "agent" });

	await page.getByRole("button", { name: "New agent", exact: true }).click();
	// The create flow opens on its identity question; the "New agent" title
	// belongs to the details step that follows it.
	const createAgentDialog = page.getByRole("dialog", {
		name: "How should this agent work?",
	});
	await expect(createAgentDialog).toBeVisible();
	await createAgentDialog.screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-new-agent-hidden-node.png`,
		animations: "disabled",
	});
	await page.keyboard.press("Escape");
	await expect(createAgentDialog).toBeHidden();

	const chatMenu = await openRowContextMenu(page, "Agent chat");
	await expect(
		chatMenu.getByRole("menuitem", { name: "Add scheduled task…", exact: true })
	).toBeVisible();
	await chatMenu
		.getByRole("menuitem", { name: "Add scheduled task…", exact: true })
		.click();
	const automationDialog = page.getByRole("dialog", { name: "New automation" });
	await expect(automationDialog).toBeVisible();
	await expect(automationDialog.getByLabel("Agent")).toHaveValue("agent-alpha");
	await expect(automationDialog.getByLabel("Persistent chat")).toHaveValue(
		"chat-agent-alpha"
	);
	await page.keyboard.press("Escape");
	await expect(automationDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "POST" && request.path === "/api/automations"
		)
	).toBe(false);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-agent-row-actions.png`,
		animations: "disabled",
	});
});

test("skill list load errors expose a real retry that recovers the production section", async ({
	page,
}) => {
	fixtureFor(page).failSkillReadCount = 4;
	await page.goto(
		`${STORY_URL}?focus=skills&auth=off&mode=sections&seed=${Date.now()}`
	);
	await expect(page.getByText("Couldn't load your skills.")).toBeVisible();
	fixtureFor(page).failSkillReadCount = 0;
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(page.getByText("Proof skill", { exact: true })).toBeVisible();
	expect(
		fixtureFor(page).requests.filter(
			(request) => request.method === "GET" && request.path === "/api/skills"
		)
	).toHaveLength(3);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-skill-retry.png`,
		animations: "disabled",
	});
});
