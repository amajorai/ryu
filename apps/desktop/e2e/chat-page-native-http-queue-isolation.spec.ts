import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type { Call } from "./chat-page-native-http.host.ts";
import { assertNativeWindowLifetime } from "./chat-page-native-http-lifetime.ts";
import {
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";

const original = "conversation-toolbar-share-fixture";
const other = "conversation-earlier-thread-fixture";

// Seed the genuine durable session format before an independent renderer
// reload. Actual tab restoration and subsequent clicks own navigation.
// The Workbench v2 snapshot is the authoritative restored layout; the first
// visit wrote one with only the original tab. Removing it restores through
// the shipping legacy-session migration path, which honors `activeIndex`,
// instead of an internally inconsistent pair of durable records.
async function restoreTwoRetainedChats(page: Page) {
	await page.goto("/chat-page-native-http.html?scenario=queue-isolation");
	await expect(
		page.getByText("We need to share the launch plan with the organization.", {
			exact: true,
		})
	).toBeVisible();
	await page.evaluate(
		({ original, other }) => {
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
						{
							path: "/chat",
							conversationId: original,
							title: "Toolbar share regression fixture",
						},
						{
							path: "/chat",
							conversationId: other,
							title: "Earlier project thread",
						},
					],
				})
			);
		},
		{ original, other }
	);
	await page.reload();
	await expect(
		page.getByPlaceholder("Ask a follow up").filter({ visible: true })
	).toBeVisible();
	// Shipping title-bar tabs: the wrapper carries `data-active`; the title
	// button inside it activates the tab.
	const titleBarTab = (title: string) =>
		page.locator("[data-tab-appearance][data-active]").filter({
			has: page.getByRole("button", { name: title, exact: true }),
		});
	return {
		originalTab: titleBarTab("Toolbar share regression fixture"),
		otherTab: titleBarTab("Earlier project thread"),
	};
}

function streamCalls(calls: Call[]) {
	return calls.filter((call) => call.path === "/api/chat/stream");
}

// The text the composer submitted: the first text part of the newest user
// message in the AI SDK request body (model context parts follow it).
function submittedText(call: Call | undefined) {
	const messages = (call?.body as { messages?: unknown } | undefined)?.messages;
	if (!Array.isArray(messages)) {
		return null;
	}
	const users = messages.filter(
		(message): message is { parts: Array<{ type: string; text?: string }> } =>
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "user" &&
			Array.isArray((message as { parts?: unknown }).parts)
	);
	return users.at(-1)?.parts.find((part) => part.type === "text")?.text ?? null;
}

async function finishLiveTurn(request: APIRequestContext) {
	expect(
		await chatPageControl(request, {
			action: "finish_live_chat",
			node: "a",
			conversationId: original,
		})
	).toEqual({ finished: true });
}

