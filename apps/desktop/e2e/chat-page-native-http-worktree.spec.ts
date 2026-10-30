// Actual Layout/PinnedSummaryPanel/ChatPage callers and native browser HTTP.
// Core is a finite transport fixture: this proves next-turn handoff policy, not
// filesystem checkout or a model provider completing the requested response.
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
		})
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Environment", exact: true })
	).toBeVisible();
}
async function dialog(page: Page) {
	const section = page.getByRole("button", {
		name: "Environment",
		exact: true,
	});
	if ((await section.getAttribute("aria-expanded")) !== "true") {
		await section.click();
	}
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
		const tabs = JSON.parse(
			(
				Reflect.get(window, "__chatPageNativeFixture") as {
					sealedLocalItem: (key: string) => string | null;
				}
			).sealedLocalItem("ryu_session_tabs") ?? "{}"
		);
		return {
			branch: localStorage.getItem("ryu_workspace_worktree_branch"),
			mode: localStorage.getItem("ryu_workspace_worktree_mode"),
			tab: tabs.tabs?.find(
				(t: { conversationId?: string }) =>
					t.conversationId === "conversation-toolbar-share-fixture"
			)?.worktreeMode,
		};
	});
}
async function send(page: Page, prompt: string) {
	await page.getByPlaceholder("Ask a follow up").fill(prompt);
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
test("cancel and whitespace branch never arm the real chat or send a chat or Git mutation", async ({
	page,
	request,
}) => {
	await open(page);
	const before = await saved(page);
	const d = await dialog(page);
	await d.getByLabel("Branch name").fill("   ");
	await expect(
		d.getByRole("button", { name: "Hand off", exact: true })
	).toBeDisabled();
	await d.getByLabel("Branch name").press("Enter");
	await expect(d).toBeVisible();
	await d.press("Escape");
	await expect(d).toBeHidden();
	expect(await saved(page)).toEqual(before);
	expect(
		(await chatPageState(request)).calls.filter(
			(c) => c.node === "a" && isChatOrGitMutation(c)
		)
	).toEqual([]);
});
test("handoff persists trimmed branch and tab isolation, and the next actual chat request uses them after reload", async ({
	page,
	request,
}) => {
	await open(page);
	await handOff(page, "  ryu/real-handoff-proof  ");
	await expect
		.poll(() => saved(page))
		.toEqual({ branch: "ryu/real-handoff-proof", mode: "true", tab: true });
	expect(
		(await chatPageState(request)).calls.filter(
			(c) => c.path === "/api/chat/stream"
		)
	).toEqual([]);
	await page.reload();
	await expect(
		page.getByText("We need to share the launch plan with the organization.", {
			exact: true,
		})
	).toBeVisible();
	expect(await saved(page)).toEqual({
		branch: "ryu/real-handoff-proof",
		mode: "true",
		tab: true,
	});
	await send(page, "Continue on the selected worktree");
	await expect
		.poll(async () => {
			const calls = (await chatPageState(request)).calls.filter(
				(c) => c.path === "/api/chat/stream"
			);
			return calls.length === 1 && calls[0]?.responseStatus === 503;
		})
		.toBe(true);
	const [call] = (await chatPageState(request)).calls.filter(
		(c) => c.path === "/api/chat/stream"
	);
	expect(call).toMatchObject({
		node: "a",
		method: "POST",
		authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
		userJwt: null,
		responseStatus: 503,
		body: {
			conversation_id: CONVERSATION,
			cwd: FOLDER,
			worktree_isolation: true,
			worktree_branch: "ryu/real-handoff-proof",
		},
	});
	expect(
		(await chatPageState(request)).calls.filter(
			(c) => c.node === "b" && isChatOrGitMutation(c)
		)
	).toEqual([]);
});
test("returning to Local after a handoff clears the tab override and omits worktree branch in the real next-turn payload", async ({
	page,
	request,
}) => {
	await open(page);
	await handOff(page, "ryu/return-local-proof");
	await page
		.getByRole("button", { name: "New worktree", exact: true })
		.first()
		.click();
	await page
		.getByRole("dialog", { name: "Choose where this chat works" })
		.getByRole("option", { name: "Local", exact: true })
		.click();
	await expect
		.poll(() => saved(page))
		.toEqual({ branch: "ryu/return-local-proof", mode: "false", tab: false });
	await send(page, "Continue in the local project");
	await expect
		.poll(
			async () =>
				(await chatPageState(request)).calls.filter(
					(c) => c.path === "/api/chat/stream" && c.responseStatus === 503
				).length
		)
		.toBe(1);
	const [call] = (await chatPageState(request)).calls.filter(
		(c) => c.path === "/api/chat/stream"
	);
	expect(call?.body).toMatchObject({
		conversation_id: CONVERSATION,
		cwd: FOLDER,
		worktree_isolation: false,
	});
	expect(call?.body).not.toHaveProperty("worktree_branch");
	expect(call?.authorization).toBe(`Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`);
});
