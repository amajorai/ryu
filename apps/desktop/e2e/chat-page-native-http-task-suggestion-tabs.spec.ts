// Actual Layout and ChatPage over native browser HTTP. Core is a finite
// transport fixture: it serves one finished turn whose agent called
// `tasks.suggest`, captures every request the page makes, and never runs a model.
// These cases prove what ChatPage's suggested-task actions send and change.
// Start's tab name and computer, waiting for the suggesting turn, and no account.
// Shared setup: `chat-page-native-http-task-suggestion.ts`.
import { expect, type Page, test } from "@playwright/test";
import {
	CONVERSATION_ID,
	LIVE_SUGGESTED_TASK,
	REATTACHED_TURN_ANSWER,
	REATTACHED_TURN_PROMPT,
	reattachedTurnHistory,
	SUGGESTED_TASK,
} from "./chat-page-native-http-state.ts";
import {
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
	CHAT_PAGE_NATIVE_NODE_B_TOKEN,
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";
import {
	card,
	cleanUpTaskSuggestionPage,
	derivedTitle,
	ORIGINAL_TITLE,
	open,
	type StreamBody,
	streamCalls,
	submittedText,
	tabs,
} from "./chat-page-native-http-task-suggestion.ts";

test.afterEach(async ({ page }, testInfo) => {
	await cleanUpTaskSuggestionPage(page, testInfo);
});

// Every distinct set of tab labels the tab strip showed, in order. The labels
// change within a few hundred milliseconds of Start, so sampling would miss the
// first one; this records each change as it is painted. Install it before the
// page loads.
async function recordTabLabels(page: Page) {
	await page.addInitScript(() => {
		const history: string[][] = [];
		Reflect.set(window, "__tabLabelHistory", history);
		let last = "";
		new MutationObserver(() => {
			const labels = [
				...document.querySelectorAll("[data-tab-appearance]"),
			].map((tab) =>
				(
					tab
						.querySelector("button[aria-label^='Close ']")
						?.getAttribute("aria-label") ?? ""
				).replace(/^Close /, "")
			);
			const key = JSON.stringify(labels);
			if (key !== last) {
				last = key;
				history.push(labels);
			}
		}).observe(document, {
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true,
		});
	});
}

// How many label sets the strip has shown so far.
async function tabLabelChanges(page: Page) {
	return page.evaluate(
		() => (Reflect.get(window, "__tabLabelHistory") as string[][]).length
	);
}

// What the tabs other than the thread's were called after the first `since`
// changes, in the order the strip showed it. The thread's own tab is skipped,
// and so is the strip before it had loaded any tab.
async function newTabLabels(page: Page, since: number) {
	const history = await page.evaluate(
		() => Reflect.get(window, "__tabLabelHistory") as string[][]
	);
	const labels: string[] = [];
	for (const entry of history.slice(since)) {
		for (const label of entry) {
			if (label && label !== ORIGINAL_TITLE && labels.at(-1) !== label) {
				labels.push(label);
			}
		}
	}
	return labels;
}

interface NodeStoreFixture {
	nodeStore: {
		getState(): {
			setTabOverride(tabId: string, node: string): void;
			tabOverrides: Record<string, string>;
		};
	};
}

const NODE_B_NAME = "Native HTTP B";

// Binds the thread's own tab to another computer, the way the title bar's
// "Connect to node" menu does, through the same store the page reads. Returns
// the tab's id, and waits until that computer has served the thread.
async function bindThreadTab(page: Page, nodeName: string) {
	const threadId = await page.evaluate((name) => {
		const fixture = Reflect.get(
			window,
			"__chatPageNativeFixture"
		) as NodeStoreFixture;
		const stored: { tabs?: Array<{ id?: string }> } = JSON.parse(
			(
				Reflect.get(window, "__chatPageNativeFixture") as {
					sealedLocalItem: (key: string) => string | null;
				}
			).sealedLocalItem("ryu_session_tabs") ?? "{}"
		);
		const id = stored.tabs?.[0]?.id;
		if (!id) {
			throw new Error("The seeded thread tab has no id");
		}
		fixture.nodeStore.getState().setTabOverride(id, name);
		return id;
	}, nodeName);
	return threadId;
}

async function tabOverrides(page: Page) {
	return page.evaluate(() => {
		const fixture = Reflect.get(
			window,
			"__chatPageNativeFixture"
		) as NodeStoreFixture;
		return { ...fixture.nodeStore.getState().tabOverrides };
	});
}

test("Start names the new tab after the task until its own thread takes over the name", async ({
	page,
}) => {
	await recordTabLabels(page);
	await open(page, "task-suggestion");
	const changesBeforeStart = await tabLabelChanges(page);
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	await expect(tabs(page)).toHaveCount(2);
	await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
	// The card the user clicked is named for the task, so the tab is too. It is
	// never labelled with the empty-chat placeholder, and once the first message
	// is sent the thread's own name (the message, until a model writes one) is
	// the label, as for every chat.
	await expect
		.poll(() => newTabLabels(page, changesBeforeStart))
		.toEqual([SUGGESTED_TASK.title, derivedTitle(SUGGESTED_TASK.prompt)]);
});

test("Start opens the task on the computer this thread is bound to", async ({
	page,
}) => {
	await open(page, "task-suggestion");
	const threadId = await bindThreadTab(page, NODE_B_NAME);
	await expect
		.poll(async () =>
			(await chatPageState(page.request)).calls.some(
				(call) => call.node === "b" && call.path.includes(CONVERSATION_ID)
			)
		)
		.toBe(true);
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	await expect(tabs(page)).toHaveCount(2);
	await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
	const [call] = await streamCalls(page);
	// The turn ran on computer B with B's credentials, never on A.
	expect(call?.node).toBe("b");
	expect(call?.authorization).toBe(`Bearer ${CHAT_PAGE_NATIVE_NODE_B_TOKEN}`);
	const body = call?.body as StreamBody;
	expect(submittedText(body)).toBe(SUGGESTED_TASK.prompt);
	// The new tab is bound to B beside the thread's own binding, and nothing else.
	const overrides = await tabOverrides(page);
	expect(Object.keys(overrides)).toHaveLength(2);
	expect(Object.keys(overrides)).toContain(threadId);
	expect(Object.values(overrides)).toEqual([NODE_B_NAME, NODE_B_NAME]);
});

test("Start on a thread that is not bound to a computer leaves the new tab on the default one", async ({
	page,
}) => {
	await open(page, "task-suggestion");
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	await expect(tabs(page)).toHaveCount(2);
	await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
	const [call] = await streamCalls(page);
	expect(call?.node).toBe("a");
	expect(call?.authorization).toBe(`Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`);
	// No tab is bound to another computer, so Start did not bind one either.
	expect(await tabOverrides(page)).toEqual({});
});

test("Start follows the binding the page uses, so it carries none while per-tab computers are off", async ({
	page,
}) => {
	await page.addInitScript(() =>
		localStorage.setItem("ryu_node_tab_override_enabled", "false")
	);
	await open(page, "task-suggestion");
	const threadId = await bindThreadTab(page, NODE_B_NAME);
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	await expect(tabs(page)).toHaveCount(2);
	await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
	// The binding is ignored while the setting is off: the thread and the new tab
	// both run on the default computer, and the new tab is not left holding a
	// binding that would apply the moment the setting is turned back on.
	const [call] = await streamCalls(page);
	expect(call?.node).toBe("a");
	expect(Object.keys(await tabOverrides(page))).toEqual([threadId]);
});

test("the card waits for the turn that suggested the task to finish", async ({
	page,
}) => {
	await open(page, "task-suggestion");
	await chatPageControl(page.request, {
		action: "arm_live_chat",
		conversationId: CONVERSATION_ID,
		node: "a",
		suggestTask: true,
	});
	const composer = page
		.getByPlaceholder("Ask a follow up")
		.filter({ visible: true });
	await composer.fill("Is there anything else worth fixing?");
	await composer.press("Enter");
	// The agent has already called tasks.suggest and is still writing its answer.
	await expect(
		page.getByText("Owned live response in progress.", { exact: true })
	).toBeVisible();
	await expect(card(page)).toHaveCount(0);
	await page.waitForTimeout(500);
	await expect(card(page)).toHaveCount(0);
	expect(await tabs(page).count()).toBe(1);
	await chatPageControl(page.request, {
		action: "finish_live_chat",
		conversationId: CONVERSATION_ID,
		node: "a",
	});
	// Once the turn is over the card offers the task this turn suggested.
	await expect(card(page)).toContainText(LIVE_SUGGESTED_TASK.title);
	await expect(
		card(page).getByRole("button", { name: "Start", exact: true })
	).toBeVisible();
});

// A turn Core is running that this tab did not start: another client asked a
// follow-up on the thread, or a queued run began. The tab learns of it when it
// regains focus, attaches to the turn's stream, and shows it as running.
test("the card waits for a turn the tab reattached to after a tab switch, and is offered once it finishes", async ({
	page,
}) => {
	await open(page, "task-suggestion");
	const thread = tabs(page).filter({
		has: page.getByRole("button", { name: ORIGINAL_TITLE, exact: true }),
	});
	const stop = page
		.getByRole("button", { name: "Stop", exact: true })
		.filter({ visible: true });
	// Switch away: a new chat takes focus and the thread's tab goes quiet.
	await page
		.getByRole("button", { name: "New chat tab", exact: true })
		.filter({ visible: true })
		.click();
	await expect(tabs(page)).toHaveCount(2);
	await expect(thread).toHaveAttribute("data-active", "false");
	// While it is away a follow-up starts on the thread, and its agent calls
	// tasks.suggest. Core has stored the question and is running the answer.
	await chatPageControl(page.request, {
		action: "seed_conversation",
		conversationId: CONVERSATION_ID,
		messages: reattachedTurnHistory("running"),
		node: "a",
	});
	await chatPageControl(page.request, {
		action: "arm_resumed_turn",
		conversationId: CONVERSATION_ID,
		node: "a",
		suggestTask: true,
	});
	// Switch back: the tab reads the thread again and attaches to the turn.
	await thread
		.getByRole("button", { name: ORIGINAL_TITLE, exact: true })
		.click();
	await expect(thread).toHaveAttribute("data-active", "true");
	// The turn is on screen: the question Core stored and the answer streaming in
	// from the resume route, which is what the tab attached to.
	await expect(
		page.getByText(REATTACHED_TURN_PROMPT, { exact: true })
	).toBeVisible();
	await expect(
		page.getByText(REATTACHED_TURN_ANSWER, { exact: true })
	).toBeVisible();
	// The agent's tasks.suggest call is complete and on screen, but the turn is not
	// over, so there is no card and no Start.
	await expect(card(page)).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Start", exact: true })
	).toHaveCount(0);
	// The page reports the turn as running (Stop is offered) though the tab sent
	// nothing: the stream is Core's, served once by the resume route.
	await expect(stop).toBeVisible();
	expect(await streamCalls(page)).toEqual([]);
	const { calls } = await chatPageState(page.request);
	const resumes = calls.filter(
		(call) => call.path === `/api/chat/stream/resume/${CONVERSATION_ID}`
	);
	expect(resumes.filter((call) => call.responseStatus === 200)).toHaveLength(1);
	// Core persists the answer and the stream ends.
	await chatPageControl(page.request, {
		action: "seed_conversation",
		conversationId: CONVERSATION_ID,
		messages: reattachedTurnHistory("finished"),
		node: "a",
	});
	expect(
		await chatPageControl(page.request, {
			action: "finish_live_chat",
			conversationId: CONVERSATION_ID,
			node: "a",
		})
	).toEqual({ finished: true });
	// Once the turn is over the card offers the task this turn suggested, not the
	// earlier turn's.
	await expect(card(page)).toContainText(LIVE_SUGGESTED_TASK.title);
	await expect(card(page)).not.toContainText(SUGGESTED_TASK.title);
	await expect(stop).toHaveCount(0);
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	await expect(tabs(page)).toHaveCount(3);
	await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
	const [call] = await streamCalls(page);
	expect(submittedText(call?.body as StreamBody)).toBe(
		LIVE_SUGGESTED_TASK.prompt
	);
});

test("Start works with no one signed in", async ({ page }) => {
	await open(page, "task-suggestion", "&signedOut=1");
	// What this guards: Start needs no account. A gate on one would stop the tab
	// opening or the prompt being sent, and both are asserted below. It cannot
	// notice a per-user token being attached to the request: that token belongs to
	// the node (no case here sets one), not to the account, so a signed-in run
	// sends none either.
	expect(await page.evaluate(() => localStorage.getItem("ryu_accounts"))).toBe(
		null
	);
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	await expect(tabs(page)).toHaveCount(2);
	await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
	const [call] = await streamCalls(page);
	expect(call?.node).toBe("a");
	expect(submittedText(call?.body as StreamBody)).toBe(SUGGESTED_TASK.prompt);
});
