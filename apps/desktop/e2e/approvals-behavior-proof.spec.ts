import path from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface ProofCall {
	input: unknown;
	method: string;
}

interface MountOptions {
	failMethods?: string[];
}

interface FixtureState {
	ackResult: boolean;
	approvals: Array<{ id: string; status: string; title: string }>;
	feedback: Array<{ kind: string; suggestion_type: string }>;
	notifications: Array<{
		acked: boolean;
		archived_at?: string | null;
		id: string;
		read_at?: string | null;
	}>;
	quests: Array<{ id: string; status: string; suggestion?: unknown }>;
	suggestions: Array<{ id: string; suggestion_type: string }>;
}

declare global {
	interface Window {
		__approvalsProof: {
			blockNext(method: string): void;
			clearCalls(): void;
			calls(): ProofCall[];
			connected(): boolean;
			failNext(method: string): void;
			mount(options?: MountOptions): Promise<void>;
			release(method: string): void;
			snapshot(): FixtureState;
			waiting(method: string): boolean;
		};
	}
}

async function mountInbox(page: Page, options: MountOptions = {}) {
	await page.goto("/approvals-behavior-proof.html");
	await page.waitForFunction(() => window.__approvalsProof !== undefined);
	await page.evaluate(
		(mountOptions) => window.__approvalsProof.mount(mountOptions),
		options
	);
	await expect
		.poll(() => page.evaluate(() => window.__approvalsProof.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	const frame = page.frameLocator('iframe[title="Approvals behavior proof"]');
	await expect(frame.getByRole("heading", { name: "Inbox" })).toBeVisible();
	return frame;
}

function approvalCard(frame: FrameLocator, title: string) {
	return frame.getByText(title, { exact: true }).locator("xpath=../../../..");
}

function taskCard(frame: FrameLocator, title: string) {
	return frame.getByText(title, { exact: true }).locator("xpath=../../../..");
}

function notificationCard(frame: FrameLocator, title: string) {
	return frame
		.getByRole("button", { name: new RegExp(title) })
		.locator("xpath=../../..");
}

function suggestionCard(frame: FrameLocator, title: string) {
	return frame.locator("li").filter({ hasText: title });
}

async function calls(page: Page): Promise<ProofCall[]> {
	return page.evaluate(() => window.__approvalsProof.calls());
}

async function callFor(page: Page, method: string): Promise<ProofCall[]> {
	return (await calls(page)).filter((call) => call.method === method);
}

async function snapshot(page: Page): Promise<FixtureState> {
	return page.evaluate(() => window.__approvalsProof.snapshot());
}

async function screenshot(page: Page, name: string): Promise<void> {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, name),
	});
}

test("approval list retry and manual refresh recover the feeds with real loaded rows", async ({
	page,
}) => {
	const frame = await mountInbox(page, { failMethods: ["approvals.list"] });
	await expect(frame.getByText("Couldn't load approvals")).toBeVisible();
	await expect(frame.getByRole("button", { name: "Retry" })).toBeVisible();
	await expect(frame.getByText("Inbox is empty")).toHaveCount(0);
	await frame.getByRole("button", { name: "Retry" }).click();
	await expect(
		frame.getByText("Allow outbound message", { exact: true })
	).toBeVisible();
	await expect(frame.getByText("2 pending", { exact: true })).toBeVisible();
	await expect(
		frame.getByText("Previous expired request", { exact: true })
	).toBeVisible();

	await page.evaluate(() => window.__approvalsProof.clearCalls());
	await frame.getByRole("button", { name: "Refresh" }).click();
	await expect(frame.getByRole("button", { name: "Refresh" })).toBeEnabled();
	await expect
		.poll(async () => {
			const methods = (await calls(page)).map((call) => call.method);
			return [
				"approvals.list",
				"quests.list",
				"notifications.list",
				"suggestions.list",
			].every((method) => methods.includes(method));
		})
		.toBe(true);
	const refreshCalls = await calls(page);
	expect(
		refreshCalls.filter((call) => call.method === "notifications.list")
	).toEqual([{ input: null, method: "notifications.list" }]);
	await screenshot(page, "approvals-inbox-refresh-recovered.png");
});

