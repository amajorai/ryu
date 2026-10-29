import {
	type APIRequestContext,
	expect as baseExpect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import type { Call } from "./chat-page-native-http.host.ts";
import { assertNativeWindowLifetime } from "./chat-page-native-http-lifetime.ts";
import { SAVED_SIDE_CHATS } from "./chat-page-native-http-state.ts";
import {
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";

// The shared host compiles the full Layout graph on first navigation; under
// load a cold restore takes well over the default five seconds.
const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 240_000 });

// Per-tab chat state that must not be reset by another tab's focus: follow-up
// chips (and their in-flight request) and blocked messages. Every chat tab
// stays mounted, and the focused tab mirrors its conversation into one shared
// id, so a reset keyed on that shared id fires in every background tab.

const original = "conversation-toolbar-share-fixture";
const other = "conversation-earlier-thread-fixture";
const originalTitle = "Toolbar share regression fixture";
const otherTitle = "Earlier project thread";
const live = "Keep this owned response streaming.";
const followUps = [
	"Draft the launch announcement.",
	"List the open launch risks.",
];

// Seed the genuine durable session format before an independent renderer
// reload, as the queue-isolation spec does: the legacy session record restores
// both chats with the original focused.
//
// `layout: "scroll"` selects the scrolling tab layout, where the window has no
// Right pane and every chat keeps its own docks. Its chats are laid side by
// side in one track, so more than one composer and transcript is on screen.
async function restoreTwoRetainedChats(
	page: Page,
	scenario: string,
	layout: "standard" | "scroll" = "standard"
) {
	if (layout === "scroll") {
		await page.addInitScript(() =>
			localStorage.setItem("ryu_tab_layout", "scroll")
		);
	}
	await page.goto(`/chat-page-native-http.html?scenario=${scenario}`);
	await expect(
		page.getByText("We need to share the launch plan with the organization.", {
			exact: true,
		})
	).toBeVisible();
	await page.evaluate(
		({ original, other, originalTitle, otherTitle }) => {
			localStorage.removeItem("ryu_workbench_layout_v2");
			localStorage.setItem(
				"ryu_session_tabs",
				JSON.stringify({
					activeIndex: 0,
					tabs: [
						{ path: "/chat", conversationId: original, title: originalTitle },
						{ path: "/chat", conversationId: other, title: otherTitle },
					],
				})
			);
		},
		{ original, other, originalTitle, otherTitle }
	);
	await page.reload();
	await expect(
		layout === "scroll"
			? page.getByPlaceholder("Ask a follow up").first()
			: page.getByPlaceholder("Ask a follow up").filter({ visible: true })
	).toBeVisible();
	if (layout === "scroll") {
		return scrollingChatTabs(page);
	}
	// Shipping title-bar tabs in strip order: the wrapper carries `data-active`
	// and the title button inside it activates the tab. Tabs are told apart by
	// position, so a tab that shows the wrong title still fails on its title.
	const titleBarTabs = page.locator("[data-tab-appearance][data-active]");
	const originalTab = titleBarTabs.nth(0);
	const otherTab = titleBarTabs.nth(1);
	const newChatTab = titleBarTabs.nth(2);
	await expect(titleBarTabs).toHaveCount(2);
	await expect(
		originalTab.getByRole("button", { name: originalTitle, exact: true })
	).toBeVisible();
	await expect(
		otherTab.getByRole("button", { name: otherTitle, exact: true })
	).toBeVisible();
	await expect(originalTab).toHaveAttribute("data-active", "true");
	await expect(otherTab).toHaveAttribute("data-active", "false");
	return {
		newChatTab,
		focusOriginal: async () => {
			await originalTab
				.getByRole("button", { name: originalTitle, exact: true })
				.click();
			await expect(originalTab).toHaveAttribute("data-active", "true");
		},
		focusOther: async () => {
			await otherTab
				.getByRole("button", { name: otherTitle, exact: true })
				.click();
			await expect(otherTab).toHaveAttribute("data-active", "true");
			await expect(originalTab).toHaveAttribute("data-active", "false");
			await expect(
				page
					.getByText("Earlier work is still readable here.", { exact: true })
					.filter({ visible: true })
			).toBeVisible();
		},
		// The title-bar "New chat tab" button: a fresh chat with no conversation,
		// appended to the strip and focused.
		focusNewChat: async () => {
			await page
				.getByRole("button", { name: "New chat tab", exact: true })
				.filter({ visible: true })
				.click();
			await expect(titleBarTabs).toHaveCount(3);
			await expect(newChatTab).toHaveAttribute("data-active", "true");
			await expect(originalTab).toHaveAttribute("data-active", "false");
			await expect(otherTab).toHaveAttribute("data-active", "false");
			await expect(
				page
					.getByText(
						"We need to share the launch plan with the organization.",
						{ exact: true }
					)
					.filter({ visible: true })
			).toHaveCount(0);
		},
	};
}

