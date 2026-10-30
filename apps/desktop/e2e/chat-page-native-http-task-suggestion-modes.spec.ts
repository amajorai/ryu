// Actual Layout and ChatPage over native browser HTTP. Core is a finite
// transport fixture: it serves one finished turn whose agent called
// `tasks.suggest`, captures every request the page makes, and never runs a model.
// These cases prove what ChatPage's suggested-task actions send and change.
// The Bot product and temporary chats, and tab titles before any message.
// Shared setup: `chat-page-native-http-task-suggestion.ts`.
import { expect, type Page, test } from "@playwright/test";
import {
	LIVE_SUGGESTED_TASK,
	TAB_LABEL_BLANK_TITLE,
	TAB_LABEL_STALE_TITLE,
} from "./chat-page-native-http-state.ts";
import { chatPageControl } from "./chat-page-native-http-support.ts";
import {
	card,
	cleanUpTaskSuggestionPage,
	derivedTitle,
	draftWrites,
	load,
	ORIGINAL_TITLE,
	type StreamBody,
	streamCalls,
	submittedText,
	THREAD_TEXT,
	tabLabel,
	tabs,
} from "./chat-page-native-http-task-suggestion.ts";

test.afterEach(async ({ page }, testInfo) => {
	await cleanUpTaskSuggestionPage(page, testInfo);
});

// The gates on the card's actions. `AgentChat` hides the card when ChatPage hands
// it no actions, and ChatPage hands none in the Bot product; Save to Drafts is
// left out of a temporary chat, whose messages are never kept.

const TEMPORARY_PROMPT = "What should we retire next?";

// A blank new chat whose first turn makes the agent call `tasks.suggest`, sent
// and finished. Returns the first turn's request body.
async function sendSuggestingTurn(
	page: Page,
	options: { product?: "bot"; temporary: boolean }
) {
	await load(
		page,
		"task-suggestion-temporary",
		options.product === "bot" ? "&productMode=bot" : ""
	);
	const composer = page
		.getByPlaceholder("Send a message")
		.filter({ visible: true });
	await expect(composer).toBeVisible();
	if (options.temporary) {
		await page.getByRole("button", { name: "Add", exact: true }).click();
		await page.getByRole("option", { name: /Temporary chat/ }).click();
		await expect(
			page.getByText("Messages in this chat won't be saved.", { exact: true })
		).toBeVisible();
	}
	await chatPageControl(page.request, {
		action: "arm_next_live_chat",
		node: "a",
		suggestTask: true,
	});
	await composer.fill(TEMPORARY_PROMPT);
	await composer.press("Enter");
	await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
	const [first] = await streamCalls(page);
	const body = first?.body as StreamBody;
	await expect(
		page.getByText("Owned live response in progress.", { exact: true })
	).toBeVisible();
	// The page shows the turn running: the composer offers Stop.
	await expect(
		page.getByRole("button", { name: "Stop", exact: true })
	).toBeVisible();
	expect(
		await chatPageControl(page.request, {
			action: "finish_live_chat",
			conversationId: body.conversation_id,
			node: "a",
		})
	).toEqual({ finished: true });
	// The page has seen the turn end: Stop gives way to the idle composer's voice
	// input. A case that asserts the card never shows waits on this, not on time.
	await expect(
		page
			.getByRole("button", { name: "Start voice input", exact: true })
			.filter({ visible: true })
	).toBeVisible();
	return body;
}

async function suggestInBlankChat(page: Page, options: { temporary: boolean }) {
	const body = await sendSuggestingTurn(page, options);
	await expect(card(page)).toContainText(LIVE_SUGGESTED_TASK.title);
	return body;
}

test("in the Bot product the suggested task has no card and no actions", async ({
	page,
}) => {
	// The same chat as the control below, in the Bot product: Bot opens a blank
	// chat of its own and runs the managed agent.
	const first = await sendSuggestingTurn(page, {
		product: "bot",
		temporary: false,
	});
	expect(first.agent_id).toBe("ryu");
	// The turn that called `tasks.suggest` is finished and rendered (the composer
	// is idle again), so the card would be up by now if the page offered it.
	await expect(card(page)).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Start", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Save to Drafts", exact: true })
	).toHaveCount(0);
	expect(await streamCalls(page)).toHaveLength(1);
	// Nothing was saved from the card. (Bot's composer still autosaves the text
	// being typed, which is a different write: its source is not "manual".)
	const saved = (await draftWrites(page)).filter(
		(call) => (call.body as { source?: string }).source === "manual"
	);
	expect(saved).toEqual([]);
});

