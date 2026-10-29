import { z } from "zod";
import type { useTabsContext } from "../src/contexts/TabsContext.tsx";

type OpenTabOptions = NonNullable<
	Parameters<ReturnType<typeof useTabsContext>["openTab"]>[1]
>;

import { expect, type Page, test } from "@playwright/test";

const CHAT_ID = "conversation-library-menu";

interface RecordedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface FixtureSnapshot {
	clipboardText: string | null;
	failNextClipboard: boolean;
	failNextDelete: boolean;
	failNextRename: boolean;
	openedTabs: Array<{ options: OpenTabOptions; path: string }>;
	requests: RecordedRequest[];
}

async function openLibrary(page: Page, section = "chat") {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`/library-item-menu-interactions.html?section=${section}`);
	try {
		await page.waitForFunction(
			() =>
				Boolean(
					/* SAFETY: library-item-menu-interactions.tsx installs __libraryMenuFixture before this proof page is evaluated. */ (
						window as Window & { __libraryMenuFixture?: unknown }
					).__libraryMenuFixture
				),
			undefined,
			{ timeout: 5000 }
		);
	} catch {
		throw new Error(
			`Library fixture did not install. Body: ${await page.locator("body").innerText()}; browser errors: ${browserErrors.join(" | ")}`
		);
	}
	if (section === "chat") {
		const loadedContributions = await page
			.waitForFunction(
				() =>
					/* SAFETY: library-item-menu-interactions.tsx installs __libraryMenuFixture before this proof page is evaluated. */ (
						window as Window & {
							__libraryMenuFixture?: { requests: RecordedRequest[] };
						}
					).__libraryMenuFixture?.requests.some(
						(request) => request.path === "/api/plugins/contributions"
					),
				undefined,
				{ timeout: 5000 }
			)
			.then(() => true)
			.catch(() => false);
		if (!loadedContributions) {
			throw new Error(
				`Library contributions did not load. Body: ${await page.locator("body").innerText()}; requests: ${JSON.stringify((await fixtureSnapshot(page)).requests)}; browser errors: ${browserErrors.join(" | ")}`
			);
		}
		if (!(await chatCard(page).isVisible())) {
			const body = await page.locator("body").innerText();
			const requests = (await fixtureSnapshot(page)).requests;
			throw new Error(
				`Library chat card did not render. Body: ${body}; requests: ${JSON.stringify(requests)}`
			);
		}
	}
}

function chatCard(page: Page) {
	return page
		.getByRole("button", { name: /Fixture conversation|Renamed from Library/ })
		.first();
}

async function openChatMenu(page: Page) {
	await chatCard(page).click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Open", exact: true })
	).toBeVisible();
}

async function captureProductScreenshot(page: Page, filename: string) {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: test.info().outputPath(`${filename}.png`),
	});
}

async function fixtureSnapshot(page: Page): Promise<FixtureSnapshot> {
	return await page.evaluate(() => {
		const fixture =
			/* SAFETY: library-item-menu-interactions.tsx installs __libraryMenuFixture before this proof page is evaluated. */ (
				window as Window & {
					__libraryMenuFixture?: FixtureSnapshot;
				}
			).__libraryMenuFixture;
		if (!fixture) {
			throw new Error("Library menu fixture was not installed.");
		}
		return {
			clipboardText: fixture.clipboardText,
			failNextClipboard: fixture.failNextClipboard,
			failNextDelete: fixture.failNextDelete,
			failNextRename: fixture.failNextRename,
			openedTabs: fixture.openedTabs,
			requests: fixture.requests,
		};
	});
}

async function setFailure(
	page: Page,
	control: "failNextClipboard" | "failNextDelete" | "failNextRename"
) {
	await page.evaluate((control) => {
		const fixture =
			/* SAFETY: library-item-menu-interactions.tsx installs __libraryMenuFixture before this proof page is evaluated. */ (
				window as Window & {
					__libraryMenuFixture?: Pick<
						FixtureSnapshot,
						"failNextClipboard" | "failNextDelete" | "failNextRename"
					>;
				}
			).__libraryMenuFixture;
		if (!fixture) {
			throw new Error("Library menu fixture was not installed.");
		}
		fixture[control] = true;
	}, control);
}

async function requestsFor(page: Page, method: string, path: string) {
	return (await fixtureSnapshot(page)).requests.filter(
		(request) => request.method === method && request.path === path
	);
}

async function storedIds(page: Page, key: string): Promise<string[]> {
	const values = await page.evaluate((storageKey) => {
		try {
			return JSON.parse(localStorage.getItem(storageKey) ?? "[]");
		} catch {
			return [];
		}
	}, key);
	const parsed = z.array(z.string()).safeParse(values);
	return parsed.success ? parsed.data : [];
}

