import { expect, test } from "@playwright/test";
import {
	BROWSER_SURFACES,
	COPY_ACTIONS,
	menuItem,
	menuLabels,
	openContextMenu,
	openDropdown,
	openMenu,
	ROW_TITLE,
	readCalls,
	row,
	SESSION_ACTIONS,
	STORY_URL,
	UNREAD_COUNT_PROOF,
} from "./chat-row-menus-story.fixture.ts";

// The story pulls the full AppSidebar module graph; vite compiles it on first
// navigation, so allow headroom over the 30s default for cold-start CI runs.
test.describe.configure({ timeout: 90_000 });

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
});
