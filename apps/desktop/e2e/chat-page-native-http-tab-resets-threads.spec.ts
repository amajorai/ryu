// Same-tab thread switches in the merged agent view, and saved side chats.
// Shared setup: `chat-page-native-http-tab-resets.ts`.

import { type Page, test } from "@playwright/test";
import { SAVED_SIDE_CHATS } from "./chat-page-native-http-state.ts";
import {
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";
import {
	callsTo,
	chip,
	expect,
	expectChipsVisible,
	expectNoVisibleChips,
	expectSettledHarness,
	followUps,
	live,
	original,
	originalTitle,
	other,
	otherTitle,
	restoreTwoRetainedChats,
	teardown,
} from "./chat-page-native-http-tab-resets.ts";

test.describe.configure({ timeout: 240_000 });

// Same-tab switches still reset: in the merged agent view the composer's
// thread picker moves THIS tab to another thread (its chips go) or to a new
// thread (its blocked messages go too).
test("switching this tab's thread in the merged agent view still clears its follow-up chips and blocked messages", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const latest = "conversation-latest-thread-fixture";
	await chatPageControl(request, {
		action: "reset",
		scenario: "merged-thread-picker",
	});
	await chatPageControl(request, {
		action: "set_gateway_reachable",
		reachable: true,
	});
	await chatPageControl(request, {
		action: "set_suggestions",
		node: "a",
		conversationId: latest,
		suggestions: followUps,
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		await page.goto(
			"/chat-page-native-http.html?scenario=merged-thread-picker"
		);
		const picker = page.getByRole("button", {
			name: "Choose which thread to send to",
		});
		await expect(picker).toBeVisible();
		await expect(picker).toContainText("Latest project thread");
		const chooseThread = async (name: string) => {
			await picker.click();
			await page.getByRole("menuitemradio", { name, exact: true }).click();
			await expect(picker).toContainText(name);
		};
		const runLatestTurn = async () => {
			await chatPageControl(request, {
				action: "arm_live_chat",
				node: "a",
				conversationId: latest,
			});
			const composer = page
				.getByPlaceholder("Ask a follow up")
				.filter({ visible: true });
			await expect(composer).toBeEnabled();
			await composer.fill(live);
			await page.getByRole("button", { name: "Send", exact: true }).click();
			await expect(
				page.getByText("Owned live response in progress.", { exact: true })
			).toBeVisible();
			expect(
				await chatPageControl(request, {
					action: "finish_live_chat",
					node: "a",
					conversationId: latest,
				})
			).toEqual({ finished: true });
			await expectChipsVisible(page);
		};

		await runLatestTurn();
		await chooseThread("Earlier project thread");
		await expectNoVisibleChips(page);
		await chooseThread("Latest project thread");
		await expectNoVisibleChips(page);

		await runLatestTurn();
		await chatPageControl(request, {
			action: "set_gateway_reachable",
			reachable: false,
		});
		await expect(
			page.getByPlaceholder("Ask a follow up").filter({ visible: true })
		).toBeDisabled();
		const blocked = followUps[1];
		await chip(page, blocked).click();
		const blockedMessage = page
			.getByText(blocked, { exact: true })
			.filter({ visible: true });
		await expect(blockedMessage).toBeVisible();
		await picker.click();
		await page
			.getByRole("menuitem", { name: "New thread", exact: true })
			.click();
		await expect(picker).toContainText("New thread");
		await expect(blockedMessage).toHaveCount(0);

		const after = await expectSettledHarness(request, errors);
		expect(
			callsTo(after.calls, "/api/chat/suggestions").map((call) => call.body)
		).toEqual([{ conversation_id: latest }, { conversation_id: latest }]);
		expect(callsTo(after.calls, "/api/chat/stream")).toHaveLength(2);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});

// chat-composer-and-media.mdx documents one thing that clears an unsent message:
// a new thread in the tab (asserted above). ChatPage also clears it when the
// composer stops being blocked, that is when the gateway is back; the page does
// not mention that. Choosing another existing thread in the thread picker is
// neither trigger, so the message stays until one of them happens. This pins the
// code's rule, half of it undocumented: whether a same-tab switch should also
// clear it is a product decision.
test("choosing another existing thread in the merged agent view keeps a blocked message until the gateway is back", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const latest = "conversation-latest-thread-fixture";
	await chatPageControl(request, {
		action: "reset",
		scenario: "merged-thread-picker",
	});
	await chatPageControl(request, {
		action: "set_gateway_reachable",
		reachable: true,
	});
	await chatPageControl(request, {
		action: "set_suggestions",
		node: "a",
		conversationId: latest,
		suggestions: followUps,
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		await page.goto(
			"/chat-page-native-http.html?scenario=merged-thread-picker"
		);
		const picker = page.getByRole("button", {
			name: "Choose which thread to send to",
		});
		await expect(picker).toContainText("Latest project thread");
		await chatPageControl(request, {
			action: "arm_live_chat",
			node: "a",
			conversationId: latest,
		});
		const composer = page
			.getByPlaceholder("Ask a follow up")
			.filter({ visible: true });
		await expect(composer).toBeEnabled();
		await composer.fill(live);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(
			page.getByText("Owned live response in progress.", { exact: true })
		).toBeVisible();
		expect(
			await chatPageControl(request, {
				action: "finish_live_chat",
				node: "a",
				conversationId: latest,
			})
		).toEqual({ finished: true });
		await expectChipsVisible(page);

		await chatPageControl(request, {
			action: "set_gateway_reachable",
			reachable: false,
		});
		await expect(composer).toBeDisabled();
		const beforeBlocked = await chatPageState(request);
		const blocked = followUps[1];
		await chip(page, blocked).click();
		const blockedMessage = page
			.getByText(blocked, { exact: true })
			.filter({ visible: true });
		await expect(blockedMessage).toBeVisible();

		await picker.click();
		await page
			.getByRole("menuitemradio", { name: otherTitle, exact: true })
			.click();
		await expect(picker).toContainText(otherTitle);
		await expect(
			page
				.getByText("Earlier work is still readable here.", { exact: true })
				.filter({ visible: true })
		).toBeVisible();
		await expect(blockedMessage).toBeVisible();

		// The other trigger, defined in ChatPage only: it goes once the gateway is
		// back.
		await chatPageControl(request, {
			action: "set_gateway_reachable",
			reachable: true,
		});
		await expect(blockedMessage).toBeHidden({ timeout: 15_000 });

		// Blocked means never sent, in either thread.
		const after = await expectSettledHarness(request, errors);
		expect(callsTo(after.calls, "/api/chat/stream")).toEqual(
			callsTo(beforeBlocked.calls, "/api/chat/stream")
		);
		expect(after.histories).toEqual(beforeBlocked.histories);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});

// Open a thread's saved side chat from its own sidebar row, the way a user does.
async function openSavedSideChat(
	page: Page,
	title: string,
	saved: { question: string }
) {
	// The thread's sidebar row, not its tab-strip button.
	const row = page
		.locator('[role="button"]')
		.filter({ hasText: title })
		.filter({ has: page.getByRole("button", { name: "Expand chat details" }) });
	await row.getByRole("button", { name: "Expand chat details" }).click();
	await page.getByRole("button", { name: "Side chats", exact: true }).click();
	await page
		.getByRole("button", {
			name: `Open side chat: ${saved.question}`,
			exact: true,
		})
		.click();
}

function sideQuestion(page: Page) {
	return page.getByRole("dialog", { name: "Side question" });
}

// The sidebar focuses the chat's tab and hands it the saved side chat in one
// step. The earlier chat is a retained, unfocused tab when its row is clicked,
// so gaining focus and opening the side chat arrive together; the side chat
// must still be there once the tab is focused.
test("opening a saved side chat from the sidebar shows it in the retained chat's tab", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, {
		action: "reset",
		scenario: "side-chat-sidebar",
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		await restoreTwoRetainedChats(page, "side-chat-sidebar");
		const titleBarTabs = page.locator("[data-tab-appearance][data-active]");
		await expect(titleBarTabs.nth(0)).toHaveAttribute("data-active", "true");
		await expect(titleBarTabs.nth(1)).toHaveAttribute("data-active", "false");

		const saved = SAVED_SIDE_CHATS[other];
		await openSavedSideChat(page, otherTitle, saved);

		await expect(
			sideQuestion(page).getByText(saved.answer, { exact: true })
		).toBeVisible();
		await expect(titleBarTabs.nth(1)).toHaveAttribute("data-active", "true");
		await expect(titleBarTabs.nth(0)).toHaveAttribute("data-active", "false");

		// Reading a saved side chat asks no model.
		const after = await expectSettledHarness(request, errors);
		expect(callsTo(after.calls, "/api/btw")).toEqual([]);

		await sideQuestion(page)
			.getByRole("button", { name: "Dismiss", exact: true })
			.click();
		await expect(sideQuestion(page)).toHaveCount(0);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});

// The side chat is a modal dialog drawn over the whole window, so it cannot
// stay open once its chat tab is no longer the focused one. Losing focus
// dismisses it, and it is not waiting there when the tab is focused again.
test("a side chat is dismissed when its chat tab loses focus", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, {
		action: "reset",
		scenario: "side-chat-sidebar",
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		await restoreTwoRetainedChats(page, "side-chat-sidebar");
		const titleBarTabs = page.locator("[data-tab-appearance][data-active]");

		const saved = SAVED_SIDE_CHATS[original];
		await openSavedSideChat(page, originalTitle, saved);
		await expect(
			sideQuestion(page).getByText(saved.answer, { exact: true })
		).toBeVisible();
		await expect(titleBarTabs.nth(0)).toHaveAttribute("data-active", "true");

		// Next tab: the modal blocks the pointer, not the tab-cycling shortcut.
		await page.keyboard.press("Control+Tab");
		await expect(titleBarTabs.nth(1)).toHaveAttribute("data-active", "true");
		await expect(sideQuestion(page)).toHaveCount(0);

		await page.keyboard.press("Control+Tab");
		await expect(titleBarTabs.nth(0)).toHaveAttribute("data-active", "true");
		await expect(sideQuestion(page)).toHaveCount(0);

		await expectSettledHarness(request, errors);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});