// The scrolling layout has no title-bar strip: each chat is a card in one
// track, its header button focuses it, and the track's own button adds a chat.
async function scrollingChatTabs(page: Page) {
	const cards = page.locator("[data-tab-view-card]");
	const originalCard = cards.nth(0);
	const otherCard = cards.nth(1);
	const newChatCard = cards.nth(2);
	await expect(cards).toHaveCount(2);
	await expect(
		originalCard.getByRole("button", { name: originalTitle, exact: true })
	).toBeVisible();
	await expect(
		otherCard.getByRole("button", { name: otherTitle, exact: true })
	).toBeVisible();
	await expect(originalCard).toHaveAttribute("data-focused", "true");
	await expect(otherCard).toHaveAttribute("data-focused", "false");
	return {
		newChatTab: newChatCard,
		focusOriginal: async () => {
			await originalCard
				.getByRole("button", { name: originalTitle, exact: true })
				.click();
			await expect(originalCard).toHaveAttribute("data-focused", "true");
		},
		focusOther: async () => {
			await otherCard
				.getByRole("button", { name: otherTitle, exact: true })
				.click();
			await expect(otherCard).toHaveAttribute("data-focused", "true");
			await expect(originalCard).toHaveAttribute("data-focused", "false");
		},
		focusNewChat: async () => {
			await page
				.getByRole("button", { name: "New chat tab", exact: true })
				.click();
			await expect(cards).toHaveCount(3);
			// The track's button appends the chat without focusing it: focus it
			// from its own header.
			await newChatCard
				.getByRole("button", { name: "New chat", exact: true })
				.click();
			await expect(newChatCard).toHaveAttribute("data-focused", "true");
			await expect(originalCard).toHaveAttribute("data-focused", "false");
			await expect(otherCard).toHaveAttribute("data-focused", "false");
		},
	};
}

// A new chat tab is named for what it is, not for the conversation that was
// focused when it opened.
async function expectNewChatTabTitled(newChatTab: Locator) {
	await expect(
		newChatTab.getByRole("button", { name: "New chat", exact: true })
	).toBeVisible();
	await expect(
		newChatTab.getByRole("button", { name: originalTitle, exact: true })
	).toHaveCount(0);
}

function callsTo(calls: Call[], path: string) {
	return calls.filter((call) => call.path === path);
}

// One owned turn in the focused original chat, completed the way a provider
// completes it. Returns once the composer is idle again.
async function completeOneTurn(page: Page, request: APIRequestContext) {
	await chatPageControl(request, {
		action: "arm_live_chat",
		node: "a",
		conversationId: original,
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
			conversationId: original,
		})
	).toEqual({ finished: true });
}

// The follow-up chips under the transcript. The composer repeats the same
// items as its own suggestions, disabled while the composer is blocked.
function chip(page: Page, label: string) {
	return page
		.locator('[data-chat-transcript="true"]')
		.getByRole("button", { name: label, exact: true })
		.filter({ visible: true });
}

async function expectChipsVisible(page: Page) {
	for (const label of followUps) {
		await expect(chip(page, label)).toBeVisible();
	}
}

