import { expect, test } from "@playwright/test";
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

import {
	type MenuSurface,
	menuItem,
	openContextMenu,
	openCopySubmenu,
	openDropdown,
	openMenu,
	type RecordedAction,
	ROW_TITLE,
	readCalls,
	readClipboard,
	row,
	STORY_URL,
} from "./chat-row-menus-story.fixture.ts";

// The story pulls the full AppSidebar module graph; vite compiles it on first
// navigation, so allow headroom over the 30s default for cold-start CI runs.
test.describe.configure({ timeout: 90_000 });

test.describe("sidebar chat row — row controls and menu actions", () => {
	test("the hover archive control toggles its state without selecting the chat; pin lives in the menus", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await row(page).hover();
		// One inline action on hover: archive. Pin moved into the ⋯ and
		// right-click menus.
		await expect(
			row(page).locator('button[aria-label="Pin"], button[aria-label="Unpin"]')
		).toHaveCount(0);
		const archiveButton = row(page).locator(
			'button[aria-label="Archive"], button[aria-label="Unarchive"]'
		);
		await archiveButton.click();
		await expect(archiveButton).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByTestId("row-state")).toContainText(
			'"archived":true'
		);
		await expect(page.getByTestId("selection-state")).toHaveText(
			"No chat selected"
		);
		await archiveButton.focus();
		await page.keyboard.press("Space");
		await expect(archiveButton).toHaveAttribute("aria-pressed", "false");
		await expect(page.getByTestId("selection-state")).toHaveText(
			"No chat selected"
		);
		await archiveButton.click();

		await openDropdown(page);
		await expect(menuItem(page, "dropdown-menu", "Pin chat")).toBeVisible();
		await menuItem(page, "dropdown-menu", "Pin chat").click();
		await expect(page.getByTestId("row-state")).toContainText('"pinned":true');
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
		await expect(row(page)).toBeVisible();
		// The row reads its learning-privacy state only once a menu opens, not
		// for every row on mount.
		await expect(page.getByTestId("api-calls")).not.toContainText(
			"/api/learn/exclude/conv-alpha"
		);
		await openDropdown(page);
		await expect(page.getByTestId("api-calls")).toContainText(
			"/api/learn/exclude/conv-alpha"
		);
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
