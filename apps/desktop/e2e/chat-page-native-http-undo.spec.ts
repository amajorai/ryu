import {
	assertNativeWindowLifetime,
	persistNativeLifetimeDiagnostics,
} from "./chat-page-native-http-lifetime.ts";
// Shipping ChatPage and turn-end undo card invoke the real authenticated SDK
// over native HTTP. The fixture accepts/rejects plans; this does not prove
// a filesystem reversal, which belongs to real Core Git tests.
import { expect, type Page, test } from "@playwright/test";
import {
	chatPageControl,
	chatPageState,
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
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
async function open(page: Page) {
	await page.setViewportSize({ width: 1480, height: 960 });
	const pageErrors: string[] = [];
	errors.set(page, pageErrors);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/chat-page-native-http.html?scenario=undo-file-edits");
	await expect(
		page.getByText("Updated status file.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: "Undo this turn's text edits",
			exact: true,
		}),
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
				created_at: 1724000000000,
			},
			{
				id: "undo-caller-assistant",
				role: "assistant",
				content: "Updated status file.",
				created_at: 1724000010000,
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
test("canceling the actual turn-end confirmation sends no reverse-edits request and leaves Undo reusable", async ({
	page,
	request,
}) => {
	await open(page);
	const dialog = await confirmation(page);
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("button", {
			name: "Undo this turn's text edits",
			exact: true,
		}),
	).toBeEnabled();
	expect(
		(await chatPageState(request)).calls.filter(
			(c) => c.path === "/api/git/reverse-edits",
		),
	).toEqual([]);
	expect((await chatPageState(request)).reversedEdits).toEqual([]);
});
test("a real 409 remains recoverable; held identical retry cannot dismiss or double-submit and succeeds only after acknowledgement", async ({
	page,
	request,
}) => {
	await open(page);
	await chatPageControl(request, {
		action: "refuse_next",
		node: "a",
		method: "POST",
		path: "/api/git/reverse-edits",
		status: 409,
		body: {
			kind: "conflict",
			reason: "changed_since_turn",
			paths: ["src/status.txt"],
		},
	});
	const dialog = await confirmation(page);
	await dialog
		.getByRole("button", { name: "Undo changes", exact: true })
		.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"The edited text changed after this turn. No files were changed.",
	);
	await expect(
		dialog.getByRole("button", { name: "Undo changes", exact: true }),
	).toBeEnabled();
	expect((await chatPageState(request)).reversedEdits).toEqual([]);
	await expect(
		page
			.getByRole("button", { name: "Undo this turn's text edits", exact: true })
			.filter({ hasText: /^Undone$/ }),
	).toHaveCount(0);
	await chatPageControl(request, {
		action: "hold_next",
		node: "a",
		method: "POST",
		path: "/api/git/reverse-edits",
	});
	await dialog
		.getByRole("button", { name: "Undo changes", exact: true })
		.click();
	await expect
		.poll(async () => (await chatPageState(request)).heldRequestIds.length)
		.toBe(1);
	await expect(
		dialog.getByRole("button", { name: "Undoing…", exact: true }),
	).toBeDisabled();
	await expect(
		dialog.getByRole("button", { name: "Cancel", exact: true }),
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Enter");
	const pending = await chatPageState(request);
	expect(
		pending.calls.filter((c) => c.path === "/api/git/reverse-edits"),
	).toHaveLength(2);
	expect(pending.reversedEdits).toEqual([]);
	const beforeReads = pending.calls.filter((c) =>
		c.path.startsWith("/api/git/status?"),
	).length;
	await chatPageControl(request, {
		action: "release",
		requestId: pending.heldRequestIds[0],
		accept: true,
	});
	await expect(dialog).toBeHidden();
	await expect(
		page
			.getByRole("button", { name: "Undo this turn's text edits", exact: true })
			.filter({ hasText: /^Undone$/ }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", {
			name: "Undo this turn's text edits",
			exact: true,
		}),
	).toHaveText("Undone");
	await expect(
		page.getByText("Turn edit undone", { exact: true }),
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await chatPageState(request)).calls.filter((c) =>
					c.path.startsWith("/api/git/status?"),
				).length,
		)
		.toBeGreaterThan(beforeReads);
	const accepted = await chatPageState(request),
		writes = accepted.calls.filter((c) => c.path === "/api/git/reverse-edits");
	expect(writes).toHaveLength(2);
	expect(writes.map((c) => c.body)).toEqual([
		{ cwd: "/tmp/ryu-chat-controls-project", plan: PLAN },
		{ cwd: "/tmp/ryu-chat-controls-project", plan: PLAN },
	]);
	expect(
		writes.map((c) => ({
			node: c.node,
			method: c.method,
			auth: c.authorization,
			jwt: c.userJwt,
			status: c.responseStatus,
		})),
	).toEqual([
		{
			node: "a",
			method: "POST",
			auth: "Bearer " + CHAT_PAGE_NATIVE_NODE_A_TOKEN,
			jwt: null,
			status: 409,
		},
		{
			node: "a",
			method: "POST",
			auth: "Bearer " + CHAT_PAGE_NATIVE_NODE_A_TOKEN,
			jwt: null,
			status: 200,
		},
	]);
	expect(accepted.reversedEdits).toEqual([
		{ cwd: "/tmp/ryu-chat-controls-project", plan: PLAN },
	]);
	expect(
		accepted.calls.filter((c) => c.node === "b" && isChatOrGitMutation(c)),
	).toEqual([]);
});