async function expectNoVisibleChips(page: Page) {
	for (const label of followUps) {
		await expect(
			page
				.getByRole("button", { name: label, exact: true })
				.filter({ visible: true })
		).toHaveCount(0);
	}
}

// One owned turn that edited `src/status.txt`: its file-edits card carries the
// **Review** button that opens the Changes pane on exactly that file.
const reviewUserText =
	"We need to share the launch plan with the organization.";
const reviewAssistantText = "Updated status file.";
function fileEditsHistory() {
	return [
		{
			id: "review-user-message",
			role: "user",
			content: reviewUserText,
			created_at: 1_724_000_000_000,
			author_user_id: "share-owner",
		},
		{
			id: "review-assistant-message",
			role: "assistant",
			content: reviewAssistantText,
			created_at: 1_724_000_010_000,
			parts: [
				{ type: "text", text: reviewAssistantText },
				{
					type: "tool-Edit",
					toolCallId: "review-edit",
					state: "output-available",
					input: {
						file_path: "src/status.txt",
						old_string: "pending",
						new_string: "ready",
					},
					output: { success: true },
				},
			],
		},
	];
}

// The Changes pane's source selector: "Files from this turn" while a review
// request is open, "Working tree" once it is closed.
function reviewLabel(page: Page) {
	return page
		.getByText("Files from this turn", { exact: true })
		.filter({ visible: true });
}

// In the standard tab layouts the Changes pane is a tab of the window's Right
// pane, scoped to the open project: Review opens it, or focuses the one that is
// already open.
function changesTabs(page: Page) {
	return page
		.getByRole("tablist", { name: "Right tabs" })
		.getByRole("tab", { name: "Changes", exact: true });
}

// `how: "keyboard"` presses Review with Enter. In the scrolling layout with two
// chats, a floating pinned-summary panel covers the button and intercepts a
// pointer click, so that layout presses it from the keyboard.
async function openReview(page: Page, how: "click" | "keyboard" = "click") {
	await expect(
		page.getByText(reviewAssistantText, { exact: true }).filter({
			visible: true,
		})
	).toBeVisible();
	const review = page
		.getByRole("button", { name: "Review", exact: true })
		.filter({ visible: true });
	if (how === "keyboard") {
		await review.focus();
		await page.keyboard.press("Enter");
	} else {
		await review.click();
	}
	await expect(reviewLabel(page)).toBeVisible();
}

async function expectSettledHarness(
	request: APIRequestContext,
	errors: string[]
) {
	const state = await chatPageState(request);
	expect(state.unexpected).toEqual([]);
	expect(errors).toEqual([]);
	return state;
}

async function teardown(page: Page) {
	await page.evaluate(() =>
		Reflect.get(window, "__chatPageNativeFixture")?.unmount()
	);
	await assertNativeWindowLifetime(page);
}

test("a retained chat keeps its follow-up chips while another chat or a new chat tab is focused", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, {
		action: "reset",
		scenario: "queue-isolation",
	});
	await chatPageControl(request, {
		action: "set_suggestions",
		node: "a",
		conversationId: original,
		suggestions: followUps,
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		const { focusOriginal, focusOther, focusNewChat, newChatTab } =
			await restoreTwoRetainedChats(page, "queue-isolation");
		await completeOneTurn(page, request);
		await expectChipsVisible(page);
		const settled = await chatPageState(request);
		const fetches = callsTo(settled.calls, "/api/chat/suggestions");
		expect(fetches).toHaveLength(1);
		expect(fetches[0]).toMatchObject({
			node: "a",
			method: "POST",
			authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
			body: { conversation_id: original },
			status: "accepted",
		});

		await focusOther();
		await expectNoVisibleChips(page);
		await focusOriginal();
		await expectChipsVisible(page);

		await focusNewChat();
		await expectNoVisibleChips(page);
		await focusOriginal();
		await expectChipsVisible(page);
		await expectNewChatTabTitled(newChatTab);

		// The chips were kept, not fetched again, and nothing else was sent.
		const after = await expectSettledHarness(request, errors);
		expect(callsTo(after.calls, "/api/chat/suggestions")).toEqual(fetches);
		expect(callsTo(after.calls, "/api/chat/stream")).toEqual(
			callsTo(settled.calls, "/api/chat/stream")
		);
		expect(after.histories).toEqual(settled.histories);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});