test("Library chat menu opens the real destinations and persists transcript, flags, favorite, and app action", async ({
	page,
}) => {
	await openLibrary(page);
	await openChatMenu(page);
	await expect(
		page.getByRole("menuitem", { name: "Open in new tab", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: "Copy transcript", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: "Run library review", exact: true })
	).toBeVisible();
	await captureProductScreenshot(page, "library-chat-context-menu-open");

	await page.getByRole("menuitem", { name: "Open", exact: true }).click();
	await expect
		.poll(async () => (await fixtureSnapshot(page)).openedTabs)
		.toContainEqual({ options: { conversationId: CHAT_ID }, path: "/chat" });
	await openChatMenu(page);
	await page
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(async () => (await fixtureSnapshot(page)).openedTabs)
		.toContainEqual({
			options: { conversationId: CHAT_ID, forceNew: true },
			path: "/chat",
		});

	await setFailure(page, "failNextClipboard");
	await openChatMenu(page);
	await page
		.getByRole("menuitem", { name: "Copy transcript", exact: true })
		.click();
	await expect(page.getByText("Couldn't copy transcript")).toBeVisible();
	await openChatMenu(page);
	await page
		.getByRole("menuitem", { name: "Copy transcript", exact: true })
		.click();
	await expect
		.poll(async () => (await fixtureSnapshot(page)).clipboardText)
		.toBe(
			"User:\nFound a useful regression case.\n\nAssistant:\nI will add a focused check."
		);
	await expect(
		await requestsFor(page, "GET", `/api/conversations/${CHAT_ID}`)
	).toHaveLength(2);

	await openChatMenu(page);
	await page
		.getByRole("menuitem", { name: "Mark as unread", exact: true })
		.click();
	expect(await storedIds(page, "ryu:unread-convs")).toEqual([CHAT_ID]);
	await openChatMenu(page);
	await expect(
		page.getByRole("menuitem", { name: "Mark as read", exact: true })
	).toBeVisible();
	await page
		.getByRole("menuitem", { name: "Mark as read", exact: true })
		.click();
	expect(await storedIds(page, "ryu:unread-convs")).toEqual([]);

	await openChatMenu(page);
	await page.getByRole("menuitem", { name: "Pin chat", exact: true }).click();
	expect(await storedIds(page, "ryu:pinned-convs")).toEqual([CHAT_ID]);
	let pinRequests = await requestsFor(
		page,
		"POST",
		`/api/conversations/${CHAT_ID}/pinned`
	);
	expect(pinRequests.map((request) => request.body)).toEqual([{ value: true }]);
	await openChatMenu(page);
	await expect(
		page.getByRole("menuitem", { name: "Unpin chat", exact: true })
	).toBeVisible();
	await page.getByRole("menuitem", { name: "Unpin chat", exact: true }).click();
	expect(await storedIds(page, "ryu:pinned-convs")).toEqual([]);
	pinRequests = await requestsFor(
		page,
		"POST",
		`/api/conversations/${CHAT_ID}/pinned`
	);
	expect(pinRequests.map((request) => request.body)).toEqual([
		{ value: true },
		{ value: false },
	]);

	await openChatMenu(page);
	await page
		.getByRole("menuitem", { name: "Archive chat", exact: true })
		.click();
	expect(await storedIds(page, "ryu:archived-convs")).toEqual([CHAT_ID]);
	let archiveRequests = await requestsFor(
		page,
		"POST",
		`/api/conversations/${CHAT_ID}/archived`
	);
	expect(archiveRequests.map((request) => request.body)).toEqual([
		{ value: true },
	]);
	await openChatMenu(page);
	await expect(
		page.getByRole("menuitem", { name: "Unarchive chat", exact: true })
	).toBeVisible();
	await page
		.getByRole("menuitem", { name: "Unarchive chat", exact: true })
		.click();
	expect(await storedIds(page, "ryu:archived-convs")).toEqual([]);
	archiveRequests = await requestsFor(
		page,
		"POST",
		`/api/conversations/${CHAT_ID}/archived`
	);
	expect(archiveRequests.map((request) => request.body)).toEqual([
		{ value: true },
		{ value: false },
	]);

	await openChatMenu(page);
	await page
		.getByRole("menuitem", { name: "Add to favorites", exact: true })
		.click();
	expect(await storedIds(page, "ryu:library-favorites")).toEqual([
		{ id: CHAT_ID, type: "chat" },
	]);
	await openChatMenu(page);
	await expect(
		page.getByRole("menuitem", { name: "Remove from favorites", exact: true })
	).toBeVisible();
	await page
		.getByRole("menuitem", { name: "Remove from favorites", exact: true })
		.click();
	expect(await storedIds(page, "ryu:library-favorites")).toEqual([]);

	await openChatMenu(page);
	await page
		.getByRole("menuitem", { name: "Run library review", exact: true })
		.click();
	const hostCalls = await requestsFor(
		page,
		"POST",
		"/api/plugins/com.ryu.fixture-review/host"
	);
	expect(hostCalls).toHaveLength(1);
	expect(hostCalls[0]?.body).toEqual({
		args: { conversation_id: CHAT_ID, source: "library" },
		method: "library.review",
	});
});

