import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import type { useAssistantStore } from "../src/store/useAssistantStore.ts";

type AssistantState = ReturnType<typeof useAssistantStore.getState>;
type AssistantNoArgumentAction = {
	[Action in keyof AssistantState]: AssistantState[Action] extends () => void
		? Action
		: never;
}[keyof AssistantState];

declare const window: Window & { assistantStore: typeof useAssistantStore };

const proofDir =
	"../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-panels/assistant";
// Core answers `/api/chat/permission` with `{ resolved }`, and the desktop
// client validates that shape; a resolved response is what closes the card.
const permissionResolved = JSON.stringify({ resolved: true });
let browserErrors: string[] = [];
test.beforeEach(({ page }) => {
	browserErrors = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
});
test.afterEach(async ({ page }, testInfo) => {
	const name = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
	const fixtureState = await page
		.evaluate(() => ({
			mode: window.assistantStore?.getState().mode,
			calls: window.__assistantProof?.calls,
		}))
		.catch(() => null);
	await writeFile(
		`${proofDir}/${name}-browser-errors.json`,
		JSON.stringify(
			{ errors: browserErrors, status: testInfo.status, fixtureState },
			null,
			2
		)
	);
	if (testInfo.status === "passed") {
		expect(browserErrors).toEqual([]);
	} else if (!page.isClosed()) {
		await page
			.screenshot({ path: `${proofDir}/${name}-failure.png` })
			.catch(() => {});
	}
});
async function state(page: Page, action: AssistantNoArgumentAction) {
	await page.evaluate((action) => {
		const w = window;
		w.assistantStore.getState()[action]();
	}, action);
}
async function open(page: Page) {
	await page.goto("/assistant-panel-proof.html");
	await page.getByRole("button", { name: "Ask Ryu", exact: true }).click();
	await expect(page.getByTestId("floating-assistant-header")).toBeVisible();
}
function stream(parts: unknown[]) {
	return (
		parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") +
		"data: [DONE]\n\n"
	);
}
async function reply(page: Page, permission = false) {
	await page.route("**/api/chat/stream", async (route) =>
		route.fulfill({
			contentType: "text/event-stream",
			headers: { "x-vercel-ai-ui-message-stream": "v1" },
			body: stream([
				{ type: "start", messageId: "reply-proof" },
				{ type: "text-start", id: "text" },
				{ type: "text-delta", id: "text", delta: "Workspace ready." },
				{ type: "text-end", id: "text" },
				...(permission
					? [
							{
								type: "data-ryu-permission",
								data: {
									requestId: "permission-proof",
									options: [
										{
											optionId: "allow-once",
											kind: "allow_once",
											name: "Allow once",
										},
										{ optionId: "deny", kind: "reject_once", name: "Deny" },
									],
									toolCall: { title: "Inspect workspace" },
								},
							},
						]
					: []),
				{ type: "finish", finishReason: "stop" },
			]),
		})
	);
}
async function send(page: Page, text: string) {
	const input = page.getByRole("textbox").first();
	await input.fill(text);
	await input.press("Enter");
}
test("page publisher context can be removed through the real non-tab chip action", async ({
	page,
}) => {
	await reply(page);
	await page.goto("/assistant-panel-proof.html?context=1");
	await page.evaluate(() => window.assistantStore.getState().open("sidebar"));
	const remove = page.getByRole("button", {
		name: "Remove Current brief from context",
	});
	await expect(remove).toBeVisible();
	expect(
		await page.evaluate(() =>
			window.assistantStore.getState().pageContext.map((item) => item.id)
		)
	).toEqual(["document:brief"]);
	await remove.click();
	await expect(remove).not.toBeVisible();
	expect(
		await page.evaluate(() => window.assistantStore.getState().pageContext)
	).toEqual([]);
	const request = page.waitForRequest("**/api/chat/stream");
	await send(page, "Review remaining context");
	const payload = (await request).postDataJSON();
	expect(JSON.stringify(payload.messages)).not.toContain(
		"Workspace brief snapshot"
	);
	await expect(
		page.getByText("Workspace ready.", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Review remaining context", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("The user is working in Ryu and currently has this open.", {
			exact: false,
		})
	).not.toBeVisible();
	await expect(page.locator("[data-chat-empty-intro]")).toHaveCount(0);
	await page.screenshot({ path: `${proofDir}/published-context-removed.png` });
});