// Actual Layout, retained ChatPage instances, history provider, composer and
// authenticated native HTTP. The finite host does not execute a model provider.
test("focusing another retained chat conserves the original queued message without dispatching it", async ({
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
		const { originalTab, otherTab } = await restoreTwoRetainedChats(page);
		// The restored focus is the original conversation, so the first send is
		// owned by it rather than by whichever retained tab mounted last.
		await expect(originalTab).toHaveAttribute("data-active", "true");
		await expect(otherTab).toHaveAttribute("data-active", "false");
		await chatPageControl(request, {
			action: "arm_live_chat",
			node: "a",
			conversationId: original,
		});
		await page
			.getByPlaceholder("Ask a follow up")
			.filter({ visible: true })
			.fill("Keep this owned response streaming.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(
			page.getByText("Owned live response in progress.", { exact: true })
		).toBeVisible();
		const queued = "Conserve this queued original-tab draft.";
		const nextQueued = "Retain this second original-tab queued message.";
		const composer = page
			.getByPlaceholder("Send a message…")
			.filter({ visible: true });
		await composer.fill(queued);
		await composer.press("Enter");
		await expect(page.getByText(queued, { exact: true })).toBeVisible();
		await composer.fill(nextQueued);
		await composer.press("Enter");
		await expect(page.getByText(nextQueued, { exact: true })).toBeVisible();
		const queueHandles = page.getByRole("button", {
			name: /^Reorder queued message [12]$/,
		});
		await expect(queueHandles).toHaveCount(2);
		const firstQueued = page.getByRole("button", {
			name: "Reorder queued message 1",
			exact: true,
		});
		const secondQueued = page.getByRole("button", {
			name: "Reorder queued message 2",
			exact: true,
		});
		await expect(firstQueued.locator("..")).toContainText(queued);
		await expect(secondQueued.locator("..")).toContainText(nextQueued);
		await expect(
			page.getByRole("button", {
				name: "Reorder queued message 1",
				exact: true,
			})
		).toBeVisible();
		const before = await chatPageState(request);
		const streamCalls = before.calls.filter(
			(call) => call.path === "/api/chat/stream"
		);
		expect(streamCalls).toHaveLength(1);
		expect(streamCalls[0]).toMatchObject({
			node: "a",
			authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
			userJwt: null,
			body: expect.objectContaining({ conversation_id: original }),
		});
		await otherTab
			.getByRole("button", { name: "Earlier project thread", exact: true })
			.click();
		await expect(otherTab).toHaveAttribute("data-active", "true");
		await expect(originalTab).toHaveAttribute("data-active", "false");
		await expect(
			page.getByPlaceholder("Ask a follow up").filter({ visible: true })
		).toBeVisible();
		await expect(page.getByText(queued, { exact: true })).toBeHidden();
		await expect(page.getByText(nextQueued, { exact: true })).toBeHidden();
		await originalTab
			.getByRole("button", {
				name: "Toolbar share regression fixture",
				exact: true,
			})
			.click();
		await expect(originalTab).toHaveAttribute("data-active", "true");
		await expect(page.getByText(queued, { exact: true })).toBeVisible();
		await expect(page.getByText(nextQueued, { exact: true })).toBeVisible();
		await expect(queueHandles).toHaveCount(2);
		await expect(firstQueued.locator("..")).toContainText(queued);
		await expect(secondQueued.locator("..")).toContainText(nextQueued);
		await expect(
			page.getByRole("button", {
				name: "Reorder queued message 1",
				exact: true,
			})
		).toBeVisible();
		await expect(
			page.getByPlaceholder("Send a message…").filter({ visible: true })
		).toBeVisible();
		const liveResponse = await request.get(
			"http://127.0.0.1:5591/__proof/state"
		);
		expect(liveResponse.status()).toBe(200);
		const liveState = await liveResponse.json();
		expect(liveState.liveChats).toHaveLength(1);
		expect(liveState.liveChats[0]).toMatchObject({
			node: "a",
			conversationId: original,
			networkClosed: false,
			executionCancelled: false,
			fixtureClosed: false,
		});
		const after = await chatPageState(request);
		expect(
			after.calls.filter((call) => call.path === "/api/chat/stream")
		).toEqual(streamCalls);
		expect(after.histories).toEqual(before.histories);
		expect(after.unexpected).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await page.evaluate(() =>
			Reflect.get(window, "__chatPageNativeFixture")?.unmount()
		);
		await assertNativeWindowLifetime(page);
	}
	expect(errors).toEqual([]);
});

