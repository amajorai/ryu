import { writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
	chatControlNativeNetworkLedger,
	installChatControlNativeNetwork,
} from "./chat-control-native-network.ts";

import {
	EXPECTED_NATIVE_WINDOW_LIFETIME,
	nativeWindowLifetimeProjection,
} from "./chat-page-native-http-lifetime.ts";

const STORY_ORIGIN = "http://127.0.0.1:5197";

interface FixtureCall {
	body: unknown;
	method: string;
	path: string;
}

interface ChatPageFixture {
	calls: FixtureCall[];
	nativeDiagnostics: () => {
		listeners: Array<{ id: number; event: string; handler: number }>;
		callbackIds: number[];
		unexpected: unknown[];
		heldClipsListenerIds: number[];
	};
	nativeSnapshot: () => {
		callbacks: number;
		listeners: number;
		unexpected: string[];
	};
	unexpectedRequests: Array<{
		body: string | null;
		method: string;
		url: string;
	}>;
	unmount: () => void;
	uploads: Array<{ filename: string; size: number; type: string }>;
}

declare global {
	interface Window {
		__shareToolbarFixture?: ChatPageFixture;
	}
}

test.describe.configure({ timeout: 120_000 });

const errorsByPage = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
	await installChatControlNativeNetwork(page);
});

test.afterEach(async ({ page }, testInfo) => {
	// Unmount the actual React tree. Only the fullscreen module window watcher
	// may survive; require its exact event and callback identity, not a count allowance.
	const mounted = await page.evaluate(() => {
		const fixture = window.__shareToolbarFixture;
		if (!fixture) {
			return false;
		}
		fixture.unmount();
		return true;
	});
	if (!mounted) {
		return;
	}
	try {
		await expect
			.poll(async () => {
				const state = await page.evaluate(() => {
					const fixture = window.__shareToolbarFixture;
					if (!fixture) {
						throw new Error("Chat fixture disappeared during cleanup");
					}
					return {
						snapshot: fixture.nativeSnapshot(),
						details: fixture.nativeDiagnostics(),
						unexpectedRequests: fixture.unexpectedRequests,
					};
				});
				return {
					...nativeWindowLifetimeProjection(state),
					unexpectedRequests: state.unexpectedRequests,
				};
			})
			.toEqual({ ...EXPECTED_NATIVE_WINDOW_LIFETIME, unexpectedRequests: [] });
		expect(errorsByPage.get(page) ?? []).toEqual([]);
		expect(chatControlNativeNetworkLedger(page).unexpected).toEqual([]);
	} finally {
		const diagnostic = await page.evaluate(() => {
			const fixture = window.__shareToolbarFixture;
			if (!fixture) {
				return { mounted: false };
			}
			const readBackground = Reflect.get(window, "__chatControlBackground");
			return {
				nativeSnapshot: fixture.nativeSnapshot(),
				nativeDiagnostics: fixture.nativeDiagnostics(),
				unexpectedRequests: fixture.unexpectedRequests,
				featureCalls: fixture.calls,
				background:
					typeof readBackground === "function" ? readBackground() : null,
			};
		});
		const ledgerPath = testInfo.outputPath(
			"chat-control-http-native-and-page-errors.json"
		);
		await writeFile(
			ledgerPath,
			JSON.stringify(
				{
					...diagnostic,
					pageErrors: errorsByPage.get(page) ?? [],
					actualNetwork: chatControlNativeNetworkLedger(page),
				},
				null,
				2
			),
			"utf8"
		);
		await testInfo.attach("chat-control-http-native-and-page-errors", {
			path: ledgerPath,
			contentType: "application/json",
		});
	}
});

async function openChat(page: Page, scenario: string): Promise<string[]> {
	const pageErrors: string[] = [];
	errorsByPage.set(page, pageErrors);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(
		`/share-conversation-toolbar-entry.html?scenario=${encodeURIComponent(scenario)}`,
		{ waitUntil: "domcontentloaded" }
	);
	if (scenario === "merged-thread-picker") {
		await expect(
			page.getByRole("button", { name: "Choose which thread to send to" })
		).toBeVisible();
	} else {
		await expect(
			page.getByText(
				"We need to share the launch plan with the organization.",
				{ exact: true }
			)
		).toBeVisible();
	}
	await expect(
		page.getByText("Connection restored", { exact: true })
	).toBeHidden({ timeout: 10_000 });
	return pageErrors;
}

async function readFixture(
	page: Page
): Promise<Pick<ChatPageFixture, "calls" | "uploads">> {
	return page.evaluate(() => {
		const fixture = window.__shareToolbarFixture;
		if (!fixture) {
			throw new Error("Chat fixture is not mounted");
		}
		return { calls: fixture.calls, uploads: fixture.uploads };
	});
}

