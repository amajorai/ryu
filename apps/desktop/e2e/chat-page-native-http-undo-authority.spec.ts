// Shipping ChatPage and turn-end undo card invoke the real authenticated SDK
// over native HTTP. The fixture accepts/rejects plans; this does not prove
// a filesystem reversal, which belongs to real Core Git tests.
import { expect, type Page, test } from "@playwright/test";
import {
	assertNativeWindowLifetime,
	persistNativeLifetimeDiagnostics,
} from "./chat-page-native-http-lifetime.ts";
import {
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";

const CONVERSATION = "conversation-toolbar-share-fixture";
const PLAN = {
	kind: "text-replacements",
	edits: [
		{
			kind: "replace",
			path: "src/status.txt",
			before: "pending",
			after: "ready",
		},
	],
};
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
// Each test boots the full Vite dev-server Layout/ChatPage graph (about 2,480
// unbundled modules) in a fresh browser context. After the load event, showing
// the seeded history costs about 3.8 s of renderer main-thread CPU (origin/main
// and this branch alike), so the 5 s default fails whenever the host is busy; a
// node switch re-renders the same tree. This bound applies only to these history
// readiness waits. The authority assertions after release keep the default.
const historyReadyTimeout = 30_000;
async function open(page: Page) {
	await page.setViewportSize({ width: 1480, height: 960 });
	const pageErrors: string[] = [];
	errors.set(page, pageErrors);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/chat-page-native-http.html?scenario=undo-file-edits");
	await expect(
		page.getByText("Updated status file.", { exact: true })
	).toBeVisible({ timeout: historyReadyTimeout });
	await expect(
		page.getByRole("button", {
			name: "Undo this turn's text edits",
			exact: true,
		})
	).toBeEnabled();
}
async function confirmation(page: Page) {
	await page
		.getByRole("button", { name: "Undo this turn's text edits", exact: true })
		.click();
	const dialog = page.getByRole("alertdialog", {
		name: "Undo changes to status.txt?",
		exact: true,
	});
	await expect(dialog).toBeVisible();
	return dialog;
}
test.beforeEach(async ({ request }) => {
	await chatPageControl(request, {
		action: "reset",
		scenario: "undo-file-edits",
	});
	await chatPageControl(request, {
		action: "seed_conversation",
		node: "a",
		conversationId: CONVERSATION,
		messages: [
			{
				id: "undo-caller-user",
				role: "user",
				content: "Please update status file.",
				created_at: 1_724_000_000_000,
			},
			{
				id: "undo-caller-assistant",
				role: "assistant",
				content: "Updated status file.",
				created_at: 1_724_000_010_000,
				parts: [
					{ type: "text", text: "Updated status file." },
					{
						type: "tool-Edit",
						toolCallId: "undo-caller-edit",
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
		],
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
			if (!fixture) {
				return false;
			}
			fixture.unmount();
			return true;
		});
		if (mounted) {
			await assertNativeWindowLifetime(page);
		}
	} finally {
		await persistNativeLifetimeDiagnostics(testInfo, {
			beforeCleanup,
			afterCleanup: await captureNative(),
		});
	}
});
function seededMessages(text: string) {
	return [
		{
			id: "undo-caller-user",
			role: "user",
			content: "Please update status file.",
			created_at: 1_724_000_000_000,
		},
		{
			id: "undo-caller-assistant",
			role: "assistant",
			content: text,
			created_at: 1_724_000_010_000,
			parts: [
				{ type: "text", text },
				{
					type: "tool-Edit",
					toolCallId: "undo-caller-edit",
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
async function selectNode(page: Page, origin: string) {
	await page.evaluate(async (url) => {
		const store = Reflect.get(
			window,
			"__chatPageNativeFixture"
		).nodeStore.getState();
		const node = store.nodes.find(
			(candidate: { url: string }) => candidate.url === url
		);
		if (!node) {
			throw new Error("Requested actual node is absent");
		}
		await store.setDefault(node.name);
	}, origin);
}
for (const transition of ["B", "ABA"] as const) {
	for (const accepted of [true, false]) {
		test(`held old A Undo ${accepted ? "success" : "503 refusal"} cannot affect current ${transition} turn after authority handoff`, async ({
			page,
			request,
		}) => {
			await chatPageControl(request, {
				action: "seed_conversation",
				node: "b",
				conversationId: CONVERSATION,
				messages: seededMessages("Current B saved turn."),
			});
			await open(page);
			await chatPageControl(request, {
				action: "hold_next",
				node: "a",
				method: "POST",
				path: "/api/git/reverse-edits",
				status: 503,
				message: "Old A reversal refused",
			});
			const dialog = await confirmation(page);
			await dialog
				.getByRole("button", { name: "Undo changes", exact: true })
				.click();
			await expect
				.poll(async () => (await chatPageState(request)).heldRequestIds.length)
				.toBe(1);
			const pending = await chatPageState(request);
			const id = pending.heldRequestIds[0];
			if (id === undefined) {
				throw new Error("Actual A reverse-edits request was not held");
			}
			await selectNode(page, "http://127.0.0.1:5594");
			await expect(
				page.getByText("Current B saved turn.", { exact: true })
			).toBeVisible({ timeout: historyReadyTimeout });
			let currentText = "Current B saved turn.";
			if (transition === "ABA") {
				currentText = "Returned A saved turn.";
				await chatPageControl(request, {
					action: "seed_conversation",
					node: "a",
					conversationId: CONVERSATION,
					messages: seededMessages(currentText),
				});
				await selectNode(page, "http://127.0.0.1:5591");
				await expect(page.getByText(currentText, { exact: true })).toBeVisible({
					timeout: historyReadyTimeout,
				});
			}
			// Keeping the old node's confirmation visible is itself a lifetime failure;
			// soft assertions still let the genuine old HTTP acknowledgement be tested.
			await expect.soft(dialog).toBeHidden();
			const completed = page.waitForResponse(
				(response) =>
					response.request().method() === "POST" &&
					response.url() === "http://127.0.0.1:5591/api/git/reverse-edits"
			);
			await chatPageControl(request, {
				action: "release",
				requestId: id,
				accept: accepted,
			});
			const response = await completed;
			expect(response.status()).toBe(accepted ? 200 : 503);
			await response.finished();
			// Drain the real fetch body/React render before inspecting absence of effects.
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
					)
			);
			await expect(page.getByText(currentText, { exact: true })).toBeVisible();
			await expect
				.soft(page.getByText("Turn edit undone", { exact: true }))
				.toHaveCount(0);
			await expect
				.soft(page.getByText("Old A reversal refused", { exact: false }))
				.toHaveCount(0);
			await expect
				.soft(
					page
						.getByRole("button", {
							name: "Undo this turn's text edits",
							exact: true,
						})
						.filter({ hasText: /^Undone$/ })
				)
				.toHaveCount(0);
			await expect
				.soft(
					page.getByRole("button", {
						name: "Undo this turn's text edits",
						exact: true,
					})
				)
				.toBeEnabled();
			const settled = await chatPageState(request);
			const writes = settled.calls.filter(
				(call) => call.path === "/api/git/reverse-edits"
			);
			expect(writes).toHaveLength(1);
			expect(writes[0]).toMatchObject({
				node: "a",
				method: "POST",
				authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
				userJwt: null,
				responseStatus: accepted ? 200 : 503,
				body: { cwd: "/tmp/ryu-chat-controls-project", plan: PLAN },
			});
			expect(settled.reversedEdits).toEqual(
				accepted ? [{ cwd: "/tmp/ryu-chat-controls-project", plan: PLAN }] : []
			);
			expect(
				settled.calls.filter(
					(call) => call.node === "b" && isChatOrGitMutation(call)
				)
			).toEqual([]);
			expect(settled.heldRequestIds).toEqual([]);
		});
	}
}
