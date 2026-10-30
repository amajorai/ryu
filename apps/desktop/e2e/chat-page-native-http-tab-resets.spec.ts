// Follow-up chips, blocked messages and background completion stay with their own retained chat.
// Shared setup: `chat-page-native-http-tab-resets.ts`.

import { test } from "@playwright/test";
import {
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";
import {
	callsTo,
	chip,
	completeOneTurn,
	expect,
	expectChipsVisible,
	expectNewChatTabTitled,
	expectNoVisibleChips,
	expectSettledHarness,
	followUps,
	live,
	original,
	other,
	restoreTwoRetainedChats,
	teardown,
} from "./chat-page-native-http-tab-resets.ts";

test.describe.configure({ timeout: 240_000 });

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