test("rename cancel leaves data alone; failed save retains the draft for an exact retry and reload readback", async ({
	page,
}) => {
	await openLibrary(page);
	await openChatMenu(page);
	await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
	let dialog = page.getByRole("dialog", {
		name: "Rename Fixture conversation",
	});
	await dialog.getByPlaceholder("Name").fill("Discarded draft");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText("Fixture conversation", { exact: true })
	).toBeVisible();
	expect(
		await requestsFor(page, "POST", `/api/conversations/${CHAT_ID}/title`)
	).toHaveLength(0);

	await openChatMenu(page);
	await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
	dialog = page.getByRole("dialog", { name: "Rename Fixture conversation" });
	await dialog.getByPlaceholder("Name").fill("Renamed from Library");
	await setFailure(page, "failNextRename");
	await dialog.getByRole("button", { name: "Rename", exact: true }).click();
	await expect(
		page.getByText("Couldn't rename Fixture conversation")
	).toBeVisible();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByPlaceholder("Name")).toHaveValue(
		"Renamed from Library"
	);
	await expect(
		page.getByText("Fixture conversation", { exact: true })
	).toBeVisible();
	await captureProductScreenshot(page, "library-chat-rename-error-retry");

	await dialog.getByRole("button", { name: "Rename", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText("Renamed from Library", { exact: true })
	).toBeVisible();
	const renameRequests = await requestsFor(
		page,
		"POST",
		`/api/conversations/${CHAT_ID}/title`
	);
	expect(renameRequests).toHaveLength(2);
	expect(renameRequests.map((request) => request.body)).toEqual([
		{ title: "Renamed from Library" },
		{ title: "Renamed from Library" },
	]);

	await page.reload();
	await expect(
		page.getByText("Renamed from Library", { exact: true })
	).toBeVisible();
});

test("delete cancel and failed confirmation preserve the chat; retry deletes it from server and Library", async ({
	page,
}) => {
	await openLibrary(page);
	await openChatMenu(page);
	await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
	let dialog = page.getByRole("alertdialog", { name: "Delete chat?" });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	expect(
		await requestsFor(page, "DELETE", `/api/conversations/${CHAT_ID}`)
	).toHaveLength(0);
	await expect(chatCard(page)).toBeVisible();

	await openChatMenu(page);
	await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
	dialog = page.getByRole("alertdialog", { name: "Delete chat?" });
	await setFailure(page, "failNextDelete");
	const slider = dialog.getByRole("slider", {
		name: "Delete Fixture conversation",
	});
	await slider.focus();
	for (let step = 0; step < 5; step += 1) {
		await slider.press("ArrowRight");
	}
	await expect
		.poll(
			async () =>
				(await requestsFor(page, "DELETE", `/api/conversations/${CHAT_ID}`))
					.length
		)
		.toBe(1);
	await expect(
		page.getByText("Couldn't delete Fixture conversation")
	).toBeVisible();
	await expect(dialog).toBeVisible();
	await expect(slider).toHaveAttribute("aria-valuenow", "0");
	// The open alert dialog owns the accessible tree; assert the restored card's
	// exact title text remains visibly rendered behind the confirmation overlay.
	await expect(
		page.getByText("Fixture conversation", { exact: true })
	).toBeVisible();
	await captureProductScreenshot(page, "library-chat-delete-error-retry");

	for (let step = 0; step < 5; step += 1) {
		await slider.press("ArrowRight");
	}
	await expect
		.poll(
			async () =>
				(await requestsFor(page, "DELETE", `/api/conversations/${CHAT_ID}`))
					.length
		)
		.toBe(2);
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText("Renamed from Library", { exact: true })
	).toHaveCount(0);
	const deleteRequests = await requestsFor(
		page,
		"DELETE",
		`/api/conversations/${CHAT_ID}`
	);
	expect(deleteRequests).toHaveLength(2);
	expect(deleteRequests.map((request) => request.body)).toEqual([null, null]);
	await page.reload();
	await expect(page.getByText("No chats yet", { exact: true })).toBeVisible();
});

test("system Space deletion stays disabled with its reason available in the Library card menu", async ({
	page,
}) => {
	await openLibrary(page, "recents");
	const spaceCard = page.getByRole("button", { name: /System Uploads/ });
	await expect(spaceCard).toBeVisible();
	await spaceCard.click({ button: "right" });
	const deleteItem = page.getByRole("menuitem", {
		name: "Delete",
		exact: true,
	});
	await expect(deleteItem).toBeVisible();
	await expect(deleteItem).toBeDisabled();
	await deleteItem.locator("xpath=..").hover();
	await expect(
		page.getByText(
			"System spaces can't be deleted — Ryu creates and maintains this one."
		)
	).toBeVisible();
	await captureProductScreenshot(page, "library-system-space-delete-disabled");
	expect(
		await requestsFor(page, "DELETE", "/api/spaces/system-uploads")
	).toHaveLength(0);
});
