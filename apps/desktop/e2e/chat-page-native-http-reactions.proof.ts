import {
	assertNativeWindowLifetime,
	persistNativeLifetimeDiagnostics,
} from "./chat-page-native-http-lifetime.ts";
import {
	expect,
	test,
	type APIRequestContext,
	type Page,
} from "@playwright/test";
import type { Call } from "./chat-page-native-http.host.ts";
import { REACTION_MESSAGE_ID } from "./chat-page-native-http-reactions.ts";
import {
	CHAT_PAGE_NATIVE_CORE_A,
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
	chatPageControl,
} from "./chat-page-native-http-support.ts";
const conversation = "conversation-toolbar-share-fixture";
const list = `/api/conversations/${conversation}/reactions`;
const path = `/api/conversations/${conversation}/messages/${REACTION_MESSAGE_ID}/reactions`;
const errors = new WeakMap<Page, string[]>();
async function state(request: APIRequestContext): Promise<{
	calls: Call[];
	unexpected: unknown[];
	heldRequestIds: number[];
	reactions: Record<string, string[]>;
}> {
	const r = await request.get(`${CHAT_PAGE_NATIVE_CORE_A}/__proof/state`);
	expect(r.status()).toBe(200);
	return r.json();
}
const writes = (calls: Call[]) =>
	calls.filter(
		(call) => call.path === path && ["POST", "DELETE"].includes(call.method),
	);