test("real dock opens, closes, clamps and hands recent chat to production tab seam", async ({
	page,
}) => {
	await open(page);
	await page
		.getByRole("button", { name: "Close assistant", exact: true })
		.click();
	await expect(page.getByTestId("floating-assistant-header")).not.toBeVisible();
	await page.getByRole("button", { name: "Ask Ryu", exact: true }).click();
	await expect(page.getByTestId("floating-assistant-header")).toBeVisible();
	await page.getByRole("button", { name: /^Workspace review/ }).click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.__assistantProof.calls.filter((c) => c.kind === "tab")
			)
		)
		.toEqual([
			{
				kind: "tab",
				path: "/chat",
				options: { conversationId: "recent-proof" },
			},
		]);
	await page.setViewportSize({ width: 390, height: 700 });
	await page.getByRole("button", { name: "Ask Ryu", exact: true }).click();
	await expect(page.getByTestId("floating-assistant-header")).toBeVisible();
	await expect
		.poll(
			async () =>
				(await page.getByTestId("floating-assistant-header").boundingBox())
					?.width ?? 400
		)
		.toBeLessThanOrEqual(358);
	const box = await page.getByTestId("floating-assistant-header").boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.width).toBeLessThanOrEqual(358);
	await page.screenshot({ path: `${proofDir}/floating-mobile.png` });
});
test("context removal, restore, exact chat request, history readback and full screen identity", async ({
	page,
}) => {
	await reply(page);
	await open(page);
	await page.evaluate(() => {
		window.workspaceStore.setState({ folder: "/fixture/workspace" });
		window.assistantStore.getState().setLayout("sidebar");
	});
	await page
		.getByRole("button", { name: "Remove Workspace from context" })
		.click();
	await page.getByRole("button", { name: "Add current page" }).click();
	const request = page.waitForRequest("**/api/chat/stream");
	await send(page, "Review workspace");
	const req = await request;
	const body = req.postDataJSON();
	expect(req.headers().authorization).toBe("Bearer fixture-node-token");
	expect(body).toMatchObject({
		agent_id: "ryu",
		model: "fixture-model",
		cwd: "/fixture/workspace",
		enable_long_term: false,
	});
	expect(body.messages[0].parts[0].text).toContain("<page-context>");
	await expect(
		page.getByText("Workspace ready.", { exact: true })
	).toBeVisible();
	await page.evaluate(
		({ id, wire, metadata }) => {
			window.__assistantProof.history[id] = [
				{ id: "saved-user", role: "user", content: wire, metadata },
				{
					id: "saved",
					role: "assistant",
					content: "Old fallback body",
					parts: [{ type: "text", text: "Persisted workspace reply." }],
				},
			];
		},
		{
			id: body.conversation_id,
			wire: body.messages[0].parts[0].text,
			metadata: body.messages[0].metadata,
		}
	);
	await page.getByRole("button", { name: "Float panel" }).click();
	await page
		.getByRole("button", { name: "Close assistant", exact: true })
		.click();
	await page.getByRole("button", { name: "Ask Ryu", exact: true }).click();
	await expect(
		page.getByText("Persisted workspace reply.", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Review workspace", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Old fallback body", { exact: true })
	).not.toBeVisible();
	await page
		.getByRole("button", { name: "Open assistant in full screen" })
		.click();
	expect(
		await page.evaluate(() =>
			window.__assistantProof.calls.filter((c) => c.kind === "tab")
		)
	).toEqual([
		{
			kind: "tab",
			path: "/chat",
			options: { conversationId: body.conversation_id },
		},
	]);
});
test("layout persists and new chat clears identity through real options menu", async ({
	page,
}) => {
	await open(page);
	await page.evaluate(() => {
		window.assistantStore.getState().setLayout("sidebar");
		window.assistantStore.getState().setConversationId("old-proof");
	});
	await page.getByRole("button", { name: "Assistant options" }).click();
	await page.getByRole("menuitem", { name: "New chat" }).click();
	expect(
		await page.evaluate(() => localStorage.getItem("ryu:assistant-mode"))
	).toBe("sidebar");
	expect(
		await page.evaluate(() => window.assistantStore.getState().conversationId)
	).toBeNull();
	await page.getByRole("button", { name: "Assistant options" }).click();
	await page.getByRole("menuitem", { name: "Close", exact: true }).click();
	await state(page, "open");
	await expect(page.getByRole("button", { name: "Float panel" })).toBeVisible();
	await page.screenshot({ path: `${proofDir}/sidebar-restored.png` });
});
test("permission denied request remains visible then user retry sends exact response once", async ({
	page,
}) => {
	await reply(page, true);
	let attempts = 0;
	const requests: unknown[] = [];
	await page.route("**/api/chat/permission", async (route) => {
		attempts++;
		requests.push(route.request().postDataJSON());
		await new Promise((resolve) => setTimeout(resolve, 250));
		await route.fulfill({
			status: attempts === 1 ? 503 : 200,
			contentType: "application/json",
			body: attempts === 1 ? "{}" : permissionResolved,
		});
	});
	await open(page);
	await send(page, "Inspect workspace");
	const allow = page.getByRole("button", { name: /Allow once/i });
	await expect(allow).toBeVisible();
	await allow.click();
	await expect(allow).toBeDisabled();
	await expect(page.getByRole("alert")).toHaveText(
		"Could not send your permission response. Try again."
	);
	await expect(allow).toBeEnabled();
	await page.screenshot({ path: `${proofDir}/permission-failure-retry.png` });
	await allow.click();
	await expect(allow).not.toBeVisible();
	expect(attempts).toBe(2);
	expect(requests).toEqual([
		{ request_id: "permission-proof", option_id: "allow-once" },
		{ request_id: "permission-proof", option_id: "allow-once" },
	]);
	await page.screenshot({ path: `${proofDir}/permission-recovered.png` });
});

