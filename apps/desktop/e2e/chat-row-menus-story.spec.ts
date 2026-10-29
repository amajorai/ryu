import { z } from "zod";
// Real-browser spec for the chat-row menus story (`e2e/harness/
// chat-row-menus-story.{html,tsx}`), which mounts the REAL sidebar `ChatRow`
// against a stubbed `/api/plugins/contributions`.
//
// What it certifies, none of which a type-check can see:
//   • the ⋯ dropdown and the right-click menu list the SAME app-contributed
//     rows — the regression this story exists for was a context menu that
//     rendered none of them, so an app's row was invisible to anyone who
//     reaches for right-click;
//   • the contributed section is anchored: a `space` row never leaks into a
//     conversation's menu;
//   • `order` sorts the contributed rows on BOTH surfaces, not just the one
//     that happened to have the section;
//   • a contributed row in the RIGHT-CLICK menu actually dispatches — same
//     capability, same `conversation_id` — rather than merely rendering.

import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

// The story pulls the full AppSidebar module graph; vite compiles it on first
// navigation, so allow headroom over the 30s default for cold-start CI runs.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/chat-row-menus-story.html";
const UNREAD_COUNT_PROOF = path.resolve(
	import.meta.dirname,
	"../artifacts/unread-message-count-proof-2026-09-30.png"
);
const BROWSER_SURFACES = ["web", "extension", "mobile"] as const;
const ROW_TITLE = "Fix the flaky auth test";
const SESSION_ACTIONS = [
	"Pin chat",
	"Rename chat",
	"Remove from ryu",
	"Archive chat",
	"Open side chat",
	"Quick reply",
	"Copy",
	"Fork…",
	"Add scheduled task…",
	"Open in new window",
	"Mark as unread",
];
const COPY_ACTIONS = [
	"Copy working directory",
	"Copy session ID",
	"Copy deeplink",
	"Continue on another node",
	"Copy as Markdown",
];

/** The row itself (the context-menu trigger), not the title span inside it. */
function row(page: Page) {
	return page.getByTestId("sidebar-chat-row-conv-alpha");
}

type MenuSurface = "context-menu" | "dropdown-menu";
interface RecordedAction {
	args: unknown[];
	name: string;
}

async function openMenu(page: Page, surface: MenuSurface) {
	if (surface === "dropdown-menu") {
		await openDropdown(page);
		return;
	}
	await openContextMenu(page);
}

function menuItem(page: Page, surface: MenuSurface, label: string) {
	return page
		.locator(`[data-slot="${surface}-content"]`)
		.getByRole("menuitem", { name: label, exact: true });
}

async function readCalls(page: Page): Promise<RecordedAction[]> {
	return page
		.getByTestId("action-log")
		.evaluate((element) => JSON.parse(element.textContent ?? "[]"));
}

async function readClipboard(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		JSON.parse(localStorage.getItem("proof:clipboard") ?? "[]")
	);
}

async function openCopySubmenu(page: Page, surface: MenuSurface) {
	await menuItem(page, surface, "Copy").hover();
	const items = page.locator(
		`[data-slot="${surface}-sub-content"] [role="menuitem"]`
	);
	await expect(items.first()).toBeVisible();
	return items;
}

/**
 * Open the ⋯ dropdown. Two quirks make this fiddlier than a click: the trigger
 * is `display:none` until the row is hovered, and that same hover opens the
 * row's HoverCard preview. So the pointer opens the trigger and the keyboard
 * activates it — the one combination that is not a race with the preview.
 */
async function openDropdown(page: Page) {
	const selectedBefore = await page.getByTestId("selection-state").innerText();
	await row(page).hover();
	const trigger = page.locator('[data-slot="dropdown-menu-trigger"]').first();
	await expect(trigger).toBeVisible();
	await trigger.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("selection-state")).toHaveText(selectedBefore);
}

/** Open the right-click menu on the row. Forced past the same HoverCard preview,
 *  which a right-click has no reason to wait out. */
async function openContextMenu(page: Page) {
	await row(page).click({ button: "right", force: true });
}

/**
 * Labels of one menu's rows, in render order. Scoped to the menu's own popup
 * (`data-slot`) rather than a bare `[role="menuitem"]`: a dismissed dropdown can
 * outlive its close animation in the DOM, and an unscoped query would then read
 * both menus at once and "agree" with itself.
 */