async function capture(page: Page, testInfo: TestInfo, filename: string) {
	const screenshot = await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath(filename),
	});
	await testInfo.attach(filename, {
		body: screenshot,
		contentType: "image/png",
	});
}

test("ChatPage composer controls update and dispatch their declared values", async ({
	page,
}, testInfo) => {
	const pageErrors = await openChat(page, "composer-controls");
	const responseMode = page.getByRole("button", { name: "Response mode" });
	await expect(responseMode).toContainText("Balanced");
	await expect(page.getByText("Launch review in progress")).toBeVisible();
	await responseMode.click();
	await page.getByRole("button", { name: "Precise", exact: true }).click();
	await expect(responseMode).toContainText("Precise");
	await expect(
		page.getByRole("button", { name: "Balanced", exact: true })
	).toBeHidden();

	await page.getByRole("button", { name: "Run checks", exact: true }).click();
	await expect
		.poll(async () => {
			const calls = (await readFixture(page)).calls;
			return calls.find(
				(call) => call.path === "/api/plugins/com.ryu.test-tools/host"
			);
		})
		.toEqual({
			body: { args: { stage: "toolbar-regression" }, method: "checks.run" },
			method: "POST",
			path: "/api/plugins/com.ryu.test-tools/host",
		});
	await capture(
		page,
		testInfo,
		"desktop-chatpage-plugin-controls-selected.png"
	);
	expect(pageErrors).toEqual([]);
});

test("merged ChatPage selects the live thread and can start a fresh one", async ({
	page,
}, testInfo) => {
	const pageErrors = await openChat(page, "merged-thread-picker");
	const picker = page.getByRole("button", {
		name: "Choose which thread to send to",
	});
	await expect(picker).toContainText("Latest project thread");
	await picker.click();
	await page
		.getByLabel("Send to thread")
		.getByText("Earlier project thread", { exact: true })
		.click();
	await expect(picker).toContainText("Earlier project thread");
	await expect(
		page.getByText("This belongs to the earlier project thread.", {
			exact: true,
		})
	).toBeVisible();
	await capture(
		page,
		testInfo,
		"desktop-chatpage-merged-picker-earlier-thread.png"
	);

	await picker.click();
	await page.getByRole("menuitem", { name: "New thread", exact: true }).click();
	await expect(picker).toContainText("New thread");
	expect(pageErrors).toEqual([]);
});

test("ChatPage tool details and Copy transcript use the loaded conversation", async ({
	page,
}, testInfo) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: STORY_ORIGIN,
	});
	const pageErrors = await openChat(page, "copy-transcript");
	// The chat header keeps Share and the panel toggle; the agent's tools and
	// Copy transcript live in its "More chat actions" overflow menu (c9b1e90cd).
	const overflow = page.getByRole("button", {
		name: "More chat actions",
		exact: true,
	});
	await overflow.click();
	const tools = page.getByRole("menuitem", { name: "2 tools", exact: true });
	await expect(tools).toBeVisible();
	await tools.hover();
	for (const tool of ["search_web", "read_file"]) {
		await expect(
			page.getByRole("menuitem", { name: tool, exact: true })
		).toBeVisible();
	}
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("menuitem", { name: "search_web", exact: true })
	).toBeHidden();
	await overflow.click();
	await page
		.getByRole("menuitem", { name: "Copy transcript", exact: true })
		.click();
	await expect(
		page.getByText("Copied to clipboard", { exact: true })
	).toBeVisible();
	const clipboard = await page.evaluate(() => navigator.clipboard.readText());
	expect(clipboard).toContain(
		"We need to share the launch plan with the organization."
	);
	expect(clipboard).toContain("The organization copy is ready for review.");
	await expect(
		page.getByRole("menuitem", { name: "Copy transcript", exact: true })
	).toBeHidden();
	await capture(
		page,
		testInfo,
		"desktop-chatpage-copy-transcript-readback.png"
	);
	expect(pageErrors).toEqual([]);
});

test("ChatPage forks from the selected message into a new workspace tab", async ({
	page,
}, testInfo) => {
	const pageErrors = await openChat(page, "fork-dialog");
	await page
		.getByText("We need to share the launch plan with the organization.", {
			exact: true,
		})
		.hover();
	const moreActions = page
		.getByRole("button", { name: "More message actions" })
		.first();
	await moreActions.click();
	await page.getByRole("menuitem", { name: "Fork chat from here" }).click();
	const dialog = page.getByRole("dialog", { name: "Fork chat from here" });
	await expect(dialog).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: "Fork chat from here" })
	).toBeHidden();
	await page.mouse.move(10, 10);
	await capture(page, testInfo, "desktop-chatpage-fork-destination-dialog.png");
	await page.getByRole("button", { name: /Fork in this workspace/ }).click();
	await expect(dialog).not.toBeVisible();
	await expect(
		page.getByRole("button", { name: "Forked launch plan", exact: true })
	).toBeVisible();
	const forkCall = (await readFixture(page)).calls.find(
		(call) =>
			call.method === "POST" &&
			call.path ===
				`/api/conversations/${"conversation-toolbar-share-fixture"}/fork`
	);
	expect(forkCall).toEqual({
		body: { message_id: "toolbar-share-user-message" },
		method: "POST",
		path: "/api/conversations/conversation-toolbar-share-fixture/fork",
	});
	expect(pageErrors).toEqual([]);
});