test("auth transition permits a new response and stale success cannot resolve reused permission id", async ({
	page,
}) => {
	await reply(page, true);
	const held: import("@playwright/test").Route[] = [];
	await page.route("**/api/chat/permission", async (route) => {
		held.push(route);
	});
	await open(page);
	await send(page, "Inspect workspace");
	const allow = page.getByRole("button", { name: /Allow once/i });
	await allow.click();
	await expect(allow).toBeDisabled();
	await expect.poll(() => held.length).toBe(1);
	await page.evaluate(() => {
		window.__assistantProof.token = "fixture-next-node-token";
		window.assistantStore.setState({ pageContext: [] });
	});
	await expect(allow).toBeEnabled();
	await held[0].fulfill({ status: 200, body: permissionResolved });
	await expect(allow).toBeVisible();
	await allow.click();
	await expect.poll(() => held.length).toBe(2);
	expect(held[0].request().headers().authorization).toBe(
		"Bearer fixture-node-token"
	);
	expect(held[1].request().headers().authorization).toBe(
		"Bearer fixture-next-node-token"
	);
	expect(held[1].request().postDataJSON()).toEqual({
		request_id: "permission-proof",
		option_id: "allow-once",
	});
	await held[1].fulfill({ status: 200, body: permissionResolved });
	await expect(allow).not.toBeVisible();
	await page.evaluate(() => {
		window.__assistantProof.token = "fixture-node-token";
		window.assistantStore.setState({ pageContext: [] });
	});
	await expect(allow).toBeVisible();
	await allow.click();
	await expect.poll(() => held.length).toBe(3);
	await held[2].fulfill({ status: 200, body: permissionResolved });
	await expect(allow).not.toBeVisible();
	await page.evaluate(() => {
		window.__assistantProof.token = "fixture-next-node-token";
		window.assistantStore.setState({ pageContext: [] });
	});
	await expect(allow).not.toBeVisible();
});