function assertWrite(call: Call | undefined, method: string, emoji: string) {
	if (!call) throw new Error("Reaction HTTP write was never captured");
	expect(call).toMatchObject({
		node: "a",
		method,
		path,
		authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
		userJwt: null,
		body: { emoji },
		rawBody: JSON.stringify({ emoji }),
	});
	expect(call.contentType).toContain("application/json");
}
async function openReaction(page: Page) {
	const turn = page
		.locator('[data-slot="message-scroller-item"]')
		.filter({ hasText: "The organization copy is ready for review." });
	await expect(turn).toBeVisible();
	await turn.hover();
	const trigger = turn
		.getByRole("button", { name: "Add reaction", exact: true })
		.last();
	await expect(trigger).toBeVisible();
	await trigger.click();
}
async function assertBucket(page: Page, emoji: string) {
	await openReaction(page);
	await expect(
		page.getByRole("button", { name: `${emoji} 1`, exact: true }),
	).toHaveAttribute("aria-pressed", "true");
}
async function freshReadback(
	page: Page,
	request: APIRequestContext,
	emoji: string | null,
) {
	const before = (await state(request)).calls.filter(
		(call) => call.path === list && call.method === "GET",
	).length;
	await page.reload();
	await expect
		.poll(
			async () =>
				(await state(request)).calls.filter(
					(call) => call.path === list && call.method === "GET",
				).length,
		)
		.toBeGreaterThan(before);
	await openReaction(page);
	if (emoji)
		await expect(
			page.getByRole("button", { name: `${emoji} 1`, exact: true }),
		).toHaveAttribute("aria-pressed", "true");
	else
		await expect(page.getByRole("button", { name: /^[👍🎉] 1$/ })).toHaveCount(
			0,
		);
}
test.beforeEach(async ({ page, request }) => {
	const list: string[] = [];
	errors.set(page, list);
	page.on("pageerror", (error) => list.push(error.message));
	await chatPageControl(request, {
		action: "reset",
		scenario: "message-reactions-caller",
	});
	await page.goto(
		"/chat-page-native-http.html?scenario=message-reactions-caller",
	);
	await expect(
		page.getByText("The organization copy is ready for review.", {
			exact: true,
		}),
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await state(request)).calls.filter(
					(call) =>
						call.path === `/api/conversations/${conversation}/reactions` &&
						call.method === "GET",
				).length,
		)
		.toBe(1);
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
		for (const id of (await state(request)).heldRequestIds)
			await chatPageControl(request, {
				action: "release",
				requestId: id,
				accept: false,
			});
		expect((await state(request)).unexpected).toEqual([]);
		expect((await state(request)).heldRequestIds).toEqual([]);
		expect(errors.get(page)).toEqual([]);
		await page.evaluate(() =>
			Reflect.get(window, "__chatPageNativeFixture").unmount(),
		);
		await assertNativeWindowLifetime(page);
	} finally {
		await persistNativeLifetimeDiagnostics(testInfo, {
			beforeCleanup,
			afterCleanup: await captureNative(),
		});
	}
});
test("the actual full Emoji picker chooses a saved message reaction, restores it from HTTP after reload and removes it through the existing chip", async ({
	page,
	request,
}) => {
	await openReaction(page);
	await page.getByRole("button", { name: "More emoji", exact: true }).click();
	const picker = page.locator("em-emoji-picker");
	await expect(picker).toBeVisible();
	await picker.getByPlaceholder("Search").fill("party popper");
	await picker.getByRole("button", { name: "🎉", exact: true }).click();
	await expect
		.poll(async () => (await state(request)).reactions.a)
		.toEqual(["🎉"]);
	assertWrite(writes((await state(request)).calls)[0], "POST", "🎉");
	await freshReadback(page, request, "🎉");
	await page.getByRole("button", { name: "🎉 1", exact: true }).click();
	await expect.poll(async () => (await state(request)).reactions.a).toEqual([]);
	const saved = await state(request);
	expect(writes(saved.calls)).toHaveLength(2);
	assertWrite(writes(saved.calls)[1], "DELETE", "🎉");
	await freshReadback(page, request, null);
	expect(writes((await state(request)).calls)).toHaveLength(2);
});
test("held refused Add rolls back the optimistic chip, retry uses actual picker and fresh bulk GET agrees with accepted storage", async ({
	page,
	request,
}) => {
	await chatPageControl(request, {
		action: "hold_next",
		node: "a",
		method: "POST",
		path,
		status: 503,
	});
	await openReaction(page);
	await page
		.getByRole("button", { name: "Add 👍 reaction", exact: true })
		.click();
	await expect
		.poll(async () => (await state(request)).heldRequestIds.length)
		.toBe(1);
	expect((await state(request)).reactions).toEqual({});
	await assertBucket(page, "👍");
	const id = (await state(request)).heldRequestIds[0];
	if (id === undefined) throw new Error("Held Add missing");
	await chatPageControl(request, {
		action: "release",
		requestId: id,
		accept: false,
	});
	await expect(
		page.getByRole("button", { name: "👍 1", exact: true }),
	).toHaveCount(0);
	expect((await state(request)).reactions).toEqual({});
	assertWrite(writes((await state(request)).calls)[0], "POST", "👍");
	await page
		.getByRole("button", { name: "Add 👍 reaction", exact: true })
		.click();
	await expect
		.poll(async () => (await state(request)).reactions.a)
		.toEqual(["👍"]);
	const saved = await state(request);
	expect(writes(saved.calls)).toHaveLength(2);
	assertWrite(writes(saved.calls)[1], "POST", "👍");
	expect(writes(saved.calls).map((call) => call.responseStatus)).toEqual([
		503, 200,
	]);
	await freshReadback(page, request, "👍");
});
test("refused Remove retains the owned saved reaction and membership; a real chip retry removes it and reload cannot resurrect it", async ({
	page,
	request,
}) => {
	await openReaction(page);
	await page
		.getByRole("button", { name: "Add 👍 reaction", exact: true })
		.click();
	await expect
		.poll(async () => (await state(request)).reactions.a)
		.toEqual(["👍"]);
	await chatPageControl(request, {
		action: "refuse_next",
		node: "a",
		method: "DELETE",
		path,
		status: 503,
	});
	await assertBucket(page, "👍");
	await page.getByRole("button", { name: "👍 1", exact: true }).click();
	await expect
		.poll(
			async () =>
				writes((await state(request)).calls).filter(
					(call) => call.responseStatus === 503,
				).length,
		)
		.toBe(1);
	expect((await state(request)).reactions.a).toEqual(["👍"]);
	await assertBucket(page, "👍");
	await page.getByRole("button", { name: "👍 1", exact: true }).click();
	await expect.poll(async () => (await state(request)).reactions.a).toEqual([]);
	const saved = await state(request);
	expect(writes(saved.calls)).toHaveLength(3);
	assertWrite(writes(saved.calls)[1], "DELETE", "👍");
	assertWrite(writes(saved.calls)[2], "DELETE", "👍");
	await freshReadback(page, request, null);
});
