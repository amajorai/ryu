// Shared setup for the ChatPage tab-reset specs
// (`chat-page-native-http-tab-resets*.spec.ts`), split from one spec by test
// group. Per-tab chat state that must not be reset by another tab's focus:
// follow-up chips (and their in-flight request) and blocked messages. Every
// chat tab stays mounted, and the focused tab mirrors its conversation into one
// shared id, so a reset keyed on that shared id fires in every background tab.

import {
	type APIRequestContext,
	expect as baseExpect,
	type Locator,
	type Page,
} from "@playwright/test";
import type { Call } from "./chat-page-native-http.host.ts";
import { assertNativeWindowLifetime } from "./chat-page-native-http-lifetime.ts";
import {
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";

// The shared host compiles the full Layout graph on first navigation; under
// load a cold restore takes well over the default five seconds.
export const expect = baseExpect.configure({ timeout: 20_000 });

export const original = "conversation-toolbar-share-fixture";
export const other = "conversation-earlier-thread-fixture";
export const originalTitle = "Toolbar share regression fixture";
export const otherTitle = "Earlier project thread";
export const live = "Keep this owned response streaming.";
export const followUps = [
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
export async function restoreTwoRetainedChats(
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
			// The layout is sealed with the desktop content key; drop it through
			// the shipping facade, which also removes its sealed slot.
			(
				Reflect.get(window, "__chatPageNativeFixture") as {
					removeSealedLocalItem: (key: string) => void;
				}
			).removeSealedLocalItem("ryu_workbench_layout_v2");
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
export async function scrollingChatTabs(page: Page) {
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
export async function expectNewChatTabTitled(newChatTab: Locator) {
	await expect(
		newChatTab.getByRole("button", { name: "New chat", exact: true })
	).toBeVisible();
	await expect(
		newChatTab.getByRole("button", { name: originalTitle, exact: true })
	).toHaveCount(0);
}

export function callsTo(calls: Call[], path: string) {
	return calls.filter((call) => call.path === path);
}

// One owned turn in the focused original chat, completed the way a provider
// completes it. Returns once the composer is idle again.
export async function completeOneTurn(page: Page, request: APIRequestContext) {
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
export function chip(page: Page, label: string) {
	return page
		.locator('[data-chat-transcript="true"]')
		.getByRole("button", { name: label, exact: true })
		.filter({ visible: true });
}

export async function expectChipsVisible(page: Page) {
	for (const label of followUps) {
		await expect(chip(page, label)).toBeVisible();
	}
}

export async function expectNoVisibleChips(page: Page) {
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
export const reviewUserText =
	"We need to share the launch plan with the organization.";
export const reviewAssistantText = "Updated status file.";
export function fileEditsHistory() {
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
export function reviewLabel(page: Page) {
	return page
		.getByText("Files from this turn", { exact: true })
		.filter({ visible: true });
}

// In the standard tab layouts the Changes pane is a tab of the window's Right
// pane, scoped to the open project: Review opens it, or focuses the one that is
// already open.
export function changesTabs(page: Page) {
	return page
		.getByRole("tablist", { name: "Right tabs" })
		.getByRole("tab", { name: "Changes", exact: true });
}

// `how: "keyboard"` presses Review with Enter. In the scrolling layout with two
// chats, a floating pinned-summary panel covers the button and intercepts a
// pointer click, so that layout presses it from the keyboard.
export async function openReview(
	page: Page,
	how: "click" | "keyboard" = "click"
) {
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

export async function expectSettledHarness(
	request: APIRequestContext,
	errors: string[]
) {
	const state = await chatPageState(request);
	expect(state.unexpected).toEqual([]);
	expect(errors).toEqual([]);
	return state;
}

export async function teardown(page: Page) {
	await page.evaluate(() =>
		Reflect.get(window, "__chatPageNativeFixture")?.unmount()
	);
	await assertNativeWindowLifetime(page);
}