async function menuLabels(
	page: Page,
	which: "context-menu" | "dropdown-menu"
): Promise<string[]> {
	const items = page.locator(
		`[data-slot="${which}-content"] [role="menuitem"]`
	);
	await expect(items.first()).toBeVisible();
	return (await items.allInnerTexts()).map((t) => t.trim());
}

test.describe("sidebar chat row — contributed rows on both menus", () => {
	test("shows an accessible unread message count in the sidebar", async ({
		page,
	}) => {
		await page.goto(`${STORY_URL}?unread-count`);
		const badge = page.getByTestId("sidebar-unread-count-conv-alpha");
		await expect(badge).toHaveText("3");
		await expect(badge).toHaveAttribute("aria-label", "3 unread messages");
		const overflowBadge = page.getByTestId(
			"sidebar-unread-count-conv-overflow"
		);
		await expect(overflowBadge).toHaveText("99+");
		await expect(overflowBadge).toHaveAttribute(
			"aria-label",
			"117 unread messages"
		);
		await page.screenshot({
			clip: { x: 24, y: 24, width: 292, height: 112 },
			path: UNREAD_COUNT_PROOF,
		});
	});

	test("the item preview clears the sidebar edge", async ({ page }) => {
		await page.goto(STORY_URL);
		await row(page).hover();

		const boundary = page.locator("[data-sidebar-preview-boundary]");
		const preview = page.locator('[data-slot="hover-card-content"]');
		await expect(preview).toBeVisible();

		const boundaryBox = await boundary.boundingBox();
		const previewBox = await preview.boundingBox();
		expect(boundaryBox).not.toBeNull();
		expect(previewBox).not.toBeNull();
		if (!(boundaryBox && previewBox)) {
			return;
		}
		expect(previewBox.x).toBeGreaterThanOrEqual(
			boundaryBox.x + boundaryBox.width + 7
		);
	});

	test("the hover preview lists the conversation message count", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await row(page).hover();
		const preview = page.locator('[data-slot="hover-card-content"]');
		await expect(preview).toBeVisible();
		await expect(preview).toContainText("Messages");
		await expect(preview).toContainText("6");
	});

	test("the ⋯ dropdown lists the app-contributed rows", async ({ page }) => {
		await page.goto(STORY_URL);
		await openDropdown(page);
		const labels = await menuLabels(page, "dropdown-menu");
		expect(labels).toContain("Make a skill from this chat");
		expect(labels).toContain("Summarize this chat");
		expect(labels).toContain("Open in new window");
	});

	test("both menus expose the complete chat-session action set", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await openDropdown(page);
		const dropdownLabels = await menuLabels(page, "dropdown-menu");
		for (const label of SESSION_ACTIONS) {
			expect(dropdownLabels).toContain(label);
		}
		expect(dropdownLabels).toEqual([...new Set(dropdownLabels)]);
		await page.keyboard.press("Escape");

		await openContextMenu(page);
		const contextLabels = await menuLabels(page, "context-menu");
		for (const label of SESSION_ACTIONS) {
			expect(contextLabels).toContain(label);
		}
		expect(contextLabels).toEqual([...new Set(contextLabels)]);
	});

	test("both Copy submenus expose session metadata and Markdown", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await openDropdown(page);
		await page
			.locator('[data-slot="dropdown-menu-content"] [role="menuitem"]', {
				hasText: "Copy",
			})
			.first()
			.hover();
		const dropdownCopy = page.locator(
			'[data-slot="dropdown-menu-sub-content"] [role="menuitem"]'
		);
		await expect(dropdownCopy.first()).toBeVisible();
		expect(
			(await dropdownCopy.allInnerTexts()).map((text) => text.trim())
		).toEqual(COPY_ACTIONS);
		await page.keyboard.press("Escape");

		await openContextMenu(page);
		await page
			.locator('[data-slot="context-menu-content"] [role="menuitem"]', {
				hasText: "Copy",
			})
			.first()
			.hover();
		const contextCopy = page.locator(
			'[data-slot="context-menu-sub-content"] [role="menuitem"]'
		);
		await expect(contextCopy.first()).toBeVisible();
		expect(
			(await contextCopy.allInnerTexts()).map((text) => text.trim())
		).toEqual(COPY_ACTIONS);
	});

	test("a built-in session action dispatches from the right-click menu", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await openContextMenu(page);
		await page
			.locator('[data-slot="context-menu-content"] [role="menuitem"]', {
				hasText: "Open side chat",
			})
			.click();
		await expect
			.poll(() => readCalls(page))
			.toContainEqual({
				args: ["conv-alpha"],
				name: "onOpenNewSideChat",
			});
	});

	test("right-click lists the same app-contributed rows", async ({
		page,
	}, testInfo) => {
		await page.goto(STORY_URL);
		await openContextMenu(page);
		const labels = await menuLabels(page, "context-menu");
		expect(labels).toContain("Make a skill from this chat");
		expect(labels).toContain("Summarize this chat");
		expect(labels).toContain("Open in new window");
		// Anchored: a `space` contribution must not reach a conversation menu.
		expect(labels).not.toContain("Space-only row");
		await page.screenshot({
			fullPage: true,
			path: testInfo.outputPath("multi-window-sidebar-proof.png"),
		});
	});

	for (const surface of BROWSER_SURFACES) {
		test(`${surface} hides native window actions from both menus`, async ({
			page,
		}, testInfo) => {
			await page.goto(`${STORY_URL}?surface=${surface}`);

			await openDropdown(page);
			const dropdownLabels = await menuLabels(page, "dropdown-menu");
			expect(dropdownLabels).toContain("Open in new tab");
			expect(dropdownLabels).not.toContain("Open in new window");
			await page.keyboard.press("Escape");

			await openContextMenu(page);
			const contextLabels = await menuLabels(page, "context-menu");
			expect(contextLabels).toContain("Open in new tab");
			expect(contextLabels).not.toContain("Open in new window");

			if (surface === "web") {
				await page.screenshot({
					fullPage: true,
					path: testInfo.outputPath("web-menu-without-desktop-actions.png"),
				});
			}
		});
	}

	test("both menus agree on contributed rows and their order", async ({
		page,
	}) => {
		await page.goto(STORY_URL);

		await openDropdown(page);
		const fromDropdown = (await menuLabels(page, "dropdown-menu")).filter((l) =>
			l.endsWith("this chat")
		);
		await page.keyboard.press("Escape");

		await openContextMenu(page);
		const fromContext = (await menuLabels(page, "context-menu")).filter((l) =>
			l.endsWith("this chat")
		);

		// `order: 10` before `order: 20`, identically on both surfaces.
		expect(fromDropdown).toEqual([
			"Make a skill from this chat",
			"Summarize this chat",
		]);
		expect(fromContext).toEqual(fromDropdown);
	});

	test("a contributed row in the right-click menu actually dispatches", async ({
		page,
	}) => {
		for (const surface of ["dropdown-menu", "context-menu"] as const) {
			await page.goto(STORY_URL);
			await openMenu(page, surface);
			await menuItem(page, surface, "Make a skill from this chat").click();
			await expect(page.getByTestId("invoked")).toHaveText(
				"@ryu/learning :: skill.fromChat :: conv-alpha"
			);
		}
	});

	test("row click, Enter, middle click, and drag preserve their distinct effects", async ({
		page,
	}, testInfo) => {
		const pageErrors: string[] = [];
		const navigations: Array<{
			url: string;
			readyAfterMs: number;
			completed: boolean;
		}> = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		const openReadyRow = async () => {
			const started = Date.now();
			const record = { url: STORY_URL, readyAfterMs: 0, completed: false };
			navigations.push(record);
			await page.goto(STORY_URL);
			await expect(row(page)).toBeVisible();
			await expect(page.getByTestId("selection-state")).toHaveText(
				"No chat selected"
			);
			await expect.poll(() => readCalls(page)).toEqual([]);
			record.readyAfterMs = Date.now() - started;
			record.completed = true;
		};
		try {
			await openReadyRow();
			await row(page).click({ position: { x: 150, y: 14 } });
			await expect(page.getByTestId("selection-state")).toHaveText(
				"conv-alpha"
			);
			await expect.poll(readCalls.bind(null, page)).toContainEqual({
				args: ["conv-alpha"],
				name: "onSelectConversation",
			});

			await row(page).focus();
			await page.keyboard.press("Enter");
			await expect.poll(() => readCalls(page)).toHaveLength(2);
			await openReadyRow();
			await row(page).focus();
			await page.keyboard.press("Space");
			await expect(page.getByTestId("selection-state")).toHaveText(
				"conv-alpha"
			);
			await expect
				.poll(() => readCalls(page))
				.toContainEqual({
					args: ["conv-alpha"],
					name: "onSelectConversation",
				});

			await openReadyRow();
			await row(page).click({ button: "middle" });
			await expect.poll(readCalls.bind(null, page)).toContainEqual({
				args: ["conv-alpha"],
				name: "onOpenInNewTab",
			});

			const dragPayload = await row(page).evaluate((element) => {
				const transfer = new DataTransfer();
				element.dispatchEvent(
					new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer })
				);
				return {
					effectAllowed: transfer.effectAllowed,
					types: [...transfer.types].sort(),
					payload: transfer.getData("text/plain"),
					chatPayload: transfer.getData(
						"application/x-ryu-resource-visibility-chat"
					),
				};
			});
			expect(dragPayload.types).toEqual([
				"application/x-ryu-resource-visibility",
				"application/x-ryu-resource-visibility-chat",
				"text/plain",
			]);
			expect(JSON.parse(dragPayload.payload)).toEqual({
				from: "private",
				id: "conv-alpha",
				name: ROW_TITLE,
				resourceType: "chat",
			});
			expect(dragPayload.chatPayload).toBe("1");
			expect(pageErrors).toEqual([]);
		} finally {
			await testInfo.attach("row-activation-navigation-readiness", {
				body: JSON.stringify(
					{ navigations, pageErrors, url: page.url() },
					null,
					2
				),
				contentType: "application/json",
			});
			if (testInfo.status !== testInfo.expectedStatus) {
				await testInfo.attach("row-activation-failed-document", {
					body: await page.content(),
					contentType: "text/html",
				});
			}
		}
	});

	test("expanded details lazily load messages and side chats and route nested selections", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await row(page)
			.getByRole("button", { name: "Expand chat details" })
			.click();
		const messages = page.getByRole("button", { name: "Messages" });
		await expect(messages).toHaveAttribute("aria-expanded", "true");
		const messageLoads = () =>
			page
				.getByTestId("message-loads")
				.evaluate((element) => JSON.parse(element.textContent ?? "[]"));
		await expect.poll(messageLoads).toContain("conv-alpha");
		const messageButton = page
			.locator('[data-slot="hover-card-trigger"]')
			.filter({ hasText: /Could you compare the auth test/ })
			.first();
		await expect(messageButton).toBeVisible();
		await messageButton.click();
		await expect.poll(readCalls.bind(null, page)).toContainEqual({
			args: ["conv-alpha", "message-user-1"],
			name: "onJumpToMessage",
		});

		const sideChats = page.getByRole("button", { name: "Side chats" });
		await sideChats.click();
		await expect(sideChats).toHaveAttribute("aria-expanded", "true");
		await expect(
			page.getByRole("button", {
				name: "Open side chat: When does the token refresh?",
			})
		).toBeVisible();
		await expect(page.getByTestId("api-calls")).toContainText(
			"/api/conversations/conv-alpha/btw"
		);
		await page
			.getByRole("button", {
				name: "Open side chat: When does the token refresh?",
			})
			.click();
		await expect.poll(readCalls.bind(null, page)).toContainEqual({
			args: [
				"conv-alpha",
				{
					answer: "The token refresh happens after the first retry.",
					conversation_id: "conv-alpha",
					created_at: 1_777_000_000_010,
					id: "btw-alpha",
					kind: "btw",
					question: "When does the token refresh?",
				},
			],
			name: "onOpenSideChat",
		});
		const proofCard = page.getByTestId("sidebar-proof-card");
		const proofBounds = await proofCard.boundingBox();
		if (!proofBounds) {
			throw new Error("Sidebar conversation proof card has no layout bounds");
		}
		await page.screenshot({
			clip: proofBounds,
			path: "../../docs/proof/test-coverage-sweep-20260924/sidebar-conversation-row-proof.png",
		});
		await row(page)
			.getByRole("button", { name: "Collapse chat details" })
			.click();
		await expect(messages).toHaveCount(0);
	});

	test("inline rename commits trimmed titles and cancels without changing selection", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await page.getByText(ROW_TITLE, { exact: true }).first().dblclick();
		const input = row(page).locator("input");
		await expect(input).toBeFocused();
		await input.fill("  Review the flaky auth test  ");
		await input.press("Enter");
		await expect.poll(readCalls.bind(null, page)).toContainEqual({
			args: ["conv-alpha", "Review the flaky auth test"],
			name: "onRenameConversation",
		});
		await expect(page.getByTestId("selection-state")).toHaveText("conv-alpha");

		await page.goto(STORY_URL);
		await openDropdown(page);
		await menuItem(page, "dropdown-menu", "Rename chat").click();
		await input.fill("Do not save this title");
		await input.press("Escape");
		await expect(input).toHaveCount(0);
		await expect(
			(await readCalls(page)).filter(
				(call) => call.name === "onRenameConversation"
			)
		).toHaveLength(0);

		await openContextMenu(page);
		await menuItem(page, "context-menu", "Rename chat").click();
		await input.fill("   ");
		await input.press("Enter");
		await expect(input).toHaveCount(0);
		await expect(
			(await readCalls(page)).filter(
				(call) => call.name === "onRenameConversation"
			)
		).toHaveLength(0);

		await page.goto(STORY_URL);
		await openContextMenu(page);
		await menuItem(page, "context-menu", "Rename chat").click();
		await input.fill("  Context menu title  ");
		await page.getByText("Local row fixture", { exact: true }).click();
		await expect
			.poll(() => readCalls(page))
			.toContainEqual({
				args: ["conv-alpha", "Context menu title"],
				name: "onRenameConversation",
			});
	});

	test("pin and archive controls toggle their state without selecting the chat", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await row(page).hover();
		const pinButton = row(page).locator(
			'button[aria-label="Pin"], button[aria-label="Unpin"]'
		);
		const archiveButton = row(page).locator(
			'button[aria-label="Archive"], button[aria-label="Unarchive"]'
		);
		await pinButton.click();
		await expect(pinButton).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByTestId("row-state")).toContainText('"pinned":true');
		await archiveButton.click();
		await expect(archiveButton).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByTestId("row-state")).toContainText(
			'"archived":true'
		);
		await expect(page.getByTestId("selection-state")).toHaveText(
			"No chat selected"
		);
		await pinButton.focus();
		await page.keyboard.press("Enter");
		await expect(pinButton).toHaveAttribute("aria-pressed", "false");
		await archiveButton.focus();
		await page.keyboard.press("Space");
		await expect(archiveButton).toHaveAttribute("aria-pressed", "false");
		await expect(page.getByTestId("selection-state")).toHaveText(
			"No chat selected"
		);
		await pinButton.click();
		await archiveButton.click();

		await openDropdown(page);
		await expect(menuItem(page, "dropdown-menu", "Unpin chat")).toBeVisible();
		await menuItem(page, "dropdown-menu", "Unpin chat").click();
		await expect(page.getByTestId("row-state")).toContainText('"pinned":false');
		await openContextMenu(page);
		await expect(
			menuItem(page, "context-menu", "Unarchive chat")
		).toBeVisible();
		await menuItem(page, "context-menu", "Unarchive chat").click();
		await expect(page.getByTestId("row-state")).toContainText(
			'"archived":false'
		);
		await openContextMenu(page);
		await expect(menuItem(page, "context-menu", "Pin chat")).toBeVisible();
		await menuItem(page, "context-menu", "Pin chat").click();
		await openDropdown(page);
		await expect(menuItem(page, "dropdown-menu", "Archive chat")).toBeVisible();
		await menuItem(page, "dropdown-menu", "Archive chat").click();
		await expect(page.getByTestId("row-state")).toContainText('"pinned":true');
		await expect(page.getByTestId("row-state")).toContainText(
			'"archived":true'
		);
	});

	test("dropdown and context actions dispatch project, side-chat, fork, schedule, and navigation effects", async ({
		page,
	}) => {
		const actions: Array<{
			expected: RecordedAction;
			label: string;
			submenu?: string;
			surface: MenuSurface;
		}> = [
			{
				expected: { args: ["conv-alpha"], name: "onRemoveFromProject" },
				label: "Remove from ryu",
				surface: "dropdown-menu",
			},
			{
				expected: { args: ["conv-alpha"], name: "onRemoveFromProject" },
				label: "Remove from ryu",
				surface: "context-menu",
			},
			{
				expected: { args: ["conv-alpha"], name: "onOpenNewSideChat" },
				label: "Open side chat",
				surface: "dropdown-menu",
			},
			{
				expected: { args: ["conv-alpha"], name: "onOpenNewSideChat" },
				label: "Open side chat",
				surface: "context-menu",
			},
			{
				expected: {
					args: ["conv-alpha", "workspace"],
					name: "onForkConversation",
				},
				label: "Fork…",
				submenu: "Fork in this workspace",
				surface: "dropdown-menu",
			},
			{
				expected: {
					args: ["conv-alpha", "worktree"],
					name: "onForkConversation",
				},
				label: "Fork…",
				submenu: "Fork in a new worktree",
				surface: "context-menu",
			},
			{
				expected: { args: ["conv-alpha"], name: "onAddScheduledTask" },
				label: "Add scheduled task…",
				surface: "dropdown-menu",
			},
			{
				expected: { args: ["conv-alpha"], name: "onAddScheduledTask" },
				label: "Add scheduled task…",
				surface: "context-menu",
			},
			{
				expected: { args: ["conv-alpha"], name: "onOpenInNewTab" },
				label: "Open in new tab",
				surface: "context-menu",
			},
			{
				expected: { args: ["conv-alpha"], name: "onOpenInNewTab" },
				label: "Open in new tab",
				surface: "dropdown-menu",
			},
			{
				expected: { args: ["conv-alpha"], name: "onOpenInNewWindow" },
				label: "Open in new window",
				surface: "dropdown-menu",
			},
			{
				expected: { args: ["conv-alpha"], name: "onOpenInNewWindow" },
				label: "Open in new window",
				surface: "context-menu",
			},
		];

		for (const action of actions) {
			await page.goto(STORY_URL);
			await openMenu(page, action.surface);
			if (action.submenu) {
				await menuItem(page, action.surface, action.label).hover();
				await page
					.locator(`[data-slot="${action.surface}-sub-content"]`)
					.getByRole("menuitem", { name: action.submenu, exact: true })
					.click();
			} else {
				await menuItem(page, action.surface, action.label).click();
			}
			await expect.poll(() => readCalls(page)).toContainEqual(action.expected);
		}
	});

	test("both menus toggle read state and update the action label", async ({
		page,
	}) => {
		for (const surface of ["dropdown-menu", "context-menu"] as const) {
			await page.goto(STORY_URL);
			await openMenu(page, surface);
			await menuItem(page, surface, "Mark as unread").click();
			await expect(page.getByTestId("row-state")).toContainText(
				'"unread":true'
			);
			await openMenu(page, surface);
			await expect(menuItem(page, surface, "Mark as read")).toBeVisible();
			await menuItem(page, surface, "Mark as read").click();
			await expect(page.getByTestId("row-state")).toContainText(
				'"unread":false'
			);
			await expect
				.poll(() => readCalls(page))
				.toContainEqual({
					args: ["conv-alpha"],
					name: "onMarkUnread",
				});
			await expect
				.poll(() => readCalls(page))
				.toContainEqual({
					args: ["conv-alpha"],
					name: "onMarkRead",
				});
		}
	});

	test("copy actions write the exact conversation values from both menu surfaces", async ({
		page,
	}) => {
		for (const surface of ["dropdown-menu", "context-menu"] as const) {
			await page.goto(STORY_URL);
			for (const [label, expected] of [
				["Copy working directory", "D:\\Code\\ryu"],
				["Copy session ID", "conv-alpha"],
				["Copy deeplink", "ryu://chat/conv-alpha"],
				[
					"Copy as Markdown",
					"# Fix the flaky auth test\\n\\n## User\\n\\nCould you compare the auth test results?\\n\\n## Assistant\\n\\nThe flaky case only fails when the token expires.",
				],
			] as const) {
				await openMenu(page, surface);
				const items = await openCopySubmenu(page, surface);
				await items.getByText(label, { exact: true }).click();
				await expect
					.poll(() => readClipboard(page))
					.toContain(expected.replaceAll("\\n", "\n"));
			}
		}
	});

	test("visibility changes carry the exact private-to-team request from both menus", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		for (const surface of ["dropdown-menu", "context-menu"] as const) {
			await openMenu(page, surface);
			await menuItem(page, surface, "Share with team").click();
		}
		const visibilityCalls = (await readCalls(page)).filter(
			(call) => call.name === "onRequestConversationVisibility"
		);
		expect(visibilityCalls).toEqual([
			{
				args: [
					{
						from: "private",
						id: "conv-alpha",
						name: ROW_TITLE,
						resourceType: "chat",
						to: "team",
					},
				],
				name: "onRequestConversationVisibility",
			},
			{
				args: [
					{
						from: "private",
						id: "conv-alpha",
						name: ROW_TITLE,
						resourceType: "chat",
						to: "team",
					},
				],
				name: "onRequestConversationVisibility",
			},
		]);
	});

	test("learning exclusion persists, reloads, and rolls back a failed save", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await expect(page.getByTestId("api-calls")).toContainText(
			"/api/learn/exclude/conv-alpha"
		);
		await openDropdown(page);
		await menuItem(page, "dropdown-menu", "Exclude from learning").click();
		await page.reload();
		await openContextMenu(page);
		await expect(
			menuItem(page, "context-menu", "Include in learning")
		).toBeVisible();
		await menuItem(page, "context-menu", "Include in learning").click();
		await openContextMenu(page);
		await expect(
			menuItem(page, "context-menu", "Exclude from learning")
		).toBeVisible();
		await page.keyboard.press("Escape");

		await page.evaluate(() =>
			localStorage.setItem("proof:fail-learning-save", "true")
		);
		await openDropdown(page);
		await menuItem(page, "dropdown-menu", "Exclude from learning").click();
		await expect(
			page.getByText("Couldn't update this chat's learning privacy")
		).toBeVisible();
		await openDropdown(page);
		await expect(
			menuItem(page, "dropdown-menu", "Exclude from learning")
		).toBeVisible();
		await page.keyboard.press("Escape");
		const apiCalls = z
			.array(
				z.object({
					authorization: z.string().optional(),
					body: z.json().optional(),
					method: z.string(),
					path: z.string(),
				})
			)
			.parse(
				JSON.parse((await page.getByTestId("api-calls").textContent()) ?? "[]")
			);
		expect(apiCalls.filter((call) => call.method === "POST")).toEqual([
			{
				authorization: "Bearer source-token",
				body: { conversation_id: "conv-alpha", excluded: false },
				method: "POST",
				path: "/source/api/learn/exclude",
			},
			{
				authorization: "Bearer source-token",
				body: { conversation_id: "conv-alpha", excluded: true },
				method: "POST",
				path: "/source/api/learn/exclude",
			},
		]);
	});

	test("Delete prompts before removing the conversation and supports cancel on each menu", async ({
		page,
	}) => {
		for (const surface of ["dropdown-menu", "context-menu"] as const) {
			await page.goto(STORY_URL);
			await openMenu(page, surface);
			await menuItem(page, surface, "Delete").click();
			const dialog = page.getByRole("alertdialog");
			await expect(dialog).toContainText(
				`"${ROW_TITLE}" will be permanently deleted`
			);
			await dialog.getByRole("button", { name: "Cancel" }).click();
			await expect(dialog).toHaveCount(0);
			await expect(
				(await readCalls(page)).filter(
					(call) => call.name === "onDeleteConversation"
				)
			).toHaveLength(0);

			await page.goto(STORY_URL);
			await openMenu(page, surface);
			await menuItem(page, surface, "Delete").click();
			await page
				.getByRole("alertdialog")
				.getByRole("button", { name: "Delete", exact: true })
				.click();
			await expect.poll(readCalls.bind(null, page)).toContainEqual({
				args: ["conv-alpha"],
				name: "onDeleteConversation",
			});
		}
	});

	test("both menus apply the chosen chat icon to the visible conversation row", async ({
		page,
	}) => {
		await page.route("https://api.dicebear.com/**", async (route) => {
			const seed = new URL(route.request().url()).searchParams.get("seed");
			if (seed?.startsWith("auth-regression-")) {
				expect(seed).toMatch(/^auth-regression-/);
			}
			await route.fulfill({
				contentType: "image/svg+xml",
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" rx="40" fill="#7c3aed"/><circle cx="40" cy="32" r="13" fill="#fff"/><path d="M16 72c3-15 12-22 24-22s21 7 24 22" fill="#fff"/></svg>',
			});
		});
		for (const surface of ["dropdown-menu", "context-menu"] as const) {
			await page.goto(STORY_URL);
			await openMenu(page, surface);
			await menuItem(page, surface, "Change icon…").click();
			const dialog = page.getByRole("dialog", { name: "Chat icon" });
			await expect(dialog).toBeVisible();
			await dialog.getByRole("tab", { name: "DiceBear" }).click();
			const seed = `auth-regression-${surface}`;
			await dialog.getByRole("textbox", { name: "DiceBear seed" }).fill(seed);
			await dialog.getByRole("button", { name: "Use avatar" }).click();
			await expect(dialog).toHaveCount(0);
			await expect.poll(readCalls.bind(null, page)).toContainEqual({
				args: [
					"conv-alpha",
					expect.objectContaining({ kind: "dicebear", seed }),
				],
				name: "onSetConversationIcon",
			});
			await expect(page.getByTestId("chat-icon-state")).toContainText(seed);
			await expect(row(page).locator("img").first()).toHaveAttribute(
				"src",
				new RegExp(seed)
			);
			await expect
				.poll(() =>
					row(page)
						.locator("img")
						.first()
						.evaluate((image) => {
							if (!(image instanceof HTMLImageElement)) {
								throw new Error(
									"Expected proof element to be an HTMLImageElement."
								);
							}
							return image.naturalWidth;
						})
				)
				.toBeGreaterThan(0);
			if (surface === "context-menu") {
				const proofCard = page.getByTestId("sidebar-proof-card");
				const proofBounds = await proofCard.boundingBox();
				if (!proofBounds) {
					throw new Error(
						"Sidebar conversation proof card has no layout bounds"
					);
				}
				await page.screenshot({
					clip: proofBounds,
					path: "../../docs/proof/test-coverage-sweep-20260924/sidebar-conversation-icon-proof.png",
				});
			}
		}
	});

	test("Continue on another node opens from the row and completes on the chosen destination", async ({
		page,
	}, testInfo) => {
		await page.goto(STORY_URL);
		await openMenu(page, "dropdown-menu");
		await openCopySubmenu(page, "dropdown-menu");
		await page
			.locator('[data-slot="dropdown-menu-sub-content"]')
			.getByRole("menuitem", {
				name: "Continue on another node",
				exact: true,
			})
			.click();
		const handoffHeading = page.getByRole("dialog", {
			name: "Continue on another node",
		});
		await expect(handoffHeading).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(handoffHeading).toHaveCount(0);

		await page.goto(STORY_URL);
		await openContextMenu(page);
		await openCopySubmenu(page, "context-menu");
		await page
			.locator('[data-slot="context-menu-sub-content"]')
			.getByRole("menuitem", {
				name: "Continue on another node",
				exact: true,
			})
			.click();
		const dialog = page.getByRole("dialog", {
			name: "Continue on another node",
		});
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText(
			"Could you compare the auth test results?"
		);
		await dialog.getByLabel("Destination node").selectOption("Studio node");
		await dialog
			.getByLabel("Context note (optional)")
			.fill("Focus on the auth regression.");
		await dialog.getByLabel(/Suggest the same agent/).check();
		await dialog
			.getByRole("button", { name: "Continue on selected node" })
			.click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByTestId("tab-overrides")).toContainText(
			"Studio node"
		);
		const apiCalls = z
			.array(
				z.object({
					authorization: z.string().optional(),
					body: z
						.object({
							context: z
								.object({
									items: z
										.array(z.object({ text: z.string().optional() }))
										.optional(),
								})
								.optional(),
							source: z.object({ agentHint: z.string().optional() }).optional(),
						})
						.passthrough()
						.optional(),
					method: z.string(),
					path: z.string(),
				})
			)
			.parse(
				JSON.parse((await page.getByTestId("api-calls").textContent()) ?? "[]")
			);
		const exportCall = apiCalls.find((call) => call.path.endsWith("/export"));
		const resumeCall = apiCalls.find((call) => call.path.endsWith("/resume"));
		expect(exportCall).toMatchObject({
			authorization: "Bearer source-token",
			method: "POST",
			path: "/source/api/rnp/v0/conversations/conv-alpha/export",
		});
		expect(resumeCall).toMatchObject({
			authorization: "Bearer destination-token",
			method: "POST",
			path: "/destination/api/rnp/v0/conversations/conv-alpha/resume",
			body: {
				context: { items: [{ text: "Focus on the auth regression." }] },
				source: { agentHint: "researcher" },
			},
		});
		await page.screenshot({
			fullPage: true,
			path: testInfo.outputPath("chat-row-handoff-completed.png"),
		});
	});
});