test("focusing another chat does not abandon a retained chat's in-flight follow-up request", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, {
		action: "reset",
		scenario: "queue-isolation",
	});
	await chatPageControl(request, {
		action: "set_suggestions",
		node: "a",
		conversationId: original,
		suggestions: followUps,
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		const { focusOriginal, focusOther } = await restoreTwoRetainedChats(
			page,
			"queue-isolation"
		);
		await chatPageControl(request, {
			action: "hold_next",
			node: "a",
			method: "POST",
			path: "/api/chat/suggestions",
		});
		await completeOneTurn(page, request);
		await expect
			.poll(async () => (await chatPageState(request)).heldRequestIds.length)
			.toBe(1);
		const held = await chatPageState(request);
		const heldId = held.heldRequestIds[0];
		expect(held.calls.find((call) => call.id === heldId)).toMatchObject({
			path: "/api/chat/suggestions",
			body: { conversation_id: original },
			status: "pending",
		});

		// Focus moves while Core is still answering.
		await focusOther();
		expect(
			await chatPageControl(request, {
				action: "release",
				requestId: heldId,
				accept: true,
			})
		).toEqual({ ok: true });
		await expect
			.poll(
				async () =>
					(await chatPageState(request)).calls.find(
						(call) => call.id === heldId
					)?.status
			)
			.toBe("accepted");
		await expectNoVisibleChips(page);

		await focusOriginal();
		await expectChipsVisible(page);
		const after = await expectSettledHarness(request, errors);
		expect(after.calls.find((call) => call.id === heldId)).toMatchObject({
			clientAborted: false,
			responseStatus: 200,
		});
		expect(callsTo(after.calls, "/api/chat/suggestions")).toHaveLength(1);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});

