// Actual Layout and ChatPage over native browser HTTP. Core is a finite
// transport fixture: it serves one finished turn whose agent called
// `tasks.suggest`, captures every request the page makes, and never runs a model.
// These cases prove what ChatPage's suggested-task actions send and change.
import { expect, type Page, test } from "@playwright/test";
import {
	assertNativeWindowLifetime,
	persistNativeLifetimeDiagnostics,
} from "./chat-page-native-http-lifetime.ts";
import {
	CONVERSATION_ID,
	LIVE_SUGGESTED_TASK,
	OTHER_WORKSPACE_PATH,
	REATTACHED_TURN_ANSWER,
	REATTACHED_TURN_PROMPT,
	reattachedTurnHistory,
	SUGGESTED_TASK,
	TAB_LABEL_BLANK_TITLE,
	TAB_LABEL_STALE_TITLE,
	WORKSPACE_PATH,
} from "./chat-page-native-http-state.ts";
import {
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
	CHAT_PAGE_NATIVE_NODE_B_TOKEN,
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";

const ORIGINAL_TITLE = "Toolbar share regression fixture";
const errors = new WeakMap<Page, string[]>();

async function load(page: Page, scenario: string, search = "") {
	await chatPageControl(page.request, { action: "reset", scenario });
	await page.setViewportSize({ width: 1480, height: 960 });
	const pageErrors: string[] = [];
	errors.set(page, pageErrors);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(`/chat-page-native-http.html?scenario=${scenario}${search}`);
}

const THREAD_TEXT = "We need to share the launch plan with the organization.";

async function open(page: Page, scenario: string, search = "") {
	await load(page, scenario, search);
	await expect(page.getByText(THREAD_TEXT, { exact: true })).toBeVisible();
	await expect(card(page)).toBeVisible();
}

const card = (page: Page) =>
	page.getByRole("region", { name: "Suggested task", exact: true });
// Shipping title-bar tabs: each wrapper carries `data-active`.
const tabs = (page: Page) => page.locator("[data-tab-appearance][data-active]");
// The tab whose label, as the strip shows it, is `name`.
const tabLabel = (page: Page, name: string) =>
	tabs(page).getByRole("button", { name, exact: true });

interface StreamBody {
	agent_id?: string;
	conversation_id?: string;
	cwd?: string;
	messages?: Array<{
		parts?: Array<{ text?: string; type: string }>;
		role: string;
	}>;
	// `false` on every turn of a temporary chat, left out otherwise.
	persist?: boolean;
	worktree_branch?: string;
	worktree_isolation?: boolean;
}

async function streamCalls(page: Page) {
	const { calls } = await chatPageState(page.request);
	return calls.filter((call) => call.path === "/api/chat/stream");
}

// The text the composer submitted: the first text part of the newest user
// message in the AI SDK request body.
function submittedText(body: StreamBody) {
	const users = (body.messages ?? []).filter(
		(message) => message.role === "user"
	);
	return (
		users.at(-1)?.parts?.find((part) => part.type === "text")?.text ?? null
	);
}

async function draftWrites(page: Page) {
	const { calls } = await chatPageState(page.request);
	return calls.filter(
		(call) => call.method === "POST" && call.path === "/api/drafts/drafts"
	);
}

test.afterEach(async ({ page }, testInfo) => {
	try {
		expect(errors.get(page) ?? []).toEqual([]);
		const mounted = await page.evaluate(() => {
			const fixture = Reflect.get(window, "__chatPageNativeFixture");
			if (!fixture) {
				return false;
			}
			fixture.unmount();
			return true;
		});
		if (mounted) {
			await assertNativeWindowLifetime(page);
		}
	} finally {
		await persistNativeLifetimeDiagnostics(testInfo, {});
	}
});

test("the suggestion sits above the composer and shows the full task", async ({
	page,
}) => {
	await open(page, "task-suggestion");
	const shown = card(page);
	await expect(shown).toContainText(SUGGESTED_TASK.title);
	await expect(shown).toContainText(SUGGESTED_TASK.description);
	// The full prompt is one click away, so the user sees what Start will send.
	await shown.getByText("Show prompt", { exact: true }).click();
	await expect(shown).toContainText(SUGGESTED_TASK.prompt);
	const cardBox = await shown.boundingBox();
	const composerBox = await page
		.getByPlaceholder("Ask a follow up")
		.filter({ visible: true })
		.boundingBox();
	expect(cardBox).not.toBeNull();
	expect(composerBox).not.toBeNull();
	expect((cardBox?.y ?? 0) + (cardBox?.height ?? 0)).toBeLessThanOrEqual(
		composerBox?.y ?? 0
	);
});

test("Dismiss closes the card and sends nothing", async ({ page }) => {
	await open(page, "task-suggestion");
	await card(page)
		.getByRole("button", { name: "Dismiss suggested task", exact: true })
		.click();
	await expect(card(page)).toBeHidden();
	expect(await streamCalls(page)).toEqual([]);
	expect(await draftWrites(page)).toEqual([]);
	await expect(tabs(page)).toHaveCount(1);
});

test("Start opens the task as a new chat in the thread's project and sends its prompt", async ({
	page,
}) => {
	await open(page, "task-suggestion");
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	await expect(card(page)).toBeHidden();
	// A second chat opens beside this one and its first turn streams.
	await expect(tabs(page)).toHaveCount(2);
	await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
	const [call] = await streamCalls(page);
	const body = call?.body as StreamBody;
	expect(body.conversation_id).toBeTruthy();
	expect(body.conversation_id).not.toBe(CONVERSATION_ID);
	expect(submittedText(body)).toBe(SUGGESTED_TASK.prompt);
	// The thread's project, not the global selection (which is somewhere else).
	expect(OTHER_WORKSPACE_PATH).not.toBe(WORKSPACE_PATH);
	expect(body.cwd).toBe(WORKSPACE_PATH);
	expect(body.worktree_isolation).toBe(false);
	expect(await draftWrites(page)).toEqual([]);
});

test("Start never takes over this thread's tab, even when pages open in the current tab", async ({
	page,
}) => {
	await page.addInitScript(() =>
		localStorage.setItem("ryu_tab_open_behavior", "current")
	);
	await open(page, "task-suggestion");
	const thread = tabs(page).filter({
		has: page.getByRole("button", { name: ORIGINAL_TITLE, exact: true }),
	});
	await expect(thread).toHaveCount(1);
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	// The task opened beside this thread, which is still there and not active.
	await expect(tabs(page)).toHaveCount(2);
	await expect(thread).toHaveCount(1);
	await expect(thread).toHaveAttribute("data-active", "false");
});

test("Start in a worktree asks Core to isolate the new chat in a worktree", async ({
	page,
}) => {
	await open(page, "task-suggestion");
	await card(page)
		.getByRole("button", { name: "More ways to start", exact: true })
		.click();
	await page
		.getByRole("menuitem", { name: "Start in a worktree", exact: true })
		.click();
	await expect(card(page)).toBeHidden();
	await expect(tabs(page)).toHaveCount(2);
	await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
	const [call] = await streamCalls(page);
	const body = call?.body as StreamBody;
	expect(body.conversation_id).not.toBe(CONVERSATION_ID);
	expect(submittedText(body)).toBe(SUGGESTED_TASK.prompt);
	expect(body.cwd).toBe(WORKSPACE_PATH);
	expect(body.worktree_isolation).toBe(true);
	expect(body.worktree_branch).toBe("existing-native-proof-branch");
});

test("Start opens the new chat with the thread's agent", async ({ page }) => {
	await open(page, "task-suggestion-agent");
	const agentSettings = page.getByRole("button", {
		name: "Chat settings · Second Agent",
		exact: true,
	});
	await expect(agentSettings).toBeVisible();
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	await expect(card(page)).toBeHidden();
	await expect(tabs(page)).toHaveCount(2);
	// The visible chat is the NEW one and it runs the same agent.
	const newChat = tabs(page).filter({ hasNotText: "Toolbar share regression" });
	await expect(newChat).toHaveAttribute("data-active", "true");
	await expect(agentSettings).toBeVisible();
	await expect(agentSettings).toHaveCount(1);
});

test("Save to Drafts stores the prompt for this thread's project and agent, then closes the card", async ({
	page,
}) => {
	await open(page, "task-suggestion-agent");
	await card(page)
		.getByRole("button", { name: "Save to Drafts", exact: true })
		.click();
	await expect(card(page)).toBeHidden();
	await expect(
		page.getByText("Saved to Drafts", { exact: true })
	).toBeVisible();
	const writes = await draftWrites(page);
	expect(writes).toHaveLength(1);
	// The thread's own project and agent, not the global project selection.
	expect(writes[0]?.body).toEqual({
		agent_id: "agent-second",
		folder_path: WORKSPACE_PATH,
		source: "manual",
		text: SUGGESTED_TASK.prompt,
	});
	const state = await chatPageState(page.request);
	expect(state.drafts).toHaveLength(1);
	// The project's draft list was read again after the write.
	const order = state.calls
		.filter((entry) => entry.path.startsWith("/api/drafts/"))
		.map((entry) => `${entry.method} ${entry.path}`);
	expect(order.lastIndexOf("POST /api/drafts/drafts")).toBeGreaterThan(-1);
	expect(order.slice(order.lastIndexOf("POST /api/drafts/drafts"))).toContain(
		"GET /api/drafts/list"
	);
	expect(await streamCalls(page)).toEqual([]);
	await expect(tabs(page)).toHaveCount(1);
});

test("without a project folder or the Drafts app there is no worktree or draft option", async ({
	page,
}) => {
	await open(page, "task-suggestion-bare");
	await expect(
		card(page).getByRole("button", { name: "Start", exact: true })
	).toBeVisible();
	await expect(
		card(page).getByRole("button", { name: "Save to Drafts", exact: true })
	).toHaveCount(0);
	await expect(
		card(page).getByRole("button", { name: "More ways to start", exact: true })
	).toHaveCount(0);
});

// The name Core and the sidebar give a thread until a model writes one: the
// first line of its first message, capped at 60 characters with an ellipsis.
function derivedTitle(text: string) {
	const characters = [...(text.trim().split("\n")[0]?.trim() ?? "")];
	return characters.length <= 60
		? characters.join("")
		: `${characters.slice(0, 60).join("")}…`;
}

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
			localStorage.getItem("ryu_session_tabs") ?? "{}"
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
		JSON.parse(localStorage.getItem("ryu_session_tabs") ?? "{}")
	);
	expect(stored.tabs?.[0]?.conversationId).toBeUndefined();
});
