import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type { RyuBridge } from "../../../apps-store/activity/ui/src/ryu.d.ts";

type ActivityProofPayload =
	| Parameters<RyuBridge["activity"][keyof RyuBridge["activity"]]>[0]
	| Parameters<RyuBridge["shell"]["openTab"]>[0];

type ActivityProofOperation =
	| "audit"
	| "eval"
	| "importTrace"
	| "list"
	| "openTab"
	| "prune"
	| "redteam"
	| "score"
	| "trace";

interface ActivityProofCall {
	operation: ActivityProofOperation;
	payload?: ActivityProofPayload;
}

declare global {
	interface Window {
		__activityProof: {
			calls: () => ActivityProofCall[];
			failNext: (operation: ActivityProofOperation) => void;
		};
	}
}

const FIXED_NOW = new Date("2026-09-26T12:00:00.000Z");
const AGENT_ID = "observability-proof-agent";
const RUN_ID = "run-proof-success";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function evidencePath(name: string): string {
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

async function openActivity(page: Page, query = ""): Promise<void> {
	await page.clock.setFixedTime(FIXED_NOW);
	await page.goto(`/activity-app-observability-proof.html${query}`);
	await expect(page.getByTestId("activity-proof-status")).toHaveText(
		"Activity Companion mounted"
	);
}

async function selectObservability(page: Page): Promise<void> {
	await page.getByRole("tab", { name: "Observability" }).click();
	await expect(
		page.getByRole("heading", { exact: true, name: "Agent observability" })
	).toBeVisible();
	await expect(page.getByText("Live · 15s", { exact: true })).toBeVisible();
	await expect(
		page.getByTestId("observability-event-audit-proof-success")
	).toBeVisible();
}

async function openObservability(page: Page): Promise<void> {
	await openActivity(page);
	await selectObservability(page);
}

async function proofCalls(page: Page): Promise<ActivityProofCall[]> {
	return page.evaluate(() => window.__activityProof.calls());
}

async function callsFor(
	page: Page,
	operation: ActivityProofOperation
): Promise<ActivityProofCall[]> {
	return (await proofCalls(page)).filter(
		(call) => call.operation === operation
	);
}

async function waitForCallCount(
	page: Page,
	operation: ActivityProofOperation,
	count: number
): Promise<void> {
	await expect
		.poll(async () => (await callsFor(page, operation)).length)
		.toBe(count);
}

async function expectAuditWindow(
	page: Page,
	index: number,
	window: "1h" | "24h" | "7d" | "all"
): Promise<void> {
	await waitForCallCount(page, "audit", index + 1);
	const call = (await callsFor(page, "audit"))[index];
	expect(call).toBeDefined();
	const payload = z
		.object({ from: z.string().optional(), limit: z.number().optional() })
		.optional()
		.parse(call?.payload);
	expect(payload?.limit).toBe(100);
	if (window === "all") {
		expect(payload?.from).toBeUndefined();
		return;
	}
	const duration = { "1h": HOUR, "24h": DAY, "7d": 7 * DAY }[window];
	expect(payload?.from).toBe(
		new Date(FIXED_NOW.getTime() - duration).toISOString()
	);
}

const agentCallSchema = z.object({
	agent_id: z.string(),
	model: z.string().optional(),
});
function record(value: ActivityProofPayload) {
	return agentCallSchema.parse(value);
}

test.describe.configure({ timeout: 90_000 });

test("Activity feed fetches a bounded page and opens only the selected run", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(`${message.text()} (${message.location().url})`);
		}
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));

	await openActivity(page);
	await page.getByRole("tab", { name: "Observability" }).click();
	await expect(
		page.getByRole("heading", { exact: true, name: "Agent observability" })
	).toBeVisible();
	await page.getByRole("tab", { name: "Activity" }).click();
	await expect(
		page.getByRole("heading", { exact: true, name: "Activity" })
	).toBeVisible();
	await expect(page.getByText("Agent run completed")).toBeVisible();
	await expect(page.getByText("Monitor heartbeat recovered")).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Agent run completed/ })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Monitor heartbeat recovered/ })
	).toHaveCount(0);
	await page.screenshot({
		fullPage: true,
		path: evidencePath("activity-feed-row-navigation"),
	});
	expect(await callsFor(page, "list")).toEqual([
		{ operation: "list", payload: { limit: 100 } },
	]);

	await page.getByRole("button", { name: /Agent run completed/ }).click();
	await expect(page.locator("body")).toHaveAttribute("data-opened-run", RUN_ID);
	expect(await callsFor(page, "openTab")).toEqual([
		{
			operation: "openTab",
			payload: { path: "/chat", conversationId: RUN_ID, title: "Chat" },
		},
	]);
	expect(browserErrors).toEqual([]);
});

