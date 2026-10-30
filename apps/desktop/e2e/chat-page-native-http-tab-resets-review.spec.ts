// Review panes, Changes tabs and thumbs stay with their own retained chat.
// Shared setup: `chat-page-native-http-tab-resets.ts`.

import { test } from "@playwright/test";
import {
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";
import {
	callsTo,
	changesTabs,
	expect,
	expectNewChatTabTitled,
	expectSettledHarness,
	fileEditsHistory,
	openReview,
	original,
	other,
	restoreTwoRetainedChats,
	reviewLabel,
	teardown,
} from "./chat-page-native-http-tab-resets.ts";

test.describe.configure({ timeout: 240_000 });

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
		// The composer guide: Send always stays in the last slot, dimmed and
		// disabled while the composer is empty, and Start voice call is its own
		// button beside the microphone.
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
		).toBeDisabled();
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
