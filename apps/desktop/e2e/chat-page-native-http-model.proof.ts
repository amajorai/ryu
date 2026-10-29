import {
	assertNativeWindowLifetime,
	persistNativeLifetimeDiagnostics,
} from "./chat-page-native-http-lifetime.ts";
import { expect, test, type Page } from "@playwright/test";
import type { Node } from "../src/store/useNodeStore.ts";
import type { Call } from "./chat-page-native-http.host.ts";
import {
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
	CHAT_PAGE_NATIVE_NODE_B_TOKEN,
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";

const pageErrors = new WeakMap<Page, string[]>();

const conversationId = "conversation-toolbar-share-fixture";
const path = `/api/conversations/${conversationId}/model-selection`;
const modelTrigger = (page: Page) =>
	page.getByRole("button", { name: "Choose provider and model", exact: true });
const writes = (calls: Call[]) =>
	calls.filter((call) => call.path === path && call.method === "PUT");

async function pickModel(page: Page, name: "Proof model A" | "Proof model B") {
	// Friendly mode capitalizes the displayed label; the shared history API
	// retains the Core catalog label. Assert both exact contracts separately.
	const displayName =
		name === "Proof model A" ? "Proof Model A" : "Proof Model B";
	await modelTrigger(page).click();
	// Navigate the shipping command dialog's Model section, then its real option.
	await page.getByRole("option", { name: /^Model\b/ }).click();
	await page.getByRole("option", { name: displayName, exact: true }).click();
	await expect(modelTrigger(page)).toHaveAttribute("title", displayName);
}

function assertChoice(
	call: Call,
	modelId: string,
	modelLabel: string,
	node: "a" | "b",
	authority?: { token: string; userJwt: string | null },
) {
	expect(call.node).toBe(node);
	expect(call.authorization).toBe(
		`Bearer ${authority?.token ?? (node === "a" ? CHAT_PAGE_NATIVE_NODE_A_TOKEN : CHAT_PAGE_NATIVE_NODE_B_TOKEN)}`,
	);
	expect(call.userJwt).toBe(authority?.userJwt ?? null);
	expect(call.body).toEqual({
		changeId: expect.any(String),
		kind: "change",
		modelId,
		modelLabel,
		providerId: null,
		providerLabel: null,
	});
	expect(call.rawBody).toBe(JSON.stringify(call.body));
	expect(call.contentType).toContain("application/json");
}

// This tests the unchanged shipping Layout/ChatPage/composer and actual SDK HTTP.
// The owned Core fixture stores its accepted model DTOs; no external model runs.
test.beforeEach(async ({ request, page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, {
		action: "reset",
		scenario: "model-selection-caller",
	});
	await page.goto(
		"/chat-page-native-http.html?scenario=model-selection-caller",
	);
	await expect(
		page.getByText("The organization copy is ready for review.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(modelTrigger(page)).toHaveAttribute("title", "Proof Model A");
	await expect
		.poll(
			async () =>
				(await chatPageState(request)).calls.filter(
					(call) =>
						call.node === "a" && call.path === path && call.method === "GET",
				).length,
		)
		.toBeGreaterThan(0);
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
		// Release every owned deferred HTTP handler even when a behavioral oracle fails.
		for (const id of (await chatPageState(request)).heldRequestIds) {
			await chatPageControl(request, {
				action: "release",
				requestId: id,
				accept: false,
			});
		}
		const state = await chatPageState(request);
		expect(state.unexpected).toEqual([]);
		expect(state.heldRequestIds).toEqual([]);
		const native = await page.evaluate(() => {
			const host = window as typeof window & {
				__chatPageNativeFixture: {
					unmount: () => void;
					nativeSnapshot: () => {
						listeners: number;
						callbacks: number;
						unexpected: string[];
					};
				};
			};
			host.__chatPageNativeFixture.unmount();
			return host.__chatPageNativeFixture.nativeSnapshot();
		});
		expect(native.unexpected).toEqual([]);
		await assertNativeWindowLifetime(page);
		expect(pageErrors.get(page) ?? []).toEqual([]);
	} finally {
		await persistNativeLifetimeDiagnostics(testInfo, {
			beforeCleanup,
			afterCleanup: await captureNative(),
			pageErrors: pageErrors.get(page) ?? [],
		});
	}
});

test("actual composer choice records exact model and fresh room GET restores it after reload", async ({
	page,
	request,
}) => {
	await pickModel(page, "Proof model B");
	await expect
		.poll(
			async () =>
				writes((await chatPageState(request)).calls).filter(
					(call) => call.status === "accepted",
				).length,
		)
		.toBe(1);
	const before = await chatPageState(request);
	const call = writes(before.calls)[0];
	if (!call) throw new Error("Real model choice PUT was not captured");
	assertChoice(call, "model-proof-b", "Proof model B", "a");
	await expect(page.getByText("Model changed", { exact: true })).toBeVisible();
	expect(before.modelSelections[`a:${conversationId}`]).toMatchObject({
		current: {
			id: (call.body as { changeId: string }).changeId,
			modelId: "model-proof-b",
			sequence: 1,
		},
		changes: [
			expect.objectContaining({ modelId: "model-proof-b", sequence: 1 }),
		],
	});
	// Remove the per-agent browser fallback so the room's GET is the restore source.
	await page.evaluate(() =>
		localStorage.removeItem("ryu_agent_model_selection"),
	);
	const priorGets = before.calls.filter(
		(call) => call.path === path && call.method === "GET",
	).length;
	await page.reload();
	await expect
		.poll(
			async () =>
				(await chatPageState(request)).calls.filter(
					(call) => call.path === path && call.method === "GET",
				).length,
		)
		.toBeGreaterThan(priorGets);
	await expect(modelTrigger(page)).toHaveAttribute("title", "Proof Model B");
	expect(writes((await chatPageState(request)).calls)).toHaveLength(1);
});

test("refused model sharing is visible, retains server history, and a real picker retry persists", async ({
	page,
	request,
}) => {
	await chatPageControl(request, {
		action: "refuse_next",
		node: "a",
		method: "PUT",
		path,
		status: 503,
		message: "Owned model save refused",
	});
	await pickModel(page, "Proof model B");
	await expect(
		page.getByText(`${path} failed: 503`, { exact: true }),
	).toBeVisible();
	const refused = await chatPageState(request);
	const refusedCall = writes(refused.calls)[0];
	if (!refusedCall) throw new Error("Refused real model PUT was not captured");
	assertChoice(refusedCall, "model-proof-b", "Proof model B", "a");
	expect(refusedCall.responseStatus).toBe(503);
	expect(refused.modelSelections[`a:${conversationId}`]).toBeUndefined();
	// Retry through the same real selection UI, never through a fixture mutation.
	await pickModel(page, "Proof model B");
	await expect
		.poll(
			async () =>
				writes((await chatPageState(request)).calls).filter(
					(call) => call.status === "accepted",
				).length,
		)
		.toBe(1);
	const accepted = await chatPageState(request);
	expect(writes(accepted.calls)).toHaveLength(2);
	assertChoice(
		writes(accepted.calls)[1],
		"model-proof-b",
		"Proof model B",
		"a",
	);
	expect(accepted.modelSelections[`a:${conversationId}`]).toMatchObject({
		changes: [
			expect.objectContaining({ modelId: "model-proof-b", sequence: 1 }),
		],
	});
	await page.evaluate(() =>
		localStorage.removeItem("ryu_agent_model_selection"),
	);
	await page.reload();
	await expect(modelTrigger(page)).toHaveAttribute("title", "Proof Model B");
});

test("two queued choices remain owned by A when real node selection changes before the first acknowledgment", async ({
	page,
	request,
}) => {
	await chatPageControl(request, {
		action: "hold_next",
		node: "a",
		method: "PUT",
		path,
	});
	await pickModel(page, "Proof model B");
	await expect
		.poll(async () => (await chatPageState(request)).heldRequestIds.length)
		.toBe(1);
	const held = await chatPageState(request);
	const requestId = held.heldRequestIds[0];
	if (requestId === undefined)
		throw new Error("First real model PUT was not held");
	await pickModel(page, "Proof model A");
	expect(writes((await chatPageState(request)).calls)).toHaveLength(1);
	await page.evaluate(async () => {
		const host = window as typeof window & {
			__chatPageNativeFixture: {
				nodeStore: {
					getState: () => {
						nodes: Node[];
						setDefault: (name: string) => Promise<void>;
					};
				};
			};
		};
		const store = host.__chatPageNativeFixture.nodeStore.getState();
		const nodeB = store.nodes.find(
			(node) => node.url === "http://127.0.0.1:5594",
		);
		if (!nodeB) throw new Error("Real node store did not load B");
		await store.setDefault(nodeB.name);
	});
	await expect
		.poll(
			async () =>
				(await chatPageState(request)).calls.filter(
					(call) =>
						call.node === "b" && call.path === path && call.method === "GET",
				).length,
		)
		.toBeGreaterThan(0);
	await chatPageControl(request, {
		action: "release",
		requestId,
		accept: true,
	});
	await expect
		.poll(
			async () =>
				writes((await chatPageState(request)).calls).filter(
					(call) => call.status !== "pending",
				).length,
		)
		.toBe(2);
	const final = await chatPageState(request);
	const choices = writes(final.calls);
	assertChoice(choices[0], "model-proof-b", "Proof model B", "a");
	assertChoice(choices[1], "model-proof-a", "Proof model A", "a");
	expect(final.modelSelections[`a:${conversationId}`]).toMatchObject({
		current: { modelId: "model-proof-a", sequence: 2 },
		changes: [
			expect.objectContaining({ modelId: "model-proof-b", sequence: 1 }),
			expect.objectContaining({ modelId: "model-proof-a", sequence: 2 }),
		],
	});
	expect(final.modelSelections[`b:${conversationId}`]).toBeUndefined();
	expect(choices.filter((call) => call.node === "b")).toEqual([]);
	// A history must not become B's visible room history when the IDs coincide.
	await expect(page.getByText("Model changed", { exact: true })).toHaveCount(0);
});

async function selectRealNode(page: Page, url: string) {
	await page.evaluate(async (url) => {
		const host = window as typeof window & {
			__chatPageNativeFixture: {
				nodeStore: {
					getState: () => {
						nodes: Node[];
						setDefault: (name: string) => Promise<void>;
					};
				};
			};
		};
		const state = host.__chatPageNativeFixture.nodeStore.getState();
		const node = state.nodes.find((node) => node.url === url);
		if (!node)
			throw new Error("Selected authority is absent from actual node store");
		await state.setDefault(node.name);
	}, url);
}

for (const variant of ["token", "jwt", "aba"] as const) {
	test(`late ${variant === "jwt" ? "refused" : "accepted"} model acknowledgment cannot publish into returning/current ${variant} authority`, async ({
		page,
		request,
	}) => {
		const oldError = "Owned previous-user model choice refused";
		await chatPageControl(request, {
			action: "hold_next",
			node: "a",
			method: "PUT",
			path,
			status: 503,
			message: oldError,
		});
		await pickModel(page, "Proof model B");
		await expect
			.poll(async () => (await chatPageState(request)).heldRequestIds.length)
			.toBe(1);
		const first = await chatPageState(request);
		const oldId = first.heldRequestIds[0];
		if (oldId === undefined)
			throw new Error("Original model choice was not held by HTTP fixture");
		const currentAuthority = {
			token:
				variant === "token"
					? "chat-page-model-rotated-node-a-token"
					: CHAT_PAGE_NATIVE_NODE_A_TOKEN,
			userJwt: variant === "jwt" ? "chat-page-model-new-user-jwt" : null,
		};
		if (variant === "aba") {
			await selectRealNode(page, "http://127.0.0.1:5594");
			await expect
				.poll(
					async () =>
						(await chatPageState(request)).calls.filter(
							(call) =>
								call.node === "b" &&
								call.path === path &&
								call.method === "GET",
						).length,
				)
				.toBeGreaterThan(0);
			const aReads = (await chatPageState(request)).calls.filter(
				(call) =>
					call.node === "a" && call.path === path && call.method === "GET",
			).length;
			await selectRealNode(page, "http://127.0.0.1:5591");
			await expect
				.poll(
					async () =>
						(await chatPageState(request)).calls.filter(
							(call) =>
								call.node === "a" &&
								call.path === path &&
								call.method === "GET",
						).length,
				)
				.toBeGreaterThan(aReads);
		} else {
			await chatPageControl(request, {
				action: "begin_authority_rotation",
				node: "a",
			});
			await chatPageControl(request, {
				action: "set_node_authority",
				node: "a",
				...currentAuthority,
			});
			// The shipping hooks subscribe to this actual store. This represents a
			// native credential refresh / managed delegation update, not a model callback.
			await page.evaluate((authority) => {
				const host = window as typeof window & {
					__chatPageNativeFixture: {
						nodeStore: {
							setState: (
								update: (state: { nodes: Node[] }) => { nodes: Node[] },
							) => void;
						};
					};
				};
				host.__chatPageNativeFixture.nodeStore.setState((state) => ({
					nodes: state.nodes.map((node) =>
						node.url === "http://127.0.0.1:5591"
							? { ...node, ...authority }
							: node,
					),
				}));
			}, currentAuthority);
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
					)
			);
			const rotation = await chatPageControl(request, {
				action: "end_authority_rotation",
				node: "a",
			});
			expect(rotation.window.endedAtMs).toBeLessThanOrEqual(
				rotation.window.deadlineAtMs
			);
			for (const denied of rotation.denials) {
				expect(denied).toMatchObject({
					method: "GET",
					path: "/api/background/processes?running_only=true",
					body: null,
					authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
					userJwt: null,
					status: "refused",
					responseStatus: 403,
					transitionRefusal: "bounded-authority-rotation",
				});
				expect(denied.rotationDeniedAtMs).toBeGreaterThanOrEqual(
					rotation.window.startedAtMs
				);
				expect(denied.rotationDeniedAtMs).toBeLessThanOrEqual(
					rotation.window.endedAtMs
				);
			}
			await expect
				.poll(
					async () =>
						(await chatPageState(request)).calls.filter(
							(call) =>
								call.node === "a" &&
								call.path === path &&
								call.method === "GET" &&
								call.authorization === `Bearer ${currentAuthority.token}` &&
								call.userJwt === currentAuthority.userJwt,
						).length,
				)
				.toBeGreaterThan(0);
		}
		await chatPageControl(request, {
			action: "hold_next",
			node: "a",
			method: "PUT",
			path,
		});
		await pickModel(page, "Proof model A");
		expect(writes((await chatPageState(request)).calls)).toHaveLength(1);
		const oldResponse = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === path &&
				response.request().method() === "PUT" &&
				response.request().headers().authorization ===
					`Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
		);
		await chatPageControl(request, {
			action: "release",
			requestId: oldId,
			accept: variant !== "jwt",
		});
		const response = await oldResponse;
		expect(response.status()).toBe(variant === "jwt" ? 503 : 200);
		await response.finished();
		// The new real PUT proves the shipping serial queue processed the old result
		// and advanced; inspect while that new owner is still awaiting acknowledgment.
		await expect
			.poll(async () => writes((await chatPageState(request)).calls).length)
			.toBe(2);
		await expect
			.poll(async () => (await chatPageState(request)).heldRequestIds.length)
			.toBe(1);
		const pending = await chatPageState(request);
		const currentId = pending.heldRequestIds[0];
		if (currentId === undefined || currentId === oldId)
			throw new Error("Current model choice was not independently held");
		assertChoice(
			writes(pending.calls)[0],
			"model-proof-b",
			"Proof model B",
			"a",
		);
		assertChoice(
			writes(pending.calls)[1],
			"model-proof-a",
			"Proof model A",
			"a",
			currentAuthority,
		);
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		await expect(page.getByText("Model changed", { exact: true })).toHaveCount(
			0,
		);
		await expect(page.getByText(oldError, { exact: false })).toHaveCount(0);
		await expect(modelTrigger(page)).toHaveAttribute("title", "Proof Model A");
		await chatPageControl(request, {
			action: "release",
			requestId: currentId,
			accept: true,
		});
		await expect
			.poll(
				async () =>
					writes((await chatPageState(request)).calls).filter(
						(call) => call.status === "accepted",
					).length,
			)
			.toBe(variant === "jwt" ? 1 : 2);
		await expect(page.getByText("Model changed", { exact: true })).toHaveCount(
			1,
		);
		const accepted = await chatPageState(request);
		expect(accepted.modelSelections[`a:${conversationId}`]).toMatchObject({
			current: {
				modelId: "model-proof-a",
				sequence: variant === "jwt" ? 1 : 2,
			},
		});
		expect(accepted.modelSelections[`b:${conversationId}`]).toBeUndefined();
		// Destroy the current page document before restoring the finite native profile.
		// Its background consumers legitimately still use the rotated credentials.
		// Accepted room history must survive without the browser model fallback.
		await page.evaluate(() =>
			localStorage.removeItem("ryu_agent_model_selection"),
		);
		const fixtureUrl = page.url();
		await page.goto("about:blank");
		await chatPageControl(request, {
			action: "set_node_authority",
			node: "a",
			token: CHAT_PAGE_NATIVE_NODE_A_TOKEN,
			userJwt: null,
		});
		const previousReads = accepted.calls.filter(
			(call) =>
				call.node === "a" && call.path === path && call.method === "GET",
		).length;
		await page.goto(fixtureUrl);
		await expect
			.poll(
				async () =>
					(await chatPageState(request)).calls.filter(
						(call) =>
							call.node === "a" && call.path === path && call.method === "GET",
					).length,
			)
			.toBeGreaterThan(previousReads);
		await expect(modelTrigger(page)).toHaveAttribute("title", "Proof Model A");
		await expect(page.getByText("Model changed", { exact: true })).toHaveCount(
			variant === "jwt" ? 1 : 2,
		);
		expect(writes((await chatPageState(request)).calls)).toHaveLength(2);
	});
}
