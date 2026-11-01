import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
	sidebarPersistedConversationIds,
	sidebarThreadImportSchema,
} from "./app-sidebar-interactions-proof.contracts.ts";
import {
	chooseChatsMenuAction,
	registerAppSidebarProofHooks,
	tabs,
	unexpectedBrowserErrors,
} from "./app-sidebar-interactions-proof.fixture.ts";
import {
	jsonResponse,
	STORY_URL,
} from "./app-sidebar-interactions-proof.fixture-data.ts";

registerAppSidebarProofHooks();

const DATA_FLOW_PROOF = fileURLToPath(
	new URL(
		"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-data-flows/import-browse/",
		import.meta.url
	)
);

test("data-flow import retries denied lists and failed-only batches through the real sidebar", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let denyList = true;
	let denyImport = true;
	let releaseImport: (() => void) | undefined;
	const imported: string[] = [];
	const writes: unknown[] = [];
	await page.route("**/api/agents/agent-alpha/threads**", async (route) => {
		const request = route.request();
		if (request.method() === "GET") {
			if (denyList) {
				denyList = false;
				return route.fulfill(jsonResponse({ error: "denied" }, 403));
			}
			return route.fulfill(
				jsonResponse({
					supported: true,
					engine: "claude-code",
					threads: [
						{
							id: "thread-success",
							title: "Successful native thread",
							message_count: 3,
							updated_at: 200,
							engine: "claude-code",
						},
						{
							id: "thread-retry",
							title: "Retry native thread",
							message_count: 4,
							updated_at: 100,
							engine: "claude-code",
						},
					],
				})
			);
		}
		const body = sidebarThreadImportSchema.parse(request.postDataJSON());
		writes.push(body);
		if (writes.length === 1) {
			await new Promise<void>((resolve) => {
				releaseImport = resolve;
			});
		}
		if (body.thread_id === "thread-retry" && denyImport) {
			denyImport = false;
			return route.fulfill(jsonResponse({ error: "denied" }, 403));
		}
		imported.push(body.thread_id);
		return route.fulfill(
			jsonResponse({
				conversation_id: `conversation-${body.thread_id}`,
				dry_run: false,
				messages_added: 3,
			})
		);
	});
	await page.goto(
		`${STORY_URL}?focus=chats,tabs&auth=off&mode=sections&session=main&seed=data-flow`
	);
	// The import lives in the Chats ⋯ menu since 306ce31b7f.
	const openThreadImport = () =>
		chooseChatsMenuAction(page, "Import a past agent thread");
	await openThreadImport();
	const dialog = page.getByRole("dialog", { name: "Import a thread" });
	await expect(dialog).toContainText("Failed to load agent threads: 403");
	await dialog.getByRole("button", { name: "Retry", exact: true }).click();
	await dialog.getByRole("button", { name: "Select all", exact: true }).click();
	await expect(dialog).toContainText("2 of 2 selected");
	await dialog
		.getByRole("button", { name: "Deselect all", exact: true })
		.click();
	await expect(
		dialog.getByRole("button", { name: "Import", exact: true })
	).toBeDisabled();
	await dialog.getByRole("button", { name: "Select all", exact: true }).click();
	await dialog.getByRole("button", { name: "Import 2", exact: true }).click();
	await expect.poll(() => Boolean(releaseImport)).toBe(true);
	await expect(dialog.getByRole("combobox")).toBeDisabled();
	await expect(
		dialog.getByRole("button", { name: "Cancel", exact: true })
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeVisible();
	releaseImport?.();
	await expect(dialog.getByRole("status")).toContainText("1 imported");
	await expect(dialog).toContainText(
		"Failed to import thread. Retry the selected thread."
	);
	await expect(
		dialog.getByRole("button", { name: /Successful native thread/ })
	).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: /Retry native thread/ })
	).toHaveAttribute("aria-pressed", "true");
	await mkdir(DATA_FLOW_PROOF, { recursive: true });
	await dialog.screenshot({
		path: `${DATA_FLOW_PROOF}/import-partial-retry.png`,
		animations: "disabled",
	});
	await dialog.getByRole("button", { name: "Import 1", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(writes).toEqual([
		{ thread_id: "thread-success", dry_run: false },
		{ thread_id: "thread-retry", dry_run: false },
		{ thread_id: "thread-retry", dry_run: false },
	]);
	expect(imported).toEqual(["thread-success", "thread-retry"]);
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.find((tab) => tab.id === state.activeTabId)
				?.conversationId;
		})
		.toBe("conversation-thread-success");
	// The session snapshot is sealed (content-seal.ts), so read it through the
	// app's sealed storage, and let the sealed write land before restarting.
	await expect
		.poll(() =>
			page
				.evaluate(() => {
					const read = Reflect.get(window, "__readSessionTabs");
					return JSON.parse(
						typeof read === "function" ? (read() ?? "null") : "null"
					);
				})
				.then(sidebarPersistedConversationIds)
		)
		.toContain("conversation-thread-success");
	await page.evaluate(async () => {
		const flush = Reflect.get(window, "__flushSealedStorage");
		if (typeof flush === "function") {
			await flush();
		}
	});
	await page.reload();
	await expect(page.getByTestId("tab-state")).toContainText(
		"conversation-thread-success"
	);
	await openThreadImport();
	await expect(
		dialog.getByRole("button", { name: /Successful native thread/ })
	).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(writes).toHaveLength(3);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${DATA_FLOW_PROOF}/import-completed-readback.png`,
		animations: "disabled",
	});
	expect(unexpectedBrowserErrors.get(page)).toEqual([
		"http://127.0.0.1:7980/api/agents/agent-alpha/threads: Failed to load resource: the server responded with a status of 403 (Forbidden)",
		"http://127.0.0.1:7980/api/agents/agent-alpha/threads/import: Failed to load resource: the server responded with a status of 403 (Forbidden)",
	]);
	expect(errors).toEqual([]);
});

test("data-flow import ignores a late previous-agent list and cancels without writes", async ({
	page,
}) => {
	let releaseAlpha: (() => void) | undefined;
	let alphaComplete = false;
	const writes: string[] = [];
	await page.route("**/api/agents/*/threads**", async (route) => {
		if (route.request().method() !== "GET") {
			writes.push(route.request().url());
			return route.fulfill(jsonResponse({}));
		}
		if (route.request().url().includes("agent-alpha")) {
			await new Promise<void>((resolve) => {
				releaseAlpha = resolve;
			});
			await route.fulfill(
				jsonResponse({
					supported: true,
					threads: [
						{
							id: "late",
							title: "Late wrong agent",
							message_count: 1,
							updated_at: 100,
							engine: "claude-code",
						},
					],
				})
			);
			alphaComplete = true;
			return;
		}
		return route.fulfill(jsonResponse({ supported: false, threads: [] }));
	});
	await page.goto(
		`${STORY_URL}?focus=chats&auth=off&mode=sections&seed=data-flow-stale`
	);
	await chooseChatsMenuAction(page, "Import a past agent thread");
	const dialog = page.getByRole("dialog", { name: "Import a thread" });
	await expect.poll(() => Boolean(releaseAlpha)).toBe(true);
	await dialog.getByRole("combobox").click();
	await page.getByRole("option", { name: "Agent Beta" }).click();
	await expect(dialog).toContainText(
		"This agent doesn't keep an importable local history."
	);
	releaseAlpha?.();
	await expect.poll(() => alphaComplete).toBe(true);
	await expect(dialog).toContainText(
		"This agent doesn't keep an importable local history."
	);
	await expect(
		dialog.getByRole("button", { name: /Late wrong agent/ })
	).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	expect(writes).toEqual([]);
	expect(unexpectedBrowserErrors.get(page)).toEqual([]);
});
