// Actual Layout and ChatPage over native browser HTTP. Core is a finite
// transport fixture: it serves one finished turn whose agent called
// `tasks.suggest`, captures every request the page makes, and never runs a model.
// These cases prove what ChatPage's suggested-task actions send and change.
// The card, Dismiss, Start (project, tab, worktree, agent) and Save to Drafts.
// Shared setup: `chat-page-native-http-task-suggestion.ts`.
import { expect, test } from "@playwright/test";
import {
	CONVERSATION_ID,
	OTHER_WORKSPACE_PATH,
	SUGGESTED_TASK,
	WORKSPACE_PATH,
} from "./chat-page-native-http-state.ts";
import { chatPageState } from "./chat-page-native-http-support.ts";
import {
	card,
	cleanUpTaskSuggestionPage,
	draftWrites,
	ORIGINAL_TITLE,
	open,
	type StreamBody,
	streamCalls,
	submittedText,
	tabs,
} from "./chat-page-native-http-task-suggestion.ts";

test.afterEach(async ({ page }, testInfo) => {
	await cleanUpTaskSuggestionPage(page, testInfo);
});

test("the suggestion sits above the composer and shows the full task", async ({
	page,
}) => {
	await open(page, "task-suggestion");
	const shown = card(page);
	await expect(shown).toContainText(SUGGESTED_TASK.title);
	await expect(shown).toContainText(SUGGESTED_TASK.description);
	// The full prompt is one click away, so the user sees what Start will send.
	await shown.getByText("Show prompt", { exact: true }).click();
	await expect(shown).toContainText(SUGGESTED_TASK.prompt);
	const cardBox = await shown.boundingBox();
	const composerBox = await page
		.getByPlaceholder("Ask a follow up")
		.filter({ visible: true })
		.boundingBox();
	expect(cardBox).not.toBeNull();
	expect(composerBox).not.toBeNull();
	expect((cardBox?.y ?? 0) + (cardBox?.height ?? 0)).toBeLessThanOrEqual(
		composerBox?.y ?? 0
	);
});

test("Dismiss closes the card and sends nothing", async ({ page }) => {
	await open(page, "task-suggestion");
	await card(page)
		.getByRole("button", { name: "Dismiss suggested task", exact: true })
		.click();
	await expect(card(page)).toBeHidden();
	expect(await streamCalls(page)).toEqual([]);
	expect(await draftWrites(page)).toEqual([]);
	await expect(tabs(page)).toHaveCount(1);
});

test("Start opens the task as a new chat in the thread's project and sends its prompt", async ({
	page,
}) => {
	await open(page, "task-suggestion");
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	await expect(card(page)).toBeHidden();
	// A second chat opens beside this one and its first turn streams.
	await expect(tabs(page)).toHaveCount(2);
	await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
	const [call] = await streamCalls(page);
	const body = call?.body as StreamBody;
	expect(body.conversation_id).toBeTruthy();
	expect(body.conversation_id).not.toBe(CONVERSATION_ID);
	expect(submittedText(body)).toBe(SUGGESTED_TASK.prompt);
	// The thread's project, not the global selection (which is somewhere else).
	expect(OTHER_WORKSPACE_PATH).not.toBe(WORKSPACE_PATH);
	expect(body.cwd).toBe(WORKSPACE_PATH);
	expect(body.worktree_isolation).toBe(false);
	expect(await draftWrites(page)).toEqual([]);
});

test("Start never takes over this thread's tab, even when pages open in the current tab", async ({
	page,
}) => {
	await page.addInitScript(() =>
		localStorage.setItem("ryu_tab_open_behavior", "current")
	);
	await open(page, "task-suggestion");
	const thread = tabs(page).filter({
		has: page.getByRole("button", { name: ORIGINAL_TITLE, exact: true }),
	});
	await expect(thread).toHaveCount(1);
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	// The task opened beside this thread, which is still there and not active.
	await expect(tabs(page)).toHaveCount(2);
	await expect(thread).toHaveCount(1);
	await expect(thread).toHaveAttribute("data-active", "false");
});

test("Start in a worktree asks Core to isolate the new chat in a worktree", async ({
	page,
}) => {
	await open(page, "task-suggestion");
	await card(page)
		.getByRole("button", { name: "More ways to start", exact: true })
		.click();
	await page
		.getByRole("menuitem", { name: "Start in a worktree", exact: true })
		.click();
	await expect(card(page)).toBeHidden();
	await expect(tabs(page)).toHaveCount(2);
	await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
	const [call] = await streamCalls(page);
	const body = call?.body as StreamBody;
	expect(body.conversation_id).not.toBe(CONVERSATION_ID);
	expect(submittedText(body)).toBe(SUGGESTED_TASK.prompt);
	expect(body.cwd).toBe(WORKSPACE_PATH);
	expect(body.worktree_isolation).toBe(true);
	expect(body.worktree_branch).toBe("existing-native-proof-branch");
});

test("Start opens the new chat with the thread's agent", async ({ page }) => {
	await open(page, "task-suggestion-agent");
	const agentSettings = page.getByRole("button", {
		name: "Chat settings · Second Agent",
		exact: true,
	});
	await expect(agentSettings).toBeVisible();
	await card(page).getByRole("button", { name: "Start", exact: true }).click();
	await expect(card(page)).toBeHidden();
	await expect(tabs(page)).toHaveCount(2);
	// The visible chat is the NEW one and it runs the same agent.
	const newChat = tabs(page).filter({ hasNotText: "Toolbar share regression" });
	await expect(newChat).toHaveAttribute("data-active", "true");
	await expect(agentSettings).toBeVisible();
	await expect(agentSettings).toHaveCount(1);
});

test("Save to Drafts stores the prompt for this thread's project and agent, then closes the card", async ({
	page,
}) => {
	await open(page, "task-suggestion-agent");
	await card(page)
		.getByRole("button", { name: "Save to Drafts", exact: true })
		.click();
	await expect(card(page)).toBeHidden();
	await expect(
		page.getByText("Saved to Drafts", { exact: true })
	).toBeVisible();
	const writes = await draftWrites(page);
	expect(writes).toHaveLength(1);
	// The thread's own project and agent, not the global project selection.
	expect(writes[0]?.body).toEqual({
		agent_id: "agent-second",
		folder_path: WORKSPACE_PATH,
		source: "manual",
		text: SUGGESTED_TASK.prompt,
	});
	const state = await chatPageState(page.request);
	expect(state.drafts).toHaveLength(1);
	// The project's draft list was read again after the write.
	const order = state.calls
		.filter((entry) => entry.path.startsWith("/api/drafts/"))
		.map((entry) => `${entry.method} ${entry.path}`);
	expect(order.lastIndexOf("POST /api/drafts/drafts")).toBeGreaterThan(-1);
	expect(order.slice(order.lastIndexOf("POST /api/drafts/drafts"))).toContain(
		"GET /api/drafts/list"
	);
	expect(await streamCalls(page)).toEqual([]);
	await expect(tabs(page)).toHaveCount(1);
});

test("without a project folder or the Drafts app there is no worktree or draft option", async ({
	page,
}) => {
	await open(page, "task-suggestion-bare");
	await expect(
		card(page).getByRole("button", { name: "Start", exact: true })
	).toBeVisible();
	await expect(
		card(page).getByRole("button", { name: "Save to Drafts", exact: true })
	).toHaveCount(0);
	await expect(
		card(page).getByRole("button", { name: "More ways to start", exact: true })
	).toHaveCount(0);
});
