import {
	assertNativeWindowLifetime,
	persistNativeLifetimeDiagnostics,
} from "./chat-page-native-http-lifetime.ts";
// Actual Layout/PinnedSummaryPanel/ChatPage callers and native browser HTTP.
// Core is a finite transport fixture: this proves next-turn handoff policy, not
// filesystem checkout or a model provider completing the requested response.
import {
	expect,
	type Page,
	type APIRequestContext,
	test,
} from "@playwright/test";
import {
	chatPageControl,
	chatPageState,
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
} from "./chat-page-native-http-support.ts";
const CONVERSATION = "conversation-toolbar-share-fixture";
const FOLDER = "/tmp/ryu-chat-controls-project";
function isChatOrGitMutation(call: { method: string; path: string }) {
	// Layout also requests WebSocket tickets, saves its project and refreshes
	// entitlement preferences. Those are independently gated by the finite host;
	// this caller proof checks the mutations this action can actually request.
	return (
		call.method !== "GET" &&
		(call.path === "/api/chat/stream" ||
			call.path === "/api/chat/cancel" ||
			call.path.startsWith("/api/git/") ||
			call.path.startsWith("/api/worktree/"))
	);
}
const errors = new WeakMap<Page, string[]>();
async function open(page: Page) {
	await page.setViewportSize({ width: 1480, height: 960 });
	const pageErrors: string[] = [];
	errors.set(page, pageErrors);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/chat-page-native-http.html?scenario=worktree-handoff");
	await expect(
		page.getByText("We need to share the launch plan with the organization.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Environment", exact: true }),
	).toBeVisible();
}
async function dialog(page: Page) {
	const section = page.getByRole("button", {
		name: "Environment",
		exact: true,
	});
	if ((await section.getAttribute("aria-expanded")) !== "true")
		await section.click();
	await expect(section).toHaveAttribute("aria-expanded", "true");
	await page.getByTestId("open-worktree-handoff").click();
	const result = page.getByRole("dialog", {
		name: "Hand off chat to worktree",
		exact: true,
	});
	await expect(result).toBeVisible();
	return result;
}
async function handOff(page: Page, branch: string) {
	const d = await dialog(page);
	await d.getByLabel("Branch name").fill(branch);
	await d.getByRole("button", { name: "Hand off", exact: true }).click();
	await expect(d).toBeHidden();
}
async function saved(page: Page) {
	return page.evaluate(() => {
		const tabs = JSON.parse(localStorage.getItem("ryu_session_tabs") ?? "{}");
		return {
			branch: localStorage.getItem("ryu_workspace_worktree_branch"),
			mode: localStorage.getItem("ryu_workspace_worktree_mode"),
			tab: tabs.tabs?.find(
				(t: { conversationId?: string }) =>
					t.conversationId === "conversation-toolbar-share-fixture",
			)?.worktreeMode,
		};
	});
}
async function send(page: Page, prompt: string) {
	await page.getByPlaceholder("Ask a follow up").fill(prompt);
	await expect(
		page.getByRole("button", { name: "Send", exact: true }),
	).toBeEnabled();
	await page.getByRole("button", { name: "Send", exact: true }).click();
}
test.beforeEach(async ({ request }) => {
	await chatPageControl(request, {
		action: "reset",
		scenario: "worktree-handoff",
	});
});
test.afterEach(async ({ page, request }, testInfo) => {
	// Observe actual event ownership; these diagnostics do not alter cleanup oracles.
	const captureNative = async () => {
		try {
			return await page.evaluate(() => {
				const fixture = Reflect.get(window, "__chatPageNativeFixture");
				return fixture
					? {
							snapshot: fixture.nativeSnapshot(),
							details: fixture.nativeDiagnostics?.() ?? null,
						}
					: null;
			});
		} catch (error) {
			return { diagnosticCaptureError: String(error) };
		}
	};
	const beforeCleanup = await captureNative();
	try {
		expect((await chatPageState(request)).unexpected).toEqual([]);
		expect(errors.get(page) ?? []).toEqual([]);
		const mounted = await page.evaluate(() => {
			const fixture = Reflect.get(window, "__chatPageNativeFixture");
			if (!fixture) return false;
			fixture.unmount();
			return true;
		});
		if (mounted) await assertNativeWindowLifetime(page);
	} finally {
		await persistNativeLifetimeDiagnostics(testInfo, {
			beforeCleanup,
			afterCleanup: await captureNative(),
		});
	}
});
async function liveState(request: APIRequestContext): Promise<{
	liveChats: Array<{
		requestId: number;
		node: string;
		conversationId: string;
		requestAborted: boolean;
		readerCancelled: boolean;
		networkClosed: boolean;
		executionCancelled: boolean;
		fixtureClosed: boolean;
	}>;
}> {
	const response = await request.get("http://127.0.0.1:5591/__proof/state");
	expect(response.status()).toBe(200);
	return response.json();
}
test("actual running handoff cancels the authenticated old turn and genuine browser SSE before the next isolated turn", async ({
	page,
	request,
}) => {
	await open(page);
	await chatPageControl(request, {
		action: "arm_live_chat",
		node: "a",
		conversationId: CONVERSATION,
	});
	const opening = page.waitForRequest(
		(req) =>
			req.method() === "POST" &&
			req.url() === "http://127.0.0.1:5591/api/chat/stream",
	);
	await send(page, "Keep this response open until handoff.");
	const streamRequest = await opening;
	await expect(
		page.getByText("Owned live response in progress.", { exact: true }),
	).toBeVisible();
	const before = await saved(page),
		d = await dialog(page);
	await expect(d.getByRole("alert")).toContainText(
		"This chat is running, so handing it off will interrupt the current response",
	);
	await d.press("Escape");
	await expect(d).toBeHidden();
	expect(await saved(page)).toEqual(before);
	expect((await liveState(request)).liveChats).toEqual([
		expect.objectContaining({
			node: "a",
			conversationId: CONVERSATION,
			requestAborted: false,
			networkClosed: false,
			executionCancelled: false,
			fixtureClosed: false,
		}),
	]);
	expect(
		(await chatPageState(request)).calls.filter(
			(call) => call.path === "/api/chat/cancel",
		),
	).toEqual([]);
	const closed = page.waitForEvent("requestfailed", {
		predicate: (req) => req === streamRequest,
	});
	await handOff(page, "  ryu/running-handoff-proof  ");
	const failed = await closed;
	expect(failed.failure()?.errorText).toMatch(/ERR_ABORTED|aborted/i);
	await expect
		.poll(async () => (await liveState(request)).liveChats[0])
		.toMatchObject({
			node: "a",
			conversationId: CONVERSATION,
			requestAborted: true,
			networkClosed: true,
			executionCancelled: true,
			fixtureClosed: false,
		});
	await expect
		.poll(() => saved(page))
		.toEqual({ branch: "ryu/running-handoff-proof", mode: "true", tab: true });
	const stopped = await chatPageState(request),
		cancellations = stopped.calls.filter(
			(call) => call.path === "/api/chat/cancel",
		);
	expect(cancellations).toHaveLength(1);
	expect(cancellations[0]).toMatchObject({
		node: "a",
		method: "POST",
		authorization: "Bearer " + CHAT_PAGE_NATIVE_NODE_A_TOKEN,
		userJwt: null,
		body: { conversation_id: CONVERSATION },
		responseStatus: 200,
	});
	expect(
		stopped.calls.filter(
			(call) => call.node === "b" && isChatOrGitMutation(call),
		),
	).toEqual([]);
	await expect(page.getByPlaceholder("Ask a follow up")).toBeEditable();
	await send(page, "Continue the next turn in the handed-off worktree.");
	await expect
		.poll(
			async () =>
				(await chatPageState(request)).calls.filter(
					(call) => call.path === "/api/chat/stream",
				).length,
		)
		.toBe(2);
	const turns = (await chatPageState(request)).calls.filter(
		(call) => call.path === "/api/chat/stream",
	);
	expect(turns[0]).toMatchObject({
		node: "a",
		authorization: "Bearer " + CHAT_PAGE_NATIVE_NODE_A_TOKEN,
		userJwt: null,
		body: expect.objectContaining({
			conversation_id: CONVERSATION,
			cwd: FOLDER,
		}),
	});
	expect(turns[1]).toMatchObject({
		node: "a",
		authorization: "Bearer " + CHAT_PAGE_NATIVE_NODE_A_TOKEN,
		userJwt: null,
		responseStatus: 503,
		body: expect.objectContaining({
			conversation_id: CONVERSATION,
			cwd: FOLDER,
			worktree_isolation: true,
			worktree_branch: "ryu/running-handoff-proof",
		}),
	});
	expect((await liveState(request)).liveChats).toHaveLength(1);
});