test("Activity feed retries a failed list through the real pull gesture", async ({
	page,
}) => {
	await openActivity(page, "?failListOnce=1");
	await expect(
		page.getByText("Couldn't load activity", { exact: true })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: evidencePath("activity-feed-list-error"),
	});
	expect(await callsFor(page, "list")).toEqual([
		{ operation: "list", payload: { limit: 100 } },
	]);

	const pullArea = page.getByLabel("Pull to refresh");
	const bounds = await pullArea.boundingBox();
	expect(
		bounds,
		"the Activity feed has a scrollable refresh surface"
	).not.toBeNull();
	if (!bounds) {
		throw new Error("The pull-to-refresh surface has no browser bounds.");
	}
	const x = bounds.x + bounds.width / 2;
	const startY = bounds.y + Math.min(40, bounds.height / 4);
	await page.mouse.move(x, startY);
	await page.mouse.down();
	await page.mouse.move(x, startY + 170, { steps: 6 });
	await expect(
		page.getByText("Release to refresh", { exact: true })
	).toBeVisible();
	await page.mouse.up();
	await expect(page.getByText("Agent run completed")).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: evidencePath("activity-feed-refresh-recovered"),
	});
	await expect.poll(async () => (await callsFor(page, "list")).length).toBe(2);
	expect(await callsFor(page, "list")).toEqual([
		{ operation: "list", payload: { limit: 100 } },
		{ operation: "list", payload: { limit: 100 } },
	]);
});

test("Observability sends exact window queries and filters the model, error, and tool rows", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await openObservability(page);
	await expectAuditWindow(page, 0, "24h");
	await expect(
		page.locator('[data-testid^="observability-event-"]')
	).toHaveCount(3);
	await expect(
		page.getByTestId("observability-event-audit-proof-tool")
	).toContainText("search_docs");

	const filter = page.getByLabel("Observability filter");
	const windowSelect = page.getByLabel("Observability window");
	await windowSelect.selectOption("7d");
	await expectAuditWindow(page, 1, "7d");
	await windowSelect.selectOption("1h");
	await expectAuditWindow(page, 2, "1h");
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toHaveCount(0);
	await windowSelect.selectOption("all");
	await expectAuditWindow(page, 3, "all");
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();

	const auditCallCount = (await callsFor(page, "audit")).length;
	await filter.selectOption("tool");
	await expect(
		page.getByTestId("observability-event-audit-proof-tool")
	).toBeVisible();
	await expect(
		page.getByTestId("observability-event-audit-proof-success")
	).toHaveCount(0);
	await filter.selectOption("errors");
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();
	await expect(
		page.getByTestId("observability-event-audit-proof-tool")
	).toHaveCount(0);
	await filter.selectOption("slow");
	await expect(
		page.getByTestId("observability-event-audit-proof-tool")
	).toBeVisible();
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();
	await filter.selectOption("model");
	await expect(
		page.getByTestId("observability-event-audit-proof-success")
	).toBeVisible();
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();
	await expect
		.poll(async () => (await callsFor(page, "audit")).length)
		.toBe(auditCallCount);

	await filter.selectOption("all");
	const search = page.getByLabel("Search observability");
	await search.fill("req-proof-error");
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();
	await expect(
		page.getByTestId("observability-event-audit-proof-success")
	).toHaveCount(0);
	const regex = page.getByRole("switch", {
		name: "Regex observability search",
	});
	await regex.click();
	await search.fill("req-proof-(success|error)");
	await expect(
		page.getByTestId("observability-event-audit-proof-success")
	).toBeVisible();
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();
	await expect(
		page.getByTestId("observability-event-audit-proof-tool")
	).toHaveCount(0);
	await search.fill("[");
	await expect(
		page.getByText("No events match this view.", { exact: true })
	).toBeVisible();
	await search.fill("");
	await regex.click();
	expect(browserErrors).toEqual([]);
});