test("sidebar full screen menu carries conversation identity and layout survives reload", async ({
	page,
}) => {
	await open(page);
	await page.evaluate(() =>
		window.assistantStore.getState().setLayout("sidebar")
	);
	await page.reload();
	await state(page, "open");
	await expect(page.getByRole("button", { name: "Float panel" })).toBeVisible();
	await page.evaluate(() =>
		window.assistantStore.getState().setConversationId("menu-fullscreen-proof")
	);
	await page.getByRole("button", { name: "Assistant options" }).click();
	await page.getByRole("menuitem", { name: "Open in full screen" }).click();
	expect(
		await page.evaluate(() =>
			window.__assistantProof.calls.filter((c) => c.kind === "tab")
		)
	).toEqual([
		{
			kind: "tab",
			path: "/chat",
			options: { conversationId: "menu-fullscreen-proof" },
		},
	]);
	expect(await page.evaluate(() => window.assistantStore.getState().mode)).toBe(
		"closed"
	);
});

test("an app-defined surface carries removable page context on its turns", async ({
	page,
}) => {
	await reply(page);
	await page.goto("/assistant-panel-proof.html?builder=1&context=1");
	await expect(
		page.getByText("Build Workspace board", { exact: true })
	).toBeVisible();
	const chip = page.getByRole("button", {
		name: "Remove Current brief from context",
	});
	await expect(chip).toBeVisible();
	// Voice mode would bypass the surface's preamble, context, and unsaved
	// thread, so an app surface offers dictation only.
	expect(await page.evaluate(() => window.__assistantProof.composers)).toEqual({
		"ask-ryu": { voiceMode: true },
		dashboard: { voiceMode: false },
	});
	const first = page.waitForRequest("**/api/chat/stream");
	await send(page, "What is on this page?");
	const firstText: string = (await first).postDataJSON().messages[0].parts[0]
		.text;
	expect(firstText).toContain("Build board-proof from {widgets:[]}");
	expect(firstText).toContain("<page-context>");
	expect(firstText).toContain("Workspace brief snapshot");
	expect(firstText).toContain("What is on this page?");
	await expect(
		page.getByText("Workspace ready.", { exact: true })
	).toBeVisible();

	// The minimal floating window keeps an app surface's removal control, and
	// offers no full-screen hand-off for its unsaved thread.
	await page.evaluate(() =>
		window.assistantStore.getState().setLayout("floating")
	);
	await expect(page.getByTestId("floating-assistant-header")).toBeVisible();
	await expect(chip).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Open assistant in full screen" })
	).toHaveCount(0);

	await chip.click();
	await expect(chip).toHaveCount(0);
	const second = page.waitForRequest("**/api/chat/stream");
	await send(page, "And now?");
	const messages: { parts: { text?: string }[]; role: string }[] = (
		await second
	).postDataJSON().messages;
	const lastUser = messages.filter((m) => m.role === "user").at(-1);
	const lastText = lastUser?.parts.map((p) => p.text ?? "").join("") ?? "";
	expect(lastText).toContain("And now?");
	expect(lastText).not.toContain("Workspace brief snapshot");
});