test("pull-to-refresh keeps the drag gesture and reloads each inbox feed", async ({
	page,
}) => {
	const frame = await mountInbox(page);
	await page.evaluate(() => window.__approvalsProof.clearCalls());
	const heading = await frame
		.getByRole("heading", { name: "Inbox" })
		.boundingBox();
	if (!heading) {
		throw new Error("Inbox heading has no pointer target.");
	}
	const startX = heading.x + heading.width / 2;
	const startY = heading.y + heading.height / 2;
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(startX, startY + 190, { steps: 5 });
	await expect(
		frame.getByText("Release to refresh", { exact: true })
	).toBeVisible();
	await page.mouse.up();
	await expect
		.poll(async () => {
			const methods = (await calls(page)).map((call) => call.method);
			return [
				"approvals.list",
				"quests.list",
				"notifications.list",
				"suggestions.list",
			].every((method) => methods.includes(method));
		})
		.toBe(true);
	await expect(frame.getByRole("button", { name: "Refresh" })).toBeEnabled();
});

test("approve and reject commit decisions, serialize in-flight actions, and leave history", async ({
	page,
}) => {
	const frame = await mountInbox(page);
	await expect(frame.getByText("2 pending", { exact: true })).toBeVisible();

	await page.evaluate(() =>
		window.__approvalsProof.blockNext("approvals.approve")
	);
	const sendRow = approvalCard(frame, "Allow outbound message");
	const approveButton = sendRow.getByRole("button", { name: "Approve" });
	await approveButton.click();
	await expect(sendRow.getByRole("button", { name: "Approve" })).toBeDisabled();
	await expect(sendRow.getByRole("button", { name: "Reject" })).toBeDisabled();
	await expect
		.poll(() =>
			page.evaluate(() => window.__approvalsProof.waiting("approvals.approve"))
		)
		.toBe(true);
	expect(await callFor(page, "approvals.approve")).toEqual([
		{ input: { id: "approval-send" }, method: "approvals.approve" },
	]);
	await page.evaluate(() =>
		window.__approvalsProof.release("approvals.approve")
	);
	await expect(
		frame.getByText("Allow outbound message", { exact: true })
	).toHaveCount(1);
	await expect(frame.getByText("approved", { exact: true })).toBeVisible();
	await expect(frame.getByText("1 pending", { exact: true })).toBeVisible();

	await page.evaluate(() =>
		window.__approvalsProof.failNext("approvals.reject")
	);
	const resumeRow = approvalCard(frame, "Resume workflow step");
	await resumeRow.getByRole("button", { name: "Reject" }).click();
	await expect(
		frame.getByText("Fixture failure: approvals.reject")
	).toBeVisible();
	await expect(resumeRow.getByRole("button", { name: "Reject" })).toBeEnabled();
	await expect(frame.getByText("1 pending", { exact: true })).toBeVisible();
	await screenshot(page, "approvals-decision-retry-error.png");

	await resumeRow.getByRole("button", { name: "Reject" }).click();
	await expect(frame.getByText("rejected", { exact: true })).toBeVisible();
	await expect(frame.getByText("0 pending", { exact: true })).toHaveCount(0);
	const rejectCalls = await callFor(page, "approvals.reject");
	expect(rejectCalls).toEqual([
		{ input: { id: "approval-resume" }, method: "approvals.reject" },
		{ input: { id: "approval-resume" }, method: "approvals.reject" },
	]);
	const final = await snapshot(page);
	expect(
		final.approvals.find((item) => item.id === "approval-send")?.status
	).toBe("approved");
	expect(
		final.approvals.find((item) => item.id === "approval-resume")?.status
	).toBe("rejected");
	await screenshot(page, "approvals-decision-history.png");
});

