import { expect, test } from "@playwright/test";
import { assertNativeWindowLifetime } from "./chat-page-native-http-lifetime.ts";
import {
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";

const original = "conversation-toolbar-share-fixture";
const target = "conversation-earlier-thread-fixture";
// Each run starts a fresh Vite dev server, so the first page loads compile the
// ChatPage graph on demand. This bound applies only to the two page-load
// readiness waits below; the navigation behavior keeps the default timeout.
const pageReadyTimeout = 30_000;

// Each mode renders the shipping Layout, route outlet, ChatPage and Sidebar.
// The same finite native HTTP fixture records the next real request; it does
// not execute a model provider or acknowledge a durable model response.
for (const layout of ["horizontal", "scroll", "canvas"] as const) {
	test(`${layout} current-tab navigation binds the rendered history and next native HTTP turn to the selected conversation`, async ({
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
			await page.goto("/chat-page-native-http.html?scenario=queue-isolation");
			await expect(
				page.getByText(
					"We need to share the launch plan with the organization.",
					{ exact: true }
				)
			).toBeVisible({ timeout: pageReadyTimeout });
			// Seed genuine durable preferences/session, then independently restore
			// the renderer. No route/provider mutator stands in for navigation.
			await page.evaluate(
				({ layout, original }) => {
					localStorage.setItem("ryu_tab_layout", layout);
					localStorage.setItem("ryu_tab_open_behavior", "current");
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
							],
						})
					);
				},
				{ layout, original }
			);
			await page.reload();
			await expect(
				page.getByText(
					"We need to share the launch plan with the organization.",
					{ exact: true }
				)
			).toBeVisible({ timeout: pageReadyTimeout });
			const before = await chatPageState(request);
			const panes = page.locator("[data-tab-view-pane]");
			const retainedPaneId =
				layout === "horizontal"
					? null
					: await panes.getAttribute("data-tab-view-pane");
			await page.getByTestId(`sidebar-chat-row-${target}`).click();
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							JSON.parse(localStorage.getItem("ryu_session_tabs") ?? "{}").tabs
					)
				)
				.toEqual([
					expect.objectContaining({ path: "/chat", conversationId: target }),
				]);
			if (retainedPaneId !== null) {
				await expect(panes).toHaveCount(1);
				await expect(panes).toHaveAttribute(
					"data-tab-view-pane",
					retainedPaneId
				);
			}
			await expect(
				page.getByText("This belongs to the earlier project thread.", {
					exact: true,
				})
			).toBeVisible();
			await expect(
				page.getByText(
					"We need to share the launch plan with the organization.",
					{ exact: true }
				)
			).toBeHidden();
			const selected = await chatPageState(request);
			expect(selected.histories).toEqual(before.histories);
			expect(
				selected.calls.filter((call) => call.path === "/api/chat/stream")
			).toEqual([]);
			expect(
				selected.calls.filter(
					(call) => call.path === `/api/conversations/${target}`
				)
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						node: "a",
						method: "GET",
						authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
						userJwt: null,
					}),
				])
			);
			await chatPageControl(request, {
				action: "arm_live_chat",
				node: "a",
				conversationId: target,
			});
			const prompt = `Keep the ${layout} selected conversation owned.`;
			await page
				.getByPlaceholder("Ask a follow up")
				.filter({ visible: true })
				.fill(prompt);
			await page.getByRole("button", { name: "Send", exact: true }).click();
			await expect(
				page.getByText("Owned live response in progress.", { exact: true })
			).toBeVisible();
			const after = await chatPageState(request);
			expect(
				after.calls.filter((call) => call.path === "/api/chat/stream")
			).toEqual([
				expect.objectContaining({
					node: "a",
					method: "POST",
					authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
					userJwt: null,
					body: expect.objectContaining({ conversation_id: target }),
				}),
			]);
			expect(after.histories).toEqual(before.histories);
			expect(after.unexpected).toEqual([]);
		} finally {
			await page.evaluate(() =>
				Reflect.get(window, "__chatPageNativeFixture")?.unmount()
			);
			await assertNativeWindowLifetime(page);
		}
		expect(errors).toEqual([]);
	});
}