test("in a chat that is not temporary the suggested task can be saved to Drafts", async ({
	page,
}) => {
	const first = await suggestInBlankChat(page, { temporary: false });
	// The control for the next case: same scenario, same card, and the turn is kept.
	expect(first.persist).toBeUndefined();
	// A kept chat takes its first message as the tab's name.
	await expect(tabLabel(page, derivedTitle(TEMPORARY_PROMPT))).toBeVisible();
	await expect(
		card(page).getByRole("button", { name: "Save to Drafts", exact: true })
	).toBeVisible();
	await expect(
		card(page).getByRole("button", { name: "Start", exact: true })
	).toBeVisible();
});

test("in a temporary chat the suggested task can be started but not saved to Drafts", async ({
	page,
}) => {
	const first = await suggestInBlankChat(page, { temporary: true });
	// The turn really was temporary: Core was told to keep nothing.
	expect(first.persist).toBe(false);
	// Nor does the tab strip keep its first message: the tab is named for what it
	// is, where a chat that is kept takes the message as its name.
	await expect(tabLabel(page, "Temporary chat")).toBeVisible();
	await expect(tabLabel(page, derivedTitle(TEMPORARY_PROMPT))).toHaveCount(0);
	await expect(
		card(page).getByRole("button", { name: "Start", exact: true })
	).toBeVisible();
	await expect(
		card(page).getByRole("button", { name: "Save to Drafts", exact: true })
	).toHaveCount(0);
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	// Start still opens the task in a chat of its own and sends its prompt.
	await expect(tabs(page)).toHaveCount(2);
	await expect.poll(async () => (await streamCalls(page)).length).toBe(2);
	const started = (await streamCalls(page))[1]?.body as StreamBody;
	expect(submittedText(started)).toBe(LIVE_SUGGESTED_TASK.prompt);
	expect(started.conversation_id).not.toBe(first.conversation_id);
	expect(await draftWrites(page)).toEqual([]);
});

// What the tab strip calls a tab follows the page once the page has a thread of
// its own: a conversation id, a message on screen, or a temporary chat.

test("a tab on a conversation takes that conversation's title before any message is on screen", async ({
	page,
}) => {
	await load(page, "tab-label-empty-thread");
	await expect(tabLabel(page, ORIGINAL_TITLE)).toBeVisible();
	await expect(tabLabel(page, TAB_LABEL_STALE_TITLE)).toHaveCount(0);
	// The conversation is empty: nothing but its id and title says whose tab it is.
	await expect(page.getByText(THREAD_TEXT, { exact: true })).toHaveCount(0);
});

test("a new chat keeps the name it was opened with until the page shows something of its own", async ({
	page,
}) => {
	await load(page, "tab-label-blank");
	await expect(tabLabel(page, TAB_LABEL_BLANK_TITLE)).toBeVisible();
	const composer = page
		.getByPlaceholder("Send a message")
		.filter({ visible: true });
	await composer.fill("A lighthouse at dusk");
	// Nothing is on screen yet, so the page has no title to put on the tab.
	await expect(tabLabel(page, TAB_LABEL_BLANK_TITLE)).toBeVisible();
	// Image generation echoes the prompt as a message without making a
	// conversation, so the page has content but no conversation id.
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await page.getByRole("option", { name: /Generate image/ }).click();
	await expect(
		page.getByText("A lighthouse at dusk", { exact: true })
	).toBeVisible();
	await expect(tabLabel(page, "New chat")).toBeVisible();
	await expect(tabLabel(page, TAB_LABEL_BLANK_TITLE)).toHaveCount(0);
	const stored = await page.evaluate(() =>
		JSON.parse(
			(
				Reflect.get(window, "__chatPageNativeFixture") as {
					sealedLocalItem: (key: string) => string | null;
				}
			).sealedLocalItem("ryu_session_tabs") ?? "{}"
		)
	);
	expect(stored.tabs?.[0]?.conversationId).toBeUndefined();
});