test("dropping an image into ChatPage uploads it and shows the attachment", async ({
	page,
}, testInfo) => {
	const pageErrors = await openChat(page, "file-drop");
	const png =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlH2O8AAAAASUVORK5CYII=";
	await page.getByTestId("chat-file-drop-zone").evaluate((target, encoded) => {
		const bytes = Uint8Array.from(atob(encoded), (character) =>
			character.charCodeAt(0)
		);
		const file = new File([bytes], "dropped-preview.png", {
			type: "image/png",
		});
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(file);
		target.dispatchEvent(
			new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				dataTransfer,
			})
		);
	}, png);
	const droppedImage = page.getByRole("img", {
		name: "dropped-preview.png",
		exact: true,
	});
	await expect(droppedImage).toBeVisible();
	await expect
		.poll(async () =>
			droppedImage.evaluate((image) => {
				if (!(image instanceof HTMLImageElement)) {
					throw new Error("Expected proof element to be an HTMLImageElement.");
				}
				return image.naturalWidth;
			})
		)
		.toBeGreaterThan(0);
	await expect
		.poll(async () => (await droppedImage.boundingBox())?.height ?? 0)
		.toBeGreaterThan(40);
	await expect
		.poll(async () => (await readFixture(page)).uploads)
		.toContainEqual({
			filename: "dropped-preview.png",
			size: 68,
			type: "image/png",
		});
	await page.mouse.move(10, 10);
	await capture(page, testInfo, "desktop-chatpage-dropped-image-attached.png");
	expect(pageErrors).toEqual([]);
});

test("WorkspaceRequiredDialog holds a local edit until a project is chosen", async ({
	page,
}, testInfo) => {
	const pageErrors = await openChat(page, "workspace-required");
	const prompt = "Edit the code in src/main.ts to fix the build.";
	await page.getByPlaceholder("Ask a follow up").fill(prompt);
	await page.getByRole("button", { name: "Send", exact: true }).click();
	const dialog = page.getByTestId("workspace-required-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("Choose a project to edit");
	expect(
		(await readFixture(page)).calls.some(
			(call) => call.path === "/api/chat/stream"
		)
	).toBe(false);
	await capture(
		page,
		testInfo,
		"desktop-chatpage-workspace-required-dialog.png"
	);
	await dialog.getByRole("button", { name: "Select project folder" }).click();
	await page.getByRole("option", { name: "Open Project Atlas" }).click();
	await expect(dialog).not.toBeVisible();
	await expect
		.poll(async () =>
			(await readFixture(page)).calls.find(
				(call) => call.path === "/api/chat/stream"
			)
		)
		.toBeDefined();
	const chatCall = (await readFixture(page)).calls.find(
		(call) => call.path === "/api/chat/stream"
	);
	const serializedBody = JSON.stringify(chatCall?.body);
	expect(serializedBody).toContain(prompt);
	expect(serializedBody).toContain("/tmp/ryu-chat-controls-project");
	expect(pageErrors).toEqual([]);
});

test("the ChatPage Sketch action opens and dismisses the Drawesome dialog", async ({
	page,
}, testInfo) => {
	const pageErrors = await openChat(page, "drawesome-dialog");
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await page.getByText("Sketch", { exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Sketch" });
	await expect(dialog).toBeVisible();
	await expect(
		page.getByText("Files and images", { exact: true })
	).toBeHidden();
	await page.mouse.move(10, 10);
	await capture(page, testInfo, "desktop-chatpage-drawesome-dialog-open.png");
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	expect(pageErrors).toEqual([]);
});

test("Dismiss removes the current plugin note without deleting its message", async ({
	page,
}, testInfo) => {
	const pageErrors = await openChat(page, "dismiss-plugin-note");
	const note = page.getByText("Review this launch plan before sharing.", {
		exact: true,
	});
	await expect(note).toBeVisible();
	await page.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(note).not.toBeVisible();
	await expect(
		page.getByText("The organization copy is ready for review.", {
			exact: true,
		})
	).toBeVisible();
	await capture(page, testInfo, "desktop-chatpage-plugin-note-dismissed.png");
	expect(pageErrors).toEqual([]);
});
