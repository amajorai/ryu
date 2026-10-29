import {
	assertNativeWindowLifetime,
	persistNativeLifetimeDiagnostics,
} from "./chat-page-native-http-lifetime.ts";
// Shipping ChatPage/useChat/AnswerNowButton and SDK, with finite native Core wire.
// The fixture completes its owned SSE response; no external model provider runs.
import {
	expect,
	test,
	type Page,
	type APIRequestContext,
} from "@playwright/test";
import {
	chatPageControl,
	chatPageState,
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
} from "./chat-page-native-http-support.ts";
const conversation = "conversation-toolbar-share-fixture";
const turn = "chat-page-owned-reasoning-turn";
const controlPath = "/api/chat/control";
const expectedBody = {
	action: "answer_now",
	conversation_id: conversation,
	turn_id: turn,
};
const errors = new WeakMap<Page, string[]>();
const failedStreams = new WeakMap<Page, string[]>();
async function state(request: APIRequestContext) {
	const result = await request.get("http://127.0.0.1:5591/__proof/state");
	expect(result.status()).toBe(200);
	return (await result.json()) as Awaited<ReturnType<typeof chatPageState>> & {
		liveChats: Array<{
			requestId: number;
			turnId?: string;
			answerNowAccepted?: boolean;
			completed?: boolean;
			requestAborted: boolean;
			readerCancelled: boolean;
			networkClosed: boolean;
			executionCancelled: boolean;
			fixtureClosed: boolean;
		}>;
	};
}
async function begin(page: Page, request: APIRequestContext, native = true) {
	await chatPageControl(request, { action: "reset", scenario: "share" });
	const pageErrors: string[] = [];
	const failures: string[] = [];
	errors.set(page, pageErrors);
	failedStreams.set(page, failures);
	page.on("pageerror", (e) => pageErrors.push(e.message));
	page.on("requestfailed", (req) => {
		if (req.url() === "http://127.0.0.1:5591/api/chat/stream")
			failures.push(req.failure()?.errorText ?? "unknown stream failure");
	});
	await page.goto("/chat-page-native-http.html?scenario=share");
	await expect(
		page.getByText("The organization copy is ready for review.", {
			exact: true,
		}),
	).toBeVisible();
	await chatPageControl(request, {
		action: native ? "arm_reasoning_chat" : "arm_live_chat",
		node: "a",
		conversationId: conversation,
	});
	await page
		.getByPlaceholder("Ask a follow up")
		.fill("Finish the native reasoning without stopping this turn.");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	if (native)
		await expect(
			page.getByRole("button", { name: "Answer now", exact: true }),
		).toBeVisible();
	else
		await expect(
			page.getByText("Owned live response in progress.", { exact: true }),
		).toBeVisible();
	await expect
		.poll(async () => (await state(request)).liveChats.length)
		.toBe(1);
}
function assertControls(
	calls: Awaited<ReturnType<typeof chatPageState>>["calls"],
	count: number,
) {
	const controls = calls.filter((c) => c.path === controlPath);
	expect(controls).toHaveLength(count);
	for (const call of controls) {
		expect(call.node).toBe("a");
		expect(call.method).toBe("POST");
		expect(call.authorization).toBe(`Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`);
		expect(call.userJwt).toBeNull();
		expect(call.body).toEqual(expectedBody);
		expect(call.rawBody).toBe(JSON.stringify(expectedBody));
	}
	expect(calls.filter((c) => c.path === "/api/chat/cancel")).toEqual([]);
	expect(
		calls.filter((c) => c.path === "/api/chat/stream" && c.method === "POST"),
	).toHaveLength(1);
}
async function finish(page: Page, request: APIRequestContext) {
	expect(
		await chatPageControl(request, {
			action: "finish_reasoning_answer",
			node: "a",
			conversationId: conversation,
			turnId: turn,
		}),
	).toEqual({ finished: true });
	await expect(
		page.getByText("Owned native answer continued.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Answer now", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Finishing answer", exact: true }),
	).toHaveCount(0);
	const snapshot = await state(request);
	expect(snapshot.liveChats[0]).toMatchObject({
		turnId: turn,
		answerNowAccepted: true,
		completed: true,
		requestAborted: false,
		readerCancelled: false,
		executionCancelled: false,
		fixtureClosed: false,
	});
	expect(failedStreams.get(page)).toEqual([]);
}
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
		expect.soft((await state(request)).unexpected).toEqual([]);
		expect.soft(errors.get(page) ?? []).toEqual([]);
		expect.soft(failedStreams.get(page) ?? []).toEqual([]);
		await page.evaluate(() =>
			Reflect.get(window, "__chatPageNativeFixture")?.unmount(),
		);
		await assertNativeWindowLifetime(page);
	} finally {
		await persistNativeLifetimeDiagnostics(testInfo, {
			beforeCleanup,
			afterCleanup: await captureNative(),
		});
	}
});
test("Answer now remains pending until the real Core acknowledgment, then the same native stream continues its final answer without Stop", async ({
	page,
	request,
}) => {
	await begin(page, request);
	await chatPageControl(request, {
		action: "hold_next",
		node: "a",
		method: "POST",
		path: controlPath,
	});
	await page.getByRole("button", { name: "Answer now", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Finishing answer", exact: true }),
	).toBeDisabled();
	await expect
		.poll(async () => (await state(request)).heldRequestIds.length)
		.toBe(1);
	const pending = await state(request);
	assertControls(pending.calls, 1);
	expect(pending.liveChats[0]).toMatchObject({
		answerNowAccepted: false,
		requestAborted: false,
		networkClosed: false,
		executionCancelled: false,
	});
	expect(
		await chatPageControl(request, {
			action: "release",
			requestId: pending.heldRequestIds[0],
			accept: true,
		}),
	).toEqual({ ok: true });
	await expect
		.poll(async () => (await state(request)).liveChats[0]?.answerNowAccepted)
		.toBe(true);
	await expect(
		page.getByRole("button", { name: "Finishing answer", exact: true }),
	).toBeDisabled();
	await finish(page, request);
	assertControls((await state(request)).calls, 1);
});
test("provider refusal is visible and keeps reasoning alive; identical real Answer now retry produces the final answer", async ({
	page,
	request,
}) => {
	await begin(page, request);
	await chatPageControl(request, {
		action: "refuse_next",
		node: "a",
		method: "POST",
		path: controlPath,
		status: 502,
		message: "Owned native provider refused Answer now.",
	});
	await page.getByRole("button", { name: "Answer now", exact: true }).click();
	await expect(
		page.getByText("Could not ask this turn to answer now.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Answer now", exact: true }),
	).toBeEnabled();
	const refused = await state(request);
	assertControls(refused.calls, 1);
	expect(refused.calls.find((c) => c.path === controlPath)).toMatchObject({
		status: "refused",
		responseStatus: 502,
	});
	expect(refused.liveChats[0]).toMatchObject({
		answerNowAccepted: false,
		requestAborted: false,
		networkClosed: false,
		executionCancelled: false,
	});
	await page.getByRole("button", { name: "Answer now", exact: true }).click();
	await expect
		.poll(async () => (await state(request)).liveChats[0]?.answerNowAccepted)
		.toBe(true);
	await finish(page, request);
	assertControls((await state(request)).calls, 2);
});
test("a genuinely streaming unsupported route never offers native Answer now or sends a control request", async ({
	page,
	request,
}) => {
	await begin(page, request, false);
	await expect(
		page.getByRole("button", { name: "Answer now", exact: true }),
	).toHaveCount(0);
	const snapshot = await state(request);
	assertControls(snapshot.calls, 0);
	expect(snapshot.liveChats[0]).toMatchObject({
		requestAborted: false,
		networkClosed: false,
		executionCancelled: false,
	});
});
