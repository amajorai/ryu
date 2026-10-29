import type { useTabsContext } from "../src/contexts/TabsContext.tsx";

type OpenTabOptions = NonNullable<
	Parameters<ReturnType<typeof useTabsContext>["openTab"]>[1]
>;

import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ mode: "serial", timeout: 60_000 });

const PAGE_URL = "/agent-run-history-interactions.html";

interface RecordedRequest {
	method: string;
	path: string;
}

interface ConversationSummary {
	agent_id: string | null;
	branch: string | null;
	created_at: number;
	folder_path: string | null;
	id: string;
	message_count: number;
	run_status: string | null;
	title: string | null;
	updated_at: number;
	worktree_path: string | null;
}

async function openPage(page: Page, search = "") {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${PAGE_URL}${search}`);
	await expect(
		page.getByRole("heading", { exact: true, name: "Run history" })
	).toBeVisible();
	if (!search.includes("empty")) {
		await expect(
			page.getByRole("button", { name: /Agent command center/ })
		).toBeVisible();
	}
}

async function captureProductScreenshot(page: Page, filename: string) {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: test.info().outputPath(`${filename}.png`),
	});
}

async function setFixture(
	page: Page,
	patch: {
		conversations?: ConversationSummary[];
		failNextConversationList?: boolean;
	}
) {
	await page.evaluate((patch) => {
		const fixture =
			/* SAFETY: agent-run-history-interactions.tsx installs __agentRunHistoryFixture before this proof page is evaluated. */ (
				window as Window & {
					__agentRunHistoryFixture?: {
						conversations: ConversationSummary[];
						failNextConversationList: boolean;
					};
				}
			).__agentRunHistoryFixture;
		if (!fixture) {
			throw new Error("Agent run history fixture was not installed.");
		}
		if (patch.conversations) {
			fixture.conversations = patch.conversations;
		}
		if (patch.failNextConversationList) {
			fixture.failNextConversationList = true;
		}
	}, patch);
}

async function requestsFor(page: Page, method: string, path: string) {
	return await page.evaluate(
		({ method, path }) => {
			const fixture =
				/* SAFETY: agent-run-history-interactions.tsx installs __agentRunHistoryFixture before this proof page is evaluated. */ (
					window as Window & {
						__agentRunHistoryFixture?: { requests: RecordedRequest[] };
					}
				).__agentRunHistoryFixture;
			return (
				fixture?.requests.filter(
					(request) => request.method === method && request.path === path
				) ?? []
			);
		},
		{ method, path }
	);
}

test("refresh preserves history after a failed read and reopens the selected transcript", async ({
	page,
}) => {
	await openPage(page);
	await expect(
		page.getByRole("button", { name: /Release planning/ })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Private agent conversation/ })
	).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: /Automated runs · 1/i })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Nightly agent report/ })
	).toContainText("Failed");
	await captureProductScreenshot(page, "agent-run-history-populated");

	await setFixture(page, { failNextConversationList: true });
	await page.getByRole("button", { exact: true, name: "Refresh" }).click();
	await expect(
		page.getByRole("button", { name: /Release planning/ })
	).toBeVisible();
	await expect(
		await requestsFor(page, "GET", "/api/conversations")
	).toHaveLength(2);

	const refreshed = await page.evaluate(() => {
		const fixture =
			/* SAFETY: agent-run-history-interactions.tsx installs __agentRunHistoryFixture before this proof page is evaluated. */ (
				window as Window & {
					__agentRunHistoryFixture?: { conversations: ConversationSummary[] };
				}
			).__agentRunHistoryFixture;
		if (!fixture) {
			throw new Error("Agent run history fixture was not installed.");
		}
		return fixture.conversations.map((conversation) =>
			conversation.id === "chat-release-planning"
				? {
						...conversation,
						title: "Release planning refreshed",
						updated_at: conversation.updated_at + 120_000,
					}
				: conversation
		);
	});
	await setFixture(page, { conversations: refreshed });
	await page.getByRole("button", { exact: true, name: "Refresh" }).click();
	const refreshedRow = page.getByRole("button", {
		name: /Release planning refreshed/,
	});
	await expect(refreshedRow).toBeVisible();
	await expect(
		await requestsFor(page, "GET", "/api/conversations")
	).toHaveLength(3);
	await captureProductScreenshot(page, "agent-run-history-refresh-recovered");

	await refreshedRow.click();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const fixture =
					/* SAFETY: agent-run-history-interactions.tsx installs __agentRunHistoryFixture before this proof page is evaluated. */ (
						window as Window & {
							__agentRunHistoryFixture?: {
								activeConversationId: string | null;
								openedTabs: Array<{
									options: OpenTabOptions;
									path: string;
								}>;
							};
						}
					).__agentRunHistoryFixture;
				return fixture
					? {
							activeConversationId: fixture.activeConversationId,
							openedTabs: fixture.openedTabs,
						}
					: null;
			})
		)
		.toEqual({
			activeConversationId: "chat-release-planning",
			openedTabs: [
				{
					options: { conversationId: "chat-release-planning" },
					path: "/chat",
				},
			],
		});
});

test("empty history starts a new chat for the current agent", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${PAGE_URL}?empty=1`);
	await expect(page.getByText("No runs yet", { exact: true })).toBeVisible();
	await expect(
		page.getByText(/Chat with this agent or schedule an automation/)
	).toBeVisible();
	await captureProductScreenshot(page, "agent-run-history-empty-state");

	await page.getByRole("button", { name: "Chat with this agent" }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: agent-run-history-interactions.tsx installs __agentRunHistoryFixture before this proof page is evaluated. */ (
						window as Window & {
							__agentRunHistoryFixture?: {
								openedTabs: Array<{
									options: OpenTabOptions;
									path: string;
								}>;
							};
						}
					).__agentRunHistoryFixture?.openedTabs ?? []
			)
		)
		.toEqual([
			{
				options: { forceNew: true, initialAgent: "agent-run-history-proof" },
				path: "/chat",
			},
		]);
	await expect(
		await requestsFor(page, "POST", "/api/conversations")
	).toHaveLength(0);
});