test("task suggestions accept as done and dismiss for later with retry recovery", async ({
	page,
}) => {
	const frame = await mountInbox(page);
	const completeRow = taskCard(frame, "Prepare release notes");
	await page.evaluate(() =>
		window.__approvalsProof.failNext("quests.acceptSuggestion")
	);
	await completeRow.getByRole("button", { name: "Mark done" }).click();
	await expect(
		frame.getByText("Fixture failure: quests.acceptSuggestion")
	).toBeVisible();
	await expect(
		completeRow.getByRole("button", { name: "Mark done" })
	).toBeEnabled();
	await completeRow.getByRole("button", { name: "Mark done" }).click();
	await expect(
		frame.getByText("Prepare release notes", { exact: true })
	).toHaveCount(0);

	const laterRow = taskCard(frame, "Review changelog");
	await laterRow.getByRole("button", { name: "Not yet" }).click();
	await expect(
		frame.getByText("Review changelog", { exact: true })
	).toHaveCount(0);
	const result = await snapshot(page);
	expect(
		result.quests.find((quest) => quest.id === "quest-complete")
	).toMatchObject({
		completed_at: expect.any(String),
		status: "done",
	});
	expect(
		result.quests.find((quest) => quest.id === "quest-snooze")
	).toMatchObject({
		status: "open",
		suggestion: null,
	});
	expect(await callFor(page, "quests.acceptSuggestion")).toEqual([
		{ input: { id: "quest-complete" }, method: "quests.acceptSuggestion" },
		{ input: { id: "quest-complete" }, method: "quests.acceptSuggestion" },
	]);
	expect(await callFor(page, "quests.dismissSuggestion")).toEqual([
		{ input: { id: "quest-snooze" }, method: "quests.dismissSuggestion" },
	]);
	await screenshot(page, "approvals-tasks-reviewed.png");
});

test("notification filters, read, ack, archive, and restore preserve the right inbox states", async ({
	page,
}) => {
	const frame = await mountInbox(page);
	await expect(frame.getByText("2 unread", { exact: true })).toBeVisible();
	await expect(frame.getByRole("tab", { name: /All\s+4/ })).toBeVisible();
	await expect(frame.getByRole("tab", { name: /Archived\s+1/ })).toBeVisible();
	await expect(frame.getByRole("tab", { name: /Warning\s+1/ })).toBeVisible();
	await expect(frame.getByLabel("Workflow Engine")).toBeVisible();
	expect(await callFor(page, "notifications.appIcons")).toContainEqual({
		input: { appIds: ["@ryu/deployments", "@ryu/workflows"] },
		method: "notifications.appIcons",
	});

	for (const [level, title] of [
		["Info", "Older archived notice"],
		["Success", "Build completed"],
		["Warning", "Workflow paused at review"],
		["Error", "Action needed"],
	]) {
		await frame.getByRole("tab", { name: new RegExp(`${level}\\s+1`) }).click();
		await expect(frame.getByText(title, { exact: true })).toBeVisible();
		await expect(
			frame.getByRole("tab", { name: new RegExp(`${level}\\s+1`) })
		).toHaveAttribute("aria-selected", "true");
	}

	await frame.getByRole("tab", { name: /Error\s+1/ }).click();
	await expect(frame.getByText("Action needed", { exact: true })).toBeVisible();
	await expect(
		frame.getByText("Workflow paused at review", { exact: true })
	).toHaveCount(0);
	await frame.getByRole("tab", { name: /Unread\s+2/ }).click();
	await expect(frame.getByText("Action needed", { exact: true })).toBeVisible();
	await expect(
		frame.getByText("Workflow paused at review", { exact: true })
	).toBeVisible();

	await notificationCard(frame, "Workflow paused at review").click();
	await expect(frame.getByText("1 unread", { exact: true })).toBeVisible();
	await expect
		.poll(async () => (await callFor(page, "notifications.markRead")).length)
		.toBe(1);
	expect(await callFor(page, "notifications.markRead")).toEqual([
		{ input: { id: "notification-ack" }, method: "notifications.markRead" },
	]);

	await frame.getByRole("tab", { name: /All\s+4/ }).click();
	const ackRow = notificationCard(frame, "Workflow paused at review");
	await ackRow.getByRole("button", { name: "Ack", exact: true }).click();
	await expect(ackRow.getByText("Acknowledged", { exact: true })).toBeVisible();
	await expect(
		ackRow.getByRole("button", { name: "Ack", exact: true })
	).toHaveCount(0);
	expect(await callFor(page, "notifications.ack")).toEqual([
		{ input: { id: "notification-ack" }, method: "notifications.ack" },
	]);

	const actionRow = notificationCard(frame, "Action needed");
	await actionRow.getByRole("button", { name: "Archive" }).click();
	await expect(
		actionRow.getByRole("button", { name: "Restore to inbox" })
	).toBeVisible();
	let state = await snapshot(page);
	expect(
		state.notifications.find((item) => item.id === "notification-error")
	).toMatchObject({
		archived_at: expect.any(String),
		read_at: expect.any(String),
	});
	await frame.getByRole("tab", { name: /Archived\s+2/ }).click();
	await expect(frame.getByText("Action needed", { exact: true })).toBeVisible();
	await actionRow.getByRole("button", { name: "Restore to inbox" }).click();
	await expect(frame.getByText("Action needed", { exact: true })).toHaveCount(
		0
	);
	expect(await callFor(page, "notifications.archive")).toEqual([
		{ input: { id: "notification-error" }, method: "notifications.archive" },
	]);
	expect(await callFor(page, "notifications.unarchive")).toEqual([
		{ input: { id: "notification-error" }, method: "notifications.unarchive" },
	]);
	state = await snapshot(page);
	expect(
		state.notifications.find((item) => item.id === "notification-error")
			?.archived_at
	).toBeNull();
	await frame.getByRole("tab", { name: /All\s+4/ }).click();
	await expect(frame.getByText("Action needed", { exact: true })).toBeVisible();
	await screenshot(page, "approvals-notifications-restored.png");
});