test("app-surface threads are separate per topic and survive closing the assistant", async ({
	page,
}) => {
	await reply(page);
	await page.goto("/assistant-panel-proof.html?builder=1");
	await expect(
		page.getByText("Build Workspace board", { exact: true })
	).toBeVisible();
	const setThread = (thread: string | undefined) =>
		page.evaluate((value) => {
			window.assistantStore.getState().updateBuilder({ thread: value });
		}, thread);
	await setThread("pr-1");
	await send(page, "About the first topic");
	await expect(
		page.getByText("Workspace ready.", { exact: true })
	).toBeVisible();

	await setThread("pr-2");
	await expect(
		page.getByText("About the first topic", { exact: true })
	).toHaveCount(0);
	const second = page.waitForRequest("**/api/chat/stream");
	await send(page, "About the second topic");
	const secondBody = (await second).postDataJSON();
	const userTurns = secondBody.messages.filter(
		(m: { role: string }) => m.role === "user"
	);
	expect(userTurns).toHaveLength(1);
	expect(JSON.stringify(userTurns)).not.toContain("About the first topic");
	expect(secondBody.conversation_id).toMatch(/::pr-2$/);

	await setThread("pr-1");
	await expect(
		page.getByText("About the first topic", { exact: true })
	).toBeVisible();

	await state(page, "close");
	await page.evaluate(() => window.assistantStore.getState().open("sidebar"));
	await expect(
		page.getByText("About the first topic", { exact: true })
	).toBeVisible();
});

test("an answered permission stays answered when a surface thread is resumed", async ({
	page,
}) => {
	await reply(page, true);
	let responses = 0;
	await page.route("**/api/chat/permission", async (route) => {
		responses += 1;
		await route.fulfill({ status: 200, body: permissionResolved });
	});
	await page.goto("/assistant-panel-proof.html?builder=1");
	await expect(
		page.getByText("Build Workspace board", { exact: true })
	).toBeVisible();
	const setThread = (thread: string) =>
		page.evaluate((value) => {
			window.assistantStore.getState().updateBuilder({ thread: value });
		}, thread);
	await setThread("pr-1");
	await send(page, "Inspect workspace");
	const allow = page.getByRole("button", { name: /Allow once/i });
	await allow.click();
	await expect(allow).toHaveCount(0);

	await setThread("pr-2");
	await setThread("pr-1");
	await expect(
		page.getByText("Inspect workspace", { exact: true })
	).toBeVisible();
	await expect(allow).toHaveCount(0);

	await state(page, "close");
	await page.evaluate(() => window.assistantStore.getState().open("sidebar"));
	await expect(
		page.getByText("Inspect workspace", { exact: true })
	).toBeVisible();
	await expect(allow).toHaveCount(0);
	expect(responses).toBe(1);
});

test("reachable builder prompt resolves target, sends ephemeral preamble and refreshes result", async ({
	page,
}) => {
	await reply(page);
	await page.goto("/assistant-panel-proof.html?builder=1");
	await expect(
		page.getByText("Build Workspace board", { exact: true })
	).toBeVisible();
	const request = page.waitForRequest("**/api/chat/stream");
	await page
		.getByRole("button", { name: "Tidy the layout", exact: true })
		.click();
	const body = (await request).postDataJSON();
	expect(body).toMatchObject({
		persist: false,
		enable_long_term: false,
		agent_id: "ryu",
		model: "fixture-model",
	});
	expect(body.conversation_id).toMatch(/^builder-/);
	expect(body.messages[0].parts[0].text).toContain(
		"Build board-proof from {widgets:[]}"
	);
	expect(body.messages[0].parts[0].text).toContain("Tidy the layout");
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.__assistantProof.calls.filter((c) => c.kind === "changed")
			)
		)
		.toEqual([{ kind: "changed", id: "board-proof" }]);
	expect(
		await page.evaluate(() =>
			window.__assistantProof.calls.filter((c) => c.kind === "resolve")
		)
	).toEqual([{ kind: "resolve" }]);
	await expect(
		page.getByText("Workspace ready.", { exact: true })
	).toBeVisible();
	await expect(page.locator("[data-chat-empty-intro]")).toHaveCount(0);
	await page.screenshot({ path: `${proofDir}/builder-completed.png` });
});