test("saved Observability views apply and persist their filter, query, and window", async ({
	page,
}) => {
	await openObservability(page);
	await page.getByLabel("Observability window").selectOption("7d");
	await expectAuditWindow(page, 1, "7d");
	await page.getByLabel("Observability filter").selectOption("errors");
	await page.getByLabel("Search observability").fill("provider timeout");
	await page
		.getByLabel("Saved observability view name")
		.fill("Provider timeouts");
	await page.getByRole("button", { name: "Save current view" }).click();
	await expect(
		page.getByRole("button", { name: "Provider timeouts", exact: true })
	).toBeVisible();
	const savedViews = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("ryu-activity-observability-views") ?? "[]")
	);
	expect(savedViews).toMatchObject([
		{
			filter: "errors",
			name: "Provider timeouts",
			query: "provider timeout",
			timeRange: "7d",
		},
	]);

	await page.getByLabel("Observability filter").selectOption("tool");
	await page.getByLabel("Observability window").selectOption("1h");
	await page.getByLabel("Search observability").fill("search_docs");
	await page
		.getByRole("button", { name: "Provider timeouts", exact: true })
		.click();
	await expect(page.getByLabel("Observability filter")).toHaveValue("errors");
	await expect(page.getByLabel("Observability window")).toHaveValue("7d");
	await expect(page.getByLabel("Search observability")).toHaveValue(
		"provider timeout"
	);
	await expectAuditWindow(page, 3, "7d");
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: evidencePath("activity-observability-saved-view-persisted"),
	});

	await page.reload();
	await expect(page.getByTestId("activity-proof-status")).toHaveText(
		"Activity Companion mounted"
	);
	await page.getByRole("tab", { name: "Observability" }).click();
	await expect(
		page.getByRole("button", { name: "Provider timeouts", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Provider timeouts", exact: true })
		.click();
	await expect(page.getByLabel("Observability filter")).toHaveValue("errors");
	await expect(page.getByLabel("Search observability")).toHaveValue(
		"provider timeout"
	);
	await page
		.getByRole("button", { name: "Remove saved view Provider timeouts" })
		.click();
	await expect(
		page.getByRole("button", { name: "Provider timeouts", exact: true })
	).toHaveCount(0);
	await expect
		.poll(async () =>
			page.evaluate(() =>
				JSON.parse(
					localStorage.getItem("ryu-activity-observability-views") ?? "[]"
				)
			)
		)
		.toEqual([]);
	await page.reload();
	await page.getByRole("tab", { name: "Observability" }).click();
	await expect(
		page.getByRole("button", { name: "Provider timeouts", exact: true })
	).toHaveCount(0);
});

test("selected evidence traces, imports, opens, scores, evaluates, and checks security with exact bridge payloads", async ({
	page,
}) => {
	await openObservability(page);
	await page.getByTestId("observability-event-audit-proof-success").click();
	await expect(page.getByText("Core run spans", { exact: true })).toBeVisible();
	await expect(
		page.getByText("search_docs", { exact: true }).last()
	).toBeVisible();
	expect(await callsFor(page, "trace")).toEqual([
		{ operation: "trace", payload: { run_id: RUN_ID } },
	]);

	await page.getByRole("button", { name: "Add to Quality tests" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Added to Agent regression suite"
	);
	expect(await callsFor(page, "importTrace")).toEqual([
		{
			operation: "importTrace",
			payload: { agent_id: AGENT_ID, run_id: RUN_ID },
		},
	]);

	await page.getByRole("button", { name: "Open conversation" }).click();
	await expect(page.locator("body")).toHaveAttribute("data-opened-run", RUN_ID);
	expect(await callsFor(page, "openTab")).toEqual([
		{
			operation: "openTab",
			payload: { path: "/chat", conversationId: RUN_ID, title: "Chat" },
		},
	]);

	await page.getByLabel("Completed output to score").fill("A grounded answer.");
	await page
		.getByLabel("Online scoring rubric")
		.fill("The answer is grounded.");
	await page.getByRole("button", { name: "Score output" }).click();
	await expect(
		page.getByText("Online score 91%", { exact: true })
	).toBeVisible();
	expect(await callsFor(page, "score")).toEqual([
		{
			operation: "score",
			payload: {
				agent_id: AGENT_ID,
				assertions: [{ kind: "llm_rubric", rubric: "The answer is grounded." }],
				model: "gpt-4o-mini",
				prompt: "gpt-4o-mini",
				response: "A grounded answer.",
			},
		},
	]);

	await page.getByRole("button", { name: "Run quality eval" }).click();
	await expect(page.getByText("Overall 88%", { exact: false })).toBeVisible();
	const evalCall = (await callsFor(page, "eval"))[0];
	expect(record(evalCall?.payload).agent_id).toBe(AGENT_ID);
	expect(record(evalCall?.payload).model).toBeUndefined();

	await page.getByRole("button", { name: "Run security checks" }).click();
	await expect(page.getByText("5/5 protected", { exact: false })).toBeVisible();
	const securityCall = (await callsFor(page, "redteam"))[0];
	expect(record(securityCall?.payload).agent_id).toBe(AGENT_ID);
	expect(record(securityCall?.payload).model).toBeUndefined();
	await page.screenshot({
		fullPage: true,
		path: evidencePath("activity-observability-evaluate-complete"),
	});
	await page.setViewportSize({ height: 900, width: 480 });
	expect(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth
		)
	).toBe(false);
	await page.screenshot({
		fullPage: true,
		path: evidencePath("activity-observability-narrow"),
	});
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	await page.screenshot({
		fullPage: true,
		path: evidencePath("activity-observability-dark"),
	});
});

test("quality and security checks require and accept a manually entered agent id", async ({
	page,
}) => {
	await openObservability(page);
	await page.getByRole("button", { name: "Run quality eval" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Enter an agent id or select an agent event first."
	);
	expect(await callsFor(page, "eval")).toHaveLength(0);

	await page.getByLabel("Agent id").fill("manual-agent-proof");
	await page.getByRole("button", { name: "Run quality eval" }).click();
	await expect(page.getByText("Overall 88%", { exact: false })).toBeVisible();
	const evalCall = (await callsFor(page, "eval"))[0];
	expect(record(evalCall?.payload).agent_id).toBe("manual-agent-proof");
	expect(record(evalCall?.payload).model).toBeUndefined();

	await page.getByRole("button", { name: "Run security checks" }).click();
	await expect(page.getByText("5/5 protected", { exact: false })).toBeVisible();
	const securityCall = (await callsFor(page, "redteam"))[0];
	expect(record(securityCall?.payload).agent_id).toBe("manual-agent-proof");
	expect(record(securityCall?.payload).model).toBeUndefined();
});

test("bridge failures show recovery and preserve state for refresh, prune, import, score, eval, and security", async ({
	page,
}) => {
	await openObservability(page);

	await page.evaluate(() => window.__activityProof.failNext("audit"));
	await page.getByRole("button", { name: "Refresh observability" }).click();
	await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
	await expectAuditWindow(page, 1, "24h");
	await page.getByRole("button", { name: "Refresh observability" }).click();
	await expect(page.getByText("Live · 15s", { exact: true })).toBeVisible();
	await expectAuditWindow(page, 2, "24h");

	await page.evaluate(() => window.__activityProof.failNext("prune"));
	await page.getByRole("button", { name: "Prune local audit" }).click();
	await expect(page.getByRole("status")).toContainText(
		"prune failed for proof"
	);
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();
	await page.getByRole("button", { name: "Prune local audit" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Retention applied · 1 rows removed"
	);
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toHaveCount(0);
	expect(await callsFor(page, "prune")).toEqual([
		{ operation: "prune", payload: undefined },
		{ operation: "prune", payload: undefined },
	]);
	await expectAuditWindow(page, 3, "24h");

	await page.getByTestId("observability-event-audit-proof-success").click();
	await expect(page.getByText("Core run spans", { exact: true })).toBeVisible();
	await page.evaluate(() => window.__activityProof.failNext("importTrace"));
	await page.getByRole("button", { name: "Add to Quality tests" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "importTrace failed for proof" })
	).toBeVisible();
	await page.getByRole("button", { name: "Add to Quality tests" }).click();
	await expect(
		page.getByRole("status").filter({
			hasText: "Added to Agent regression suite",
		})
	).toBeVisible();
	expect(await callsFor(page, "importTrace")).toEqual([
		{
			operation: "importTrace",
			payload: { agent_id: AGENT_ID, run_id: RUN_ID },
		},
		{
			operation: "importTrace",
			payload: { agent_id: AGENT_ID, run_id: RUN_ID },
		},
	]);

	await page.getByLabel("Completed output to score").fill("retryable output");
	await page.evaluate(() => window.__activityProof.failNext("score"));
	await page.getByRole("button", { name: "Score output" }).click();
	await expect(page.getByRole("alert")).toContainText("score failed for proof");
	await page.getByRole("button", { name: "Score output" }).click();
	await expect(
		page.getByText("Online score 91%", { exact: true })
	).toBeVisible();
	expect(await callsFor(page, "score")).toHaveLength(2);

	await page.evaluate(() => window.__activityProof.failNext("eval"));
	await page.getByRole("button", { name: "Run quality eval" }).click();
	await expect(page.getByRole("alert")).toContainText("eval failed for proof");
	await page.getByRole("button", { name: "Run quality eval" }).click();
	await expect(page.getByText("Overall 88%", { exact: false })).toBeVisible();
	expect(await callsFor(page, "eval")).toHaveLength(2);

	await page.evaluate(() => window.__activityProof.failNext("redteam"));
	await page.getByRole("button", { name: "Run security checks" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"redteam failed for proof"
	);
	await page.getByRole("button", { name: "Run security checks" }).click();
	await expect(page.getByText("5/5 protected", { exact: false })).toBeVisible();
	expect(await callsFor(page, "redteam")).toHaveLength(2);
});

test("a selected run shows a retryable error when its Core trace read fails", async ({
	page,
}) => {
	await openObservability(page);
	await page.evaluate(() => window.__activityProof.failNext("trace"));
	await page.getByTestId("observability-event-audit-proof-success").click();
	await expect(page.getByRole("alert")).toContainText("trace failed for proof");
	await expect(page.getByRole("button", { name: "Retry trace" })).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: evidencePath("activity-observability-trace-read-error"),
	});
	expect(await callsFor(page, "trace")).toEqual([
		{ operation: "trace", payload: { run_id: RUN_ID } },
	]);
	await page.getByRole("button", { name: "Retry trace" }).click();
	await expect(
		page.getByText("search_docs", { exact: true }).last()
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: evidencePath("activity-observability-trace-retried"),
	});
	expect(await callsFor(page, "trace")).toEqual([
		{ operation: "trace", payload: { run_id: RUN_ID } },
		{ operation: "trace", payload: { run_id: RUN_ID } },
	]);
});