test("a retained chat keeps its blocked messages while another chat or a new chat tab is focused", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, {
		action: "reset",
		scenario: "blocked-messages",
	});
	// The original thread is pinned to a gateway-transport agent: its composer
	// accepts sends only while the gateway is reachable.
	await chatPageControl(request, {
		action: "set_gateway_reachable",
		reachable: true,
	});
	await chatPageControl(request, {
		action: "set_suggestions",
		node: "a",
		conversationId: original,
		suggestions: followUps,
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		const { focusOriginal, focusOther, focusNewChat, newChatTab } =
			await restoreTwoRetainedChats(page, "blocked-messages");
		await completeOneTurn(page, request);
		await expectChipsVisible(page);

		// The gateway goes away; the shipping status poll blocks the composer.
		await chatPageControl(request, {
			action: "set_gateway_reachable",
			reachable: false,
		});
		await expect(
			page.getByPlaceholder("Ask a follow up").filter({ visible: true })
		).toBeDisabled({ timeout: 15_000 });
		const beforeBlocked = await chatPageState(request);
		// A follow-up chip still submits; the blocked send is kept on screen
		// instead of being dropped.
		const blocked = followUps[0];
		await chip(page, blocked).click();
		const blockedMessage = page
			.getByText(blocked, { exact: true })
			.filter({ visible: true });
		await expect(blockedMessage).toBeVisible();
		await expectNoVisibleChips(page);

		await focusOther();
		await expect(blockedMessage).toBeHidden();
		await focusOriginal();
		await expect(blockedMessage).toBeVisible();

		await focusNewChat();
		await expect(blockedMessage).toBeHidden();
		await focusOriginal();
		await expect(blockedMessage).toBeVisible();
		await expect(
			page.getByPlaceholder("Ask a follow up").filter({ visible: true })
		).toBeDisabled();
		await expectNewChatTabTitled(newChatTab);

		// Blocked means never sent.
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

// The run completes while the user is looking at the other retained chat. The
// background chat must ask Core for its own conversation's follow-ups and read
// its own run diff, never the focused conversation's.
test("a retained chat whose run completes in the background fetches and keeps its own follow-ups", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const otherFollowUp = "Summarize the earlier thread.";
	await chatPageControl(request, {
		action: "reset",
		scenario: "queue-isolation",
	});
	for (const [conversationId, suggestions] of [
		[original, followUps],
		[other, [otherFollowUp]],
	] as const) {
		await chatPageControl(request, {
			action: "set_suggestions",
			node: "a",
			conversationId,
			suggestions,
		});
	}
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		const { focusOriginal, focusOther } = await restoreTwoRetainedChats(
			page,
			"queue-isolation"
		);
		await chatPageControl(request, {
			action: "arm_live_chat",
			node: "a",
			conversationId: original,
		});
		await page
			.getByPlaceholder("Ask a follow up")
			.filter({ visible: true })
			.fill(live);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(
			page.getByText("Owned live response in progress.", { exact: true })
		).toBeVisible();
		await focusOther();
		// Each open chat may read its own conversation's diff (the pinned summary
		// does). Let the focused chat's own reads settle first: the completed
		// background run must never read the focused conversation's diff.
		const originalDiff = `/api/worktree/${original}/diff`;
		const otherDiff = `/api/worktree/${other}/diff`;
		const diffReads = async (path: string) =>
			callsTo((await chatPageState(request)).calls, path).length;
		let otherDiffReads = -1;
		await expect
			.poll(
				async () => {
					const now = await diffReads(otherDiff);
					const settled = now === otherDiffReads;
					otherDiffReads = now;
					return settled;
				},
				{ intervals: [1000] }
			)
			.toBe(true);
		const diffReadsBefore = await diffReads(originalDiff);
		expect(
			await chatPageControl(request, {
				action: "finish_live_chat",
				node: "a",
				conversationId: original,
			})
		).toEqual({ finished: true });
		await expect
			.poll(
				async () =>
					callsTo((await chatPageState(request)).calls, "/api/chat/suggestions")
						.length
			)
			.toBe(1);
		const settled = await chatPageState(request);
		expect(callsTo(settled.calls, "/api/chat/suggestions")[0]).toMatchObject({
			node: "a",
			method: "POST",
			authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
			body: { conversation_id: original },
			status: "accepted",
		});
		// The finished run re-reads the diff of the conversation that ran, and
		// leaves the focused conversation's diff alone.
		await expect
			.poll(() => diffReads(originalDiff))
			.toBeGreaterThan(diffReadsBefore);
		expect(await diffReads(otherDiff)).toBe(otherDiffReads);
		// The focused chat shows no chips of its own or of the background run.
		await expectNoVisibleChips(page);
		await expect(
			page
				.getByRole("button", { name: otherFollowUp, exact: true })
				.filter({ visible: true })
		).toHaveCount(0);

		await focusOriginal();
		await expectChipsVisible(page);
		await expect(
			page
				.getByRole("button", { name: otherFollowUp, exact: true })
				.filter({ visible: true })
		).toHaveCount(0);
		const after = await expectSettledHarness(request, errors);
		expect(callsTo(after.calls, "/api/chat/suggestions")).toHaveLength(1);
		expect(after.histories).toEqual(settled.histories);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});

// Where the Changes pane lives depends on the tab layout. In the standard
// layouts, which this test and the thread-switch test below run in, Review
// opens it as a tab of the window's Right pane scoped to the open project
// (901edf7292, 19b388486e). It is not part of any one chat tab, so another
// chat's or a new chat tab's focus neither hides nor closes it, and it is not
// read again. The scrolling layout keeps a dock per chat; the scrolling-layout
// tests that follow cover it.
test("a Changes tab opened by Review stays on its turn's files while another chat or a new chat tab is focused", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, { action: "reset", scenario: "review-pane" });
	await chatPageControl(request, {
		action: "seed_conversation",
		node: "a",
		conversationId: original,
		messages: fileEditsHistory(),
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		const { focusOriginal, focusOther, focusNewChat, newChatTab } =
			await restoreTwoRetainedChats(page, "review-pane");
		await openReview(page);
		await expect(changesTabs(page)).toHaveCount(1);
		const settled = await chatPageState(request);
		const reads = callsTo(settled.calls, "/api/git/file-diff");
		expect(reads).toHaveLength(1);
		expect(reads[0]).toMatchObject({
			node: "a",
			method: "POST",
			authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
			body: {
				cwd: "/tmp/ryu-chat-controls-project",
				paths: ["src/status.txt"],
			},
			status: "accepted",
		});

		await focusOther();
		await expect(reviewLabel(page)).toBeVisible();
		await focusOriginal();
		await expect(reviewLabel(page)).toBeVisible();

		await focusNewChat();
		await expect(reviewLabel(page)).toBeVisible();
		await focusOriginal();
		await expect(reviewLabel(page)).toBeVisible();
		await expectNewChatTabTitled(newChatTab);
		await expect(changesTabs(page)).toHaveCount(1);

		// The tab was kept, not reopened: no second read of the turn's files.
		const after = await expectSettledHarness(request, errors);
		expect(callsTo(after.calls, "/api/git/file-diff")).toEqual(reads);

		// Review on the same turn again focuses that tab and reads the files again,
		// instead of stacking a second Changes tab.
		await page
			.getByRole("button", { name: "Review", exact: true })
			.filter({ visible: true })
			.click();
		await expect
			.poll(
				async () =>
					callsTo((await chatPageState(request)).calls, "/api/git/file-diff")
						.length
			)
			.toBe(2);
		await expect(changesTabs(page)).toHaveCount(1);
		await expect(reviewLabel(page)).toBeVisible();
		await expectSettledHarness(request, errors);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});

// The scrolling layout has no Right pane: every chat keeps its own right dock,
// side by side in one track, and ChatPage closes a chat's review pane when THIS
// tab's conversation changes, never when another tab's focus does.
test("in the scrolling layout, a chat's own file-review pane stays with it while another chat or a new chat tab is focused", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, { action: "reset", scenario: "review-pane" });
	await chatPageControl(request, {
		action: "seed_conversation",
		node: "a",
		conversationId: original,
		messages: fileEditsHistory(),
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		const { focusOriginal, focusOther, focusNewChat, newChatTab } =
			await restoreTwoRetainedChats(page, "review-pane", "scroll");
		await openReview(page, "keyboard");
		await expect(changesTabs(page)).toHaveCount(0);
		const settled = await chatPageState(request);
		const reads = callsTo(settled.calls, "/api/git/file-diff");
		expect(reads).toHaveLength(1);

		await focusOther();
		await expect(reviewLabel(page)).toBeVisible();
		await focusOriginal();
		await expect(reviewLabel(page)).toBeVisible();

		await focusNewChat();
		await expect(reviewLabel(page)).toBeVisible();
		await focusOriginal();
		await expect(reviewLabel(page)).toBeVisible();
		await expectNewChatTabTitled(newChatTab);

		// The pane was kept, not reopened: no second read of the turn's files.
		const after = await expectSettledHarness(request, errors);
		expect(callsTo(after.calls, "/api/git/file-diff")).toEqual(reads);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});

test("each retained chat loads its own thumbs once and does not reload them when another chat or a new chat tab is focused", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, {
		action: "reset",
		scenario: "queue-isolation",
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		const { focusOriginal, focusOther, focusNewChat, newChatTab } =
			await restoreTwoRetainedChats(page, "queue-isolation");
		// The composer guide says an empty idle Desktop composer offers the voice
		// call in its trailing slot (Send takes over once there is text).
		const idleComposer = page
			.getByPlaceholder("Ask a follow up")
			.filter({ visible: true });
		await expect(idleComposer).toHaveValue("");
		await expect(
			page
				.getByRole("button", { name: "Start voice call", exact: true })
				.filter({ visible: true })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Send", exact: true }).filter({
				visible: true,
			})
		).toHaveCount(0);
		const feedbackReads = async () =>
			(await chatPageState(request)).calls
				.filter(
					(call) =>
						call.method === "GET" &&
						/^\/api\/conversations\/[^/]+\/feedback$/.test(call.path)
				)
				.map((call) => call.path)
				.sort();
		// Both chats have now been focused once, so each page has mounted and
		// loaded the thumbs for its own conversation, and only for it. The
		// original's thumbs are read twice because the restore helper loads the
		// page twice (first load, then the reload from the seeded session); the
		// other chat's are read once. Reads keyed on the shared focused-tab id
		// made every mounted page read the focused conversation's thumbs on every
		// focus change.
		await focusOther();
		await focusOriginal();
		const settled = await feedbackReads();
		expect(settled).toEqual(
			[
				`/api/conversations/${original}/feedback`,
				`/api/conversations/${original}/feedback`,
				`/api/conversations/${other}/feedback`,
			].sort()
		);

		await focusNewChat();
		await focusOriginal();
		await focusOther();
		await focusOriginal();
		// Back to the new chat tab that is already open, then to the other chat.
		await newChatTab
			.getByRole("button", { name: "New chat", exact: true })
			.click();
		await expect(newChatTab).toHaveAttribute("data-active", "true");
		await focusOther();

		// Focus changes never reload or clear a retained chat's thumbs.
		expect(await feedbackReads()).toEqual(settled);
		await expectSettledHarness(request, errors);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});