// The live run completes while the user is looking at the other retained chat.
// The background tab's queue must dispatch its own turns, one per completed
// run and in order, to the conversation they were typed in, never to the
// focused conversation.
test("queued messages drain in order into their own conversation after its live run completes while another retained chat is focused", async ({
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
		const { originalTab, otherTab } = await restoreTwoRetainedChats(page);
		await expect(originalTab).toHaveAttribute("data-active", "true");
		await expect(otherTab).toHaveAttribute("data-active", "false");
		const live = "Keep this owned response streaming.";
		const queued = "Drain this first queued original-tab message.";
		const nextQueued = "Drain this second queued original-tab message.";
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
		const composer = page
			.getByPlaceholder("Send a message…")
			.filter({ visible: true });
		await composer.fill(queued);
		await composer.press("Enter");
		await composer.fill(nextQueued);
		await composer.press("Enter");
		const queueHandles = page.getByRole("button", {
			name: /^Reorder queued message \d+$/,
		});
		const firstQueued = page.getByRole("button", {
			name: "Reorder queued message 1",
			exact: true,
		});
		await expect(queueHandles).toHaveCount(2);
		await expect(firstQueued.locator("..")).toContainText(queued);
		await expect(
			page
				.getByRole("button", { name: "Reorder queued message 2", exact: true })
				.locator("..")
		).toContainText(nextQueued);
		const before = await chatPageState(request);
		expect(streamCalls(before.calls)).toHaveLength(1);
		expect(submittedText(streamCalls(before.calls)[0])).toBe(live);

		await otherTab
			.getByRole("button", { name: "Earlier project thread", exact: true })
			.click();
		await expect(otherTab).toHaveAttribute("data-active", "true");
		await expect(originalTab).toHaveAttribute("data-active", "false");
		await expect(
			page.getByPlaceholder("Ask a follow up").filter({ visible: true })
		).toBeVisible();

		// First completion: exactly one queued turn, the oldest, is sent.
		await chatPageControl(request, {
			action: "arm_live_chat",
			node: "a",
			conversationId: original,
		});
		await finishLiveTurn(request);
		await expect
			.poll(
				async () => streamCalls((await chatPageState(request)).calls).length
			)
			.toBe(2);
		const afterFirst = streamCalls((await chatPageState(request)).calls);
		expect(afterFirst[1]).toMatchObject({
			node: "a",
			method: "POST",
			authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
			userJwt: null,
			body: expect.objectContaining({ conversation_id: original }),
		});
		expect(submittedText(afterFirst[1])).toBe(queued);
		await expect(otherTab).toHaveAttribute("data-active", "true");

		await originalTab
			.getByRole("button", {
				name: "Toolbar share regression fixture",
				exact: true,
			})
			.click();
		await expect(originalTab).toHaveAttribute("data-active", "true");
		await expect(queueHandles).toHaveCount(1);
		await expect(firstQueued.locator("..")).toContainText(nextQueued);
		await expect(firstQueued.locator("..")).not.toContainText(queued);

		// Second completion drains the remaining turn.
		await chatPageControl(request, {
			action: "arm_live_chat",
			node: "a",
			conversationId: original,
		});
		await finishLiveTurn(request);
		await expect
			.poll(
				async () => streamCalls((await chatPageState(request)).calls).length
			)
			.toBe(3);
		await expect(queueHandles).toHaveCount(0);

		// The last run completes with nothing queued: the composer returns to
		// idle and nothing else is sent.
		await finishLiveTurn(request);
		await expect(
			page.getByPlaceholder("Ask a follow up").filter({ visible: true })
		).toBeVisible();
		const after = await chatPageState(request);
		const calls = streamCalls(after.calls);
		expect(calls.map(submittedText)).toEqual([live, queued, nextQueued]);
		for (const call of calls) {
			expect(call).toMatchObject({
				node: "a",
				authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
				body: expect.objectContaining({ conversation_id: original }),
			});
		}
		const liveResponse = await request.get(
			"http://127.0.0.1:5591/__proof/state"
		);
		expect(liveResponse.status()).toBe(200);
		const liveState = await liveResponse.json();
		expect(liveState.liveChats).toEqual(
			calls.map((call) =>
				expect.objectContaining({
					requestId: call.id,
					node: "a",
					conversationId: original,
					completed: true,
					requestAborted: false,
					readerCancelled: false,
					networkClosed: true,
					executionCancelled: false,
					fixtureClosed: false,
				})
			)
		);
		expect(after.histories).toEqual(before.histories);
		expect(after.unexpected).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await page.evaluate(() =>
			Reflect.get(window, "__chatPageNativeFixture")?.unmount()
		);
		await assertNativeWindowLifetime(page);
	}
	expect(errors).toEqual([]);
});
