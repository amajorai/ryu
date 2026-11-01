import { expect, test } from "@playwright/test";
import {
	activeTabPath,
	fixtureFor,
	openRowContextMenu,
	openSectionRowContextMenu,
	registerAppSidebarProofHooks,
	tabs,
} from "./app-sidebar-interactions-proof.fixture.ts";
import {
	EVIDENCE_DIRECTORY,
	STORY_URL,
} from "./app-sidebar-interactions-proof.fixture-data.ts";

registerAppSidebarProofHooks();

test("channel creation validates, trims exact fields, retains a failed draft for retry, and reloads from the local API fixture", async ({
	page,
}) => {
	await page.goto(`${STORY_URL}?focus=channels,agents&seed=${Date.now()}`);
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();
	fixtureFor(page).failChannelCreateOnce = true;
	await page.getByRole("button", { name: "Add channel", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "New channel bot" });
	await expect(dialog).toBeVisible();
	await dialog.getByLabel("Name").fill("  Support proof  ");
	await dialog
		.getByRole("button", { name: "Paste a token", exact: true })
		.click();
	await dialog.getByRole("button", { name: "Create bot", exact: true }).click();
	await expect(dialog.getByText("Missing required: Bot token")).toBeVisible();
	expect(
		fixtureFor(page).requests.some(
			(request) => request.method === "POST" && request.path === "/api/channels"
		)
	).toBe(false);

	await dialog.getByLabel("Bot token").fill("  proof-secret-token  ");
	await dialog.getByLabel("Routes to").selectOption("agent-alpha");
	await dialog.getByLabel("Model override (optional)").fill("  proof-model  ");
	await dialog
		.getByLabel("System prompt (optional)")
		.fill("  Respond from the local proof fixture.  ");
	await dialog.getByLabel("Group replies").selectOption("all");
	await dialog.getByRole("switch", { name: "Enable channel" }).click();
	await dialog
		.getByRole("switch", { name: "Enable reaction learning" })
		.click();
	await dialog.getByLabel("Good response emojis").fill("👍, 🚀");
	await dialog.getByLabel("Bad response emojis").fill("👎, 💀");
	await dialog
		.getByRole("switch", { name: "Allow group reaction learning" })
		.click();
	await dialog.getByRole("switch", { name: "Let Ryu say hello first" }).click();
	await dialog
		.getByLabel("Where should Ryu say hello?")
		.fill("  approved-proof-chat  ");

	const expectedPayload = {
		agentId: "agent-alpha",
		channelType: "telegram",
		enabled: true,
		groupReplyMode: "all",
		model: "proof-model",
		name: "Support proof",
		proactiveOpening: true,
		proactiveTarget: "approved-proof-chat",
		reactionLearning: {
			allowGroup: true,
			enabled: true,
			negativeEmoji: ["👎", "💀"],
			positiveEmoji: ["👍", "🚀"],
		},
		secrets: { bot_token: "proof-secret-token" },
		systemPrompt: "Respond from the local proof fixture.",
		teamId: null,
	};
	await dialog.getByRole("button", { name: "Create bot", exact: true }).click();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel("Name")).toHaveValue("  Support proof  ");
	const createRequests = () =>
		fixtureFor(page).requests.filter(
			(request) => request.method === "POST" && request.path === "/api/channels"
		);
	await expect.poll(() => createRequests().length).toBe(1);
	expect(createRequests()[0]?.body).toEqual(expectedPayload);
	await expect(
		page.getByText("Fixture channel create failed", { exact: true })
	).toBeVisible();

	await dialog.getByRole("button", { name: "Create bot", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("Support proof", { exact: true })).toBeVisible();
	await expect.poll(() => createRequests().length).toBe(2);
	expect(createRequests().map((request) => request.body)).toEqual([
		expectedPayload,
		expectedPayload,
	]);
	await page.reload();
	await expect(page.getByText("Support proof", { exact: true })).toBeVisible();
	await expect(page.getByTestId("app-sidebar-mount")).not.toContainText(
		"proof-secret-token"
	);
	expect(fixtureFor(page).channels.at(-1)).toMatchObject({
		name: "Support proof",
		secrets: { bot_token: "***" },
	});
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-channel-created.png`,
		animations: "disabled",
	});
});

test("Spaces section opens document rows, routes context actions, persists icon edits, and retries exact create payloads", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=spaces,tabs&grouped=off&behavior=current&auth=off&mode=sections&seed=${Date.now()}`
	);
	const projectBrowser = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	if (await projectBrowser.isVisible()) {
		await page.keyboard.press("Escape");
		await expect(projectBrowser).toBeHidden();
	}
	await expect(page.getByTestId("space-state")).toContainText("Proof space");
	const spaceRow = page.getByRole("button", { name: /Proof space/ }).first();
	await expect(spaceRow).toBeVisible();
	await spaceRow.click();
	const documentRow = page.getByRole("button", { name: /Proof page/ }).first();
	await expect(documentRow).toBeVisible();
	await documentRow.click();
	await expect
		.poll(() => activeTabPath(page))
		.toBe("/spaces/space-proof/doc/doc-proof-page");

	const documentMenu = await openSectionRowContextMenu(
		page,
		"spaces",
		"Proof page"
	);
	await documentMenu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.filter(
				(tab) => tab.path === "/spaces/space-proof/doc/doc-proof-page"
			).length;
		})
		.toBe(2);

	const iconMenu = await openSectionRowContextMenu(
		page,
		"spaces",
		"Proof page"
	);
	await iconMenu
		.getByRole("menuitem", { name: "Change icon…", exact: true })
		.click();
	const iconDialog = page.getByRole("dialog", { name: "Page icon" });
	await expect(iconDialog).toBeVisible();
	await iconDialog.getByRole("tab", { name: "Icon" }).click();
	await iconDialog
		.getByRole("textbox", { name: "Search icons" })
		.fill("folder");
	await iconDialog.getByRole("button", { name: "lucide:folder" }).click();
	await iconDialog
		.getByRole("button", { name: "Use icon", exact: true })
		.click();
	await expect(iconDialog).toBeHidden();
	expect(fixtureFor(page).requests).toContainEqual({
		body: { icon: { id: "lucide:folder", kind: "icon" } },
		method: "POST",
		path: "/api/spaces/space-proof/documents/doc-proof-page/icon",
	});

	fixtureFor(page).failSpaceCreateOnce = true;
	await page.getByRole("button", { name: "New space", exact: true }).click();
	const createDialog = page.getByRole("dialog", { name: "New space" });
	await expect(createDialog).toBeVisible();
	await createDialog.getByLabel("Name").fill("  Proof docs  ");
	await createDialog
		.getByLabel("Description (optional)")
		.fill("  local scope fixture  ");
	await createDialog
		.getByRole("button", { name: "Create", exact: true })
		.click();
	await expect(createDialog.getByText("/api/spaces failed: 503")).toBeVisible();
	await expect(createDialog.getByLabel("Name")).toHaveValue("  Proof docs  ");
	const spaceRequests = () =>
		fixtureFor(page).requests.filter(
			(request) => request.method === "POST" && request.path === "/api/spaces"
		);
	const expectedCreate = {
		description: "local scope fixture",
		name: "Proof docs",
		visibility: "private",
	};
	await expect.poll(() => spaceRequests().length).toBe(1);
	expect(spaceRequests()[0]?.body).toEqual(expectedCreate);
	await createDialog
		.getByRole("button", { name: "Create", exact: true })
		.click();
	await expect(createDialog).toBeHidden();
	await expect.poll(() => spaceRequests().length).toBe(2);
	expect(spaceRequests().map((request) => request.body)).toEqual([
		expectedCreate,
		expectedCreate,
	]);
	await expect(
		page.getByRole("button", { name: /^Proof docs/ }).first()
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByRole("button", { name: /^Proof docs/ }).first()
	).toBeVisible();
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-spaces-documents.png`,
		animations: "disabled",
	});
});

test("grouped Spaces picker persists selection and routes its real visibility/delete confirmations", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=spaces&grouped=on&behavior=current&auth=off&mode=sections&seed=${Date.now()}`
	);
	const section = page.locator("#sidebar-sec-spaces");
	const privatePicker = section.getByRole("combobox").first();
	await expect(privatePicker).toContainText("All private spaces");
	await privatePicker.click();
	await page.getByRole("option", { name: "Proof space", exact: true }).click();
	await expect(privatePicker).toContainText("Proof space");
	expect(
		await page.evaluate(() =>
			localStorage.getItem("ryu:sidebar-private-space-selection")
		)
	).toBe("space-proof");

	const options = page.getByRole("button", {
		name: "Proof space options",
		exact: true,
	});
	await options.click();
	let menu = page.locator('[data-slot="dropdown-menu-content"]:visible').last();
	await menu
		.getByRole("menuitem", { name: "Delete space", exact: true })
		.click();
	const deleteDialog = page.getByRole("alertdialog");
	await expect(deleteDialog).toContainText("Delete Proof space");
	await deleteDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(deleteDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "DELETE" &&
				request.path === "/api/spaces/space-proof"
		)
	).toBe(false);

	await options.click();
	menu = page.locator('[data-slot="dropdown-menu-content"]:visible').last();
	await menu
		.getByRole("menuitem", { name: "Share with team", exact: true })
		.click();
	const visibilityDialog = page.getByRole("alertdialog");
	await expect(visibilityDialog).toContainText("Share with your team?");
	await visibilityDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(visibilityDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "POST" &&
				request.path === "/api/spaces/space-proof/visibility"
		)
	).toBe(false);

	await options.click();
	menu = page.locator('[data-slot="dropdown-menu-content"]:visible').last();
	await menu
		.getByRole("menuitem", { name: "Share with team", exact: true })
		.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Share with team", exact: true })
		.click();
	await expect(page.getByRole("alertdialog")).toBeHidden();
	expect(fixtureFor(page).requests).toContainEqual({
		body: { visibility: "org" },
		method: "POST",
		path: "/api/spaces/space-proof/visibility",
	});
	await expect
		.poll(
			async () => (await page.getByTestId("space-state").textContent()) ?? ""
		)
		.toContain("Proof space");
	await page.reload();
	await expect(page.getByTestId("space-state")).toContainText("Proof space");
	const teamPicker = section.getByRole("combobox").nth(1);
	await expect(teamPicker).toContainText("All team spaces");
	await teamPicker.click();
	await expect(
		page.getByRole("option", { name: "Proof space", exact: true })
	).toBeVisible();
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-grouped-space-selection.png`,
		animations: "disabled",
	});
});

test("chat visibility confirmation cancels without a write and moves a shared chat into Team", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=chats&auth=off&mode=sections&seed=${Date.now()}`
	);
	let menu = await openRowContextMenu(page, "Proof chat");
	await menu
		.getByRole("menuitem", { name: "Share with team", exact: true })
		.click();
	let dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText("Share with your team?");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "POST" &&
				request.path === "/api/conversations/chat-loose/visibility"
		)
	).toBe(false);

	menu = await openRowContextMenu(page, "Proof chat");
	await menu
		.getByRole("menuitem", { name: "Share with team", exact: true })
		.click();
	dialog = page.getByRole("alertdialog");
	await dialog
		.getByRole("button", { name: "Share with team", exact: true })
		.click();
	await expect(dialog).toBeHidden();
	expect(fixtureFor(page).requests).toContainEqual({
		body: { visibility: "org" },
		method: "POST",
		path: "/api/conversations/chat-loose/visibility",
	});
	await expect(
		page.locator('#sidebar-sec-chats [data-subsection-key="team"]')
	).toContainText("Proof chat");
	await expect(
		page.locator('#sidebar-sec-chats [data-subsection-key="private"]')
	).not.toContainText("Proof chat");
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-chat-visibility-confirmed.png`,
		animations: "disabled",
	});
});