test("failed notification archive leaves the row live and retryable", async ({
	page,
}) => {
	const frame = await mountInbox(page);
	const actionRow = notificationCard(frame, "Action needed");
	await page.evaluate(() =>
		window.__approvalsProof.failNext("notifications.archive")
	);
	await actionRow.getByRole("button", { name: "Archive" }).click();
	await expect(
		frame.getByText("Fixture failure: notifications.archive")
	).toBeVisible();
	await expect(
		actionRow.getByRole("button", { name: "Archive" })
	).toBeEnabled();
	expect(
		(await snapshot(page)).notifications.find(
			(item) => item.id === "notification-error"
		)?.archived_at
	).toBeNull();
	await screenshot(page, "approvals-notification-archive-retry-error.png");
	await actionRow.getByRole("button", { name: "Archive" }).click();
	await expect(
		actionRow.getByRole("button", { name: "Restore to inbox" })
	).toBeVisible();
	expect(await callFor(page, "notifications.archive")).toEqual([
		{ input: { id: "notification-error" }, method: "notifications.archive" },
		{ input: { id: "notification-error" }, method: "notifications.archive" },
	]);
});

test("suggestion actions report feedback and open the chat with a trimmed prompt", async ({
	page,
}) => {
	const frame = await mountInbox(page);
	const chatSuggestion = suggestionCard(frame, "Review yesterday’s notes");
	await chatSuggestion.getByRole("button", { name: "Open in chat" }).click();
	await expect
		.poll(async () => (await callFor(page, "shell.openTab")).length)
		.toBe(1);
	expect(await callFor(page, "suggestions.feedback")).toContainEqual({
		input: { kind: "thumbs_up", suggestion_type: "follow_up" },
		method: "suggestions.feedback",
	});
	expect(await callFor(page, "shell.openTab")).toEqual([
		{
			input: {
				forceNew: true,
				initialPrompt: "Review yesterday’s notes",
				path: "/chat",
				title: "Chat",
			},
			method: "shell.openTab",
		},
	]);
	await expect(chatSuggestion).toBeVisible();

	const dismissSuggestion = suggestionCard(
		frame,
		"Catch up on project activity"
	);
	await dismissSuggestion.getByRole("button", { name: "Dismiss" }).click();
	await expect(dismissSuggestion).toHaveCount(0);
	await expect
		.poll(async () => (await callFor(page, "suggestions.feedback")).length)
		.toBe(2);
	expect(await callFor(page, "suggestions.feedback")).toContainEqual({
		input: { kind: "dismiss", suggestion_type: "summary" },
		method: "suggestions.feedback",
	});
	await screenshot(page, "approvals-suggestion-dismissed.png");
});
