import { expect, test, type Page } from "@playwright/test";
import {
	chatPageControl,
	chatPageState,
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
} from "./chat-page-native-http-support.ts";
import {
	PLAN_MESSAGES,
	PLAN_TITLE,
	PLAN_MARKDOWN,
} from "./chat-page-native-http-plans.ts";
import {
	assertNativeWindowLifetime,
	persistNativeLifetimeDiagnostics,
} from "./chat-page-native-http-lifetime.ts";
import type { Node } from "../src/store/useNodeStore.ts";
const CONVERSATION = "conversation-toolbar-share-fixture";
const DOCS = "/api/spaces/artifacts-owned/documents";
const errors = new WeakMap<Page, string[]>();
async function state(request: Parameters<typeof chatPageState>[0]) {
	const value = await chatPageState(request);
	return value as typeof value & {
		planDocuments: Record<
			string,
			{ id: string; title: string; source: string }
		>;
	};
}
async function rotate(
	page: Page,
	request: Parameters<typeof chatPageControl>[0],
	jwt: string
) {
	await chatPageControl(request, {
		action: "set_node_authority",
		node: "a",
		token: CHAT_PAGE_NATIVE_NODE_A_TOKEN,
		userJwt: jwt,
	});
	await page.evaluate((userJwt) => {
		const fixture = Reflect.get(window, "__chatPageNativeFixture");
		if (!fixture) throw Error("Actual native ChatPage fixture absent");
		fixture.nodeStore.setState((s: { nodes: Node[] }) => ({
			nodes: s.nodes.map((node) =>
				node.url === "http://127.0.0.1:5591" ? { ...node, userJwt } : node
			),
		}));
	}, jwt);
}
async function open(page: Page) {
	const captured: string[] = [];
	errors.set(page, captured);
	page.on("pageerror", (e) => captured.push(e.message));
	await page.goto("/chat-page-native-http.html?scenario=plan-persistence");
	await expect(
		page.getByText("A completed launch plan is ready.", { exact: true })
	).toBeVisible();
}
test.beforeEach(async ({ request }) => {
	await chatPageControl(request, {
		action: "reset",
		scenario: "plan-persistence",
	});
	await chatPageControl(request, {
		action: "seed_conversation",
		node: "a",
		conversationId: CONVERSATION,
		messages: PLAN_MESSAGES,
	});
});
test.afterEach(async ({ page, request }, testInfo) => {
	const diagnostic = await page.evaluate(() => {
		const f = Reflect.get(window, "__chatPageNativeFixture");
		return f
			? { snapshot: f.nativeSnapshot(), details: f.nativeDiagnostics() }
			: null;
	});
	try {
		expect((await state(request)).unexpected).toEqual([]);
		expect(errors.get(page) ?? []).toEqual([]);
		const mounted = await page.evaluate(() => {
			const f = Reflect.get(window, "__chatPageNativeFixture");
			if (!f) return false;
			f.unmount();
			return true;
		});
		if (mounted) await assertNativeWindowLifetime(page);
	} finally {
		await persistNativeLifetimeDiagnostics(testInfo, {
			beforeCleanup: diagnostic,
			afterCleanup: await page.evaluate(
				() =>
					Reflect.get(window, "__chatPageNativeFixture")?.nativeSnapshot() ??
					null
			),
		});
	}
});
test("actual ChatPage automatically ingests exact completed plan and reload reuses the owned saved page without duplicate writes", async ({
	page,
	request,
}) => {
	await open(page);
	await expect
		.poll(async () => Object.values((await state(request)).planDocuments))
		.toEqual([
			{ id: "owned-plan-1", title: PLAN_TITLE, source: PLAN_MARKDOWN },
		]);
	const writes = (await state(request)).calls.filter(
		(c) => c.path === DOCS && c.method === "POST"
	);
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		authorization: "Bearer " + CHAT_PAGE_NATIVE_NODE_A_TOKEN,
		userJwt: null,
		body: { title: PLAN_TITLE, content: PLAN_MARKDOWN },
		responseStatus: 200,
	});
	const read = await request.get(
		"http://127.0.0.1:5591" + DOCS + "/owned-plan-1",
		{ headers: { authorization: "Bearer " + CHAT_PAGE_NATIVE_NODE_A_TOKEN, origin: "http://127.0.0.1:5590" } }
	);
	expect(read.status()).toBe(200);
	expect(await read.json()).toMatchObject({
		source: PLAN_MARKDOWN,
		title: PLAN_TITLE,
		id: "owned-plan-1",
	});
	await page.reload();
	await expect(
		page.getByText("A completed launch plan is ready.", { exact: true })
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await state(request)).calls.filter(
					(c) => c.path === DOCS + "/owned-plan-1" && c.method === "GET"
				).length
		)
		.toBeGreaterThan(1);
	expect(
		(await state(request)).calls.filter(
			(c) => c.path === DOCS && c.method === "POST"
		)
	).toHaveLength(1);
});
test("same URL/node token with a different user JWT saves an independent plan document and never reuses account A ID", async ({
	page,
	request,
}) => {
	await open(page);
	await expect
		.poll(
			async () => Object.values((await state(request)).planDocuments).length
		)
		.toBe(1);
	await rotate(page, request, "plan-user-b");
	await expect
		.poll(async () => Object.values((await state(request)).planDocuments))
		.toEqual([
			{ id: "owned-plan-1", title: PLAN_TITLE, source: PLAN_MARKDOWN },
			{ id: "owned-plan-2", title: PLAN_TITLE, source: PLAN_MARKDOWN },
		]);
	const writes = (await state(request)).calls.filter(
		(c) => c.path === DOCS && c.method === "POST"
	);
	expect(writes).toHaveLength(2);
	expect(writes[1]).toMatchObject({
		userJwt: "plan-user-b",
		authorization: "Bearer " + CHAT_PAGE_NATIVE_NODE_A_TOKEN,
		body: { title: PLAN_TITLE, content: PLAN_MARKDOWN },
		responseStatus: 200,
	});
	expect(
		(await state(request)).calls.filter(
			(c) => c.userJwt === "plan-user-b" && c.path === DOCS + "/owned-plan-1"
		)
	).toEqual([]);
	const privateRead = await request.get(
		"http://127.0.0.1:5591" + DOCS + "/owned-plan-1",
		{
			headers: {
				authorization: "Bearer " + CHAT_PAGE_NATIVE_NODE_A_TOKEN,
					origin: "http://127.0.0.1:5590",
				"x-ryu-user-jwt": "plan-user-b",
			},
		}
	);
	expect(privateRead.status()).toBe(404);
	const bRead = await request.get(
		"http://127.0.0.1:5591" + DOCS + "/owned-plan-2",
		{
			headers: {
				authorization: "Bearer " + CHAT_PAGE_NATIVE_NODE_A_TOKEN,
					origin: "http://127.0.0.1:5590",
				"x-ryu-user-jwt": "plan-user-b",
			},
		}
	);
	expect(bRead.status()).toBe(200);
	expect(await bRead.json()).toMatchObject({
		id: "owned-plan-2",
		source: PLAN_MARKDOWN,
	});
});