test("choosing another thread in the merged agent view leaves the project's Changes tab on its turn's files", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const latest = "conversation-latest-thread-fixture";
	await chatPageControl(request, {
		action: "reset",
		scenario: "merged-thread-review",
	});
	await chatPageControl(request, {
		action: "seed_conversation",
		node: "a",
		conversationId: latest,
		messages: fileEditsHistory(),
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	try {
		await page.goto(
			"/chat-page-native-http.html?scenario=merged-thread-review"
		);
		const picker = page.getByRole("button", {
			name: "Choose which thread to send to",
		});
		await expect(picker).toContainText("Latest project thread");
		await openReview(page);
		await expect(changesTabs(page)).toHaveCount(1);

		await picker.click();
		await page
			.getByRole("menuitemradio", {
				name: "Earlier project thread",
				exact: true,
			})
			.click();
		await expect(picker).toContainText("Earlier project thread");
		// The earlier thread's own transcript is on screen, so the switch has
		// completed before the pane is checked.
		await expect(
			page
				.getByText("Earlier work is still readable here.", { exact: true })
				.filter({ visible: true })
		).toBeVisible();
		await expect(reviewLabel(page)).toBeVisible();
		await expect(changesTabs(page)).toHaveCount(1);

		const after = await expectSettledHarness(request, errors);
		expect(callsTo(after.calls, "/api/git/file-diff")).toHaveLength(1);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});

test("in the scrolling layout, switching this tab's thread in the merged agent view still closes its own file-review pane", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const latest = "conversation-latest-thread-fixture";
	await chatPageControl(request, {
		action: "reset",
		scenario: "merged-thread-review",
	});
	await chatPageControl(request, {
		action: "seed_conversation",
		node: "a",
		conversationId: latest,
		messages: fileEditsHistory(),
	});
	await page.setViewportSize({ width: 1480, height: 960 });
	await page.addInitScript(() =>
		localStorage.setItem("ryu_tab_layout", "scroll")
	);
	try {
		await page.goto(
			"/chat-page-native-http.html?scenario=merged-thread-review"
		);
		const picker = page.getByRole("button", {
			name: "Choose which thread to send to",
		});
		await expect(picker).toContainText("Latest project thread");
		await openReview(page);

		await picker.click();
		await page
			.getByRole("menuitemradio", {
				name: "Earlier project thread",
				exact: true,
			})
			.click();
		await expect(picker).toContainText("Earlier project thread");
		await expect(reviewLabel(page)).toHaveCount(0);

		const after = await expectSettledHarness(request, errors);
		expect(callsTo(after.calls, "/api/git/file-diff")).toHaveLength(1);
	} finally {
		await teardown(page);
	}
	expect(errors).toEqual([]);
});

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
