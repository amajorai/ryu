import { expect, test } from "@playwright/test";
import {
	AGENT_ID,
	expectKnownFixtureRequests,
	expectWindowStart,
	openProof,
	PROOF_TIME,
	readProof,
	requestsFor,
} from "./agent-observability-proof.fixture.ts";
import { parseProofJson } from "./fixture-json.ts";

test("agent observability keeps the observe-to-trace workflow visible", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));

	await page.clock.install({ time: PROOF_TIME });
	await page.goto("/agent-observability-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await page.waitForLoadState("networkidle");
	await expect(page.getByTestId("proof-status")).toHaveText(
		"Production UI mounted"
	);
	await expect(page.getByText("Agent observability").first()).toBeVisible();
	await page.getByLabel("Observability window").selectOption("7d");
	await expect(page.getByTestId("observability-summary")).toContainText(
		"Last 7 days"
	);
	await expect(page.getByTestId("observability-summary")).toContainText(
		"Requests"
	);
	await expect(page.getByTestId("observability-summary")).toContainText("60%");
	await expect(page.getByTestId("observability-summary")).toContainText(
		"1 hit · 1 miss"
	);
	await expect(page.getByTestId("observability-summary")).toContainText(
		"Cache hits"
	);
	await expect(page.getByTestId("observability-summary")).toContainText("700");
	await expect(page.getByTestId("observability-summary")).toContainText(
		"Cache writes"
	);
	await expect(page.getByTestId("observability-summary")).toContainText("80");
	await expect(page.getByTestId("observability-summary")).toContainText(
		"Cache misses"
	);
	await expect(page.getByTestId("observability-summary")).toContainText(
		"41,220"
	);
	await expect(page.getByTestId("observability-events")).toContainText(
		"gpt-4o-mini"
	);
	await expect(
		page.getByTestId("prompt-cache-status-audit-proof-success")
	).toHaveText("Hit + write");
	await page.getByLabel("Observability filter").selectOption("errors");
	await expect(page.getByTestId("observability-events")).toContainText(
		"claude-3-5-sonnet"
	);
	await expect(
		page.getByTestId("prompt-cache-status-audit-proof-error")
	).toHaveText("Miss + write");
	await page.getByLabel("Observability filter").selectOption("all");
	await page.getByLabel("Observability window").selectOption("7d");
	await expect(page.getByTestId("observability-summary")).toContainText(
		"Last 7 days"
	);

	await page.getByTestId("observability-search").fill("gpt-4o-mini");
	await expect(page.getByTestId("observability-events")).toContainText(
		"gpt-4o-mini"
	);
	await expect(page.getByTestId("observability-events")).not.toContainText(
		"claude-3-5-sonnet"
	);
	await page.getByTestId("observability-event-audit-proof-success").click();
	await expect(page.getByTestId("observability-prompt-cache")).toContainText(
		"Hit + write"
	);
	await expect(page.getByTestId("observability-prompt-cache")).toContainText(
		"300 tokens"
	);
	await expect(page.getByTestId("observability-context-window")).toContainText(
		"128,000 tokens"
	);
	await expect(page.getByTestId("observability-context-window")).toContainText(
		"42,000 input · 33% of window"
	);
	await expect(page.getByTestId("observability-cache-usage")).toContainText(
		"Cache hits"
	);
	await expect(page.getByTestId("observability-cache-usage")).toContainText(
		"700"
	);
	await expect(page.getByTestId("observability-cache-usage")).toContainText(
		"Cache writes"
	);
	await expect(page.getByTestId("observability-cache-usage")).toContainText(
		"80"
	);
	await expect(page.getByTestId("observability-cache-usage")).toContainText(
		"Cache misses"
	);
	await expect(page.getByTestId("observability-cache-usage")).toContainText(
		"41,220"
	);
	await expect(page.getByTestId("observability-trace")).toContainText(
		"Core run spans"
	);
	await expect(page.getByTestId("observability-trace")).toContainText(
		"search_docs"
	);
	await page
		.getByLabel("Saved observability view name")
		.fill("Successful model calls");
	await page.getByRole("button", { name: "Save current view" }).click();
	await expect(
		page.getByRole("button", { exact: true, name: "Successful model calls" })
	).toBeVisible();
	await page.getByLabel("Completed output to score").fill("A grounded answer.");
	await page
		.getByLabel("Online scoring rubric")
		.fill("The answer is grounded.");
	await page.getByRole("button", { name: "Score output" }).click();
	await expect(page.getByText("Online score 91%")).toBeVisible();
	await page.getByRole("button", { name: "Add to Quality tests" }).click();
	await expect(page.getByText(/Added to Agent regression suite/)).toBeVisible();
	await page.getByRole("button", { name: "Open conversation" }).click();
	await expect(page.locator("body")).toHaveAttribute(
		"data-opened-run",
		"run-proof-success"
	);
	await page.getByTestId("observability-security-run").click();
	await expect(page.getByTestId("observability-security-result")).toContainText(
		"5/5 protected"
	);
	await expect(page.getByTestId("observability-security-result")).toContainText(
		"Prompt injection"
	);

	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("agent-observability.png"),
	});
	await page.setViewportSize({ width: 480, height: 900 });
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("agent-observability-proof-narrow.png"),
	});
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("agent-observability-proof-dark.png"),
	});

	expect(browserErrors).toEqual([]);
	await page.getByRole("button", { name: "Prune local audit" }).click();
	await expect(
		page.getByText("Retention applied · 3 rows removed")
	).toBeVisible();
	await expect(page.getByText("No events match this view.")).toBeVisible();
	const pruned = await readProof(page);
	expect(pruned.auditEntries).toEqual([]);
	expect(pruned.prunedRows).toBe(3);
	expect(requestsFor(pruned, "POST", "/api/gateway/audit/prune")).toEqual([
		{
			body: null,
			method: "POST",
			path: "/api/gateway/audit/prune",
			query: {},
			status: 200,
		},
	]);
	expectKnownFixtureRequests(pruned);
});

test("refresh retries the exact time-window query while search and event filters stay local", async ({
	page,
}) => {
	await openProof(page);
	let state = await readProof(page);
	const initialAudit = requestsFor(state, "GET", "/api/gateway/audit")[0];
	expect(initialAudit?.query).toMatchObject({
		agent_id: AGENT_ID,
		limit: "100",
	});
	expectWindowStart(initialAudit?.query.from, 24 * 60 * 60_000);
	expect(state.auditEntries.map((entry) => entry.id)).toEqual([
		"audit-proof-success",
		"audit-proof-error",
		"audit-proof-tool",
	]);
	await expect(
		page.getByTestId("observability-event-audit-proof-success")
	).toBeVisible();
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toHaveCount(0);

	await page.evaluate(() => {
		window.__AGENT_OBSERVABILITY_PROOF__.appendRefreshFixtureEntry();
		window.__AGENT_OBSERVABILITY_PROOF__.failNext("audit");
	});
	const refresh = page.getByRole("button", {
		name: "Refresh observability",
	});
	await refresh.click();
	await expect(
		page.getByText("Observability data could not be loaded.", { exact: true })
	).toBeVisible();
	await refresh.click();
	await expect(
		page.getByTestId("observability-event-audit-proof-refreshed")
	).toBeVisible();
	state = await readProof(page);
	const auditReads = requestsFor(state, "GET", "/api/gateway/audit");
	expect(auditReads.map((request) => request.status)).toEqual([200, 503, 200]);
	for (const request of auditReads.slice(1)) {
		expect(request.query).toMatchObject({ agent_id: AGENT_ID, limit: "100" });
		expectWindowStart(request.query.from, 24 * 60 * 60_000);
	}

	const requestsBeforeLocalFilters = auditReads.length;
	const search = page.getByLabel("Search observability");
	await search.fill("background-refresh");
	await expect(
		page.getByTestId("observability-event-audit-proof-refreshed")
	).toBeVisible();
	await expect(
		page.getByTestId("observability-event-audit-proof-success")
	).toHaveCount(0);
	await search.fill("");
	state = await readProof(page);
	expect(requestsFor(state, "GET", "/api/gateway/audit")).toHaveLength(
		requestsBeforeLocalFilters
	);
	await page.getByLabel("Observability window").selectOption("7d");
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();
	state = await readProof(page);
	const sevenDayRead = requestsFor(state, "GET", "/api/gateway/audit").at(-1);
	expect(sevenDayRead?.query).toMatchObject({
		agent_id: AGENT_ID,
		limit: "100",
	});
	expectWindowStart(sevenDayRead?.query.from, 7 * 24 * 60 * 60_000);
	const readsAfterWindowChange = requestsFor(
		state,
		"GET",
		"/api/gateway/audit"
	).length;
	await page.getByLabel("Observability filter").selectOption("errors");
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();
	state = await readProof(page);
	expect(requestsFor(state, "GET", "/api/gateway/audit")).toHaveLength(
		readsAfterWindowChange
	);

	await page.getByLabel("Observability filter").selectOption("model");
	await expect(
		page.getByTestId("observability-event-audit-proof-success")
	).toBeVisible();

	await page.getByLabel("Observability filter").selectOption("tool");
	await page.getByLabel("Observability window").selectOption("all");
	await expect(
		page.getByTestId("observability-event-audit-proof-tool")
	).toBeVisible();
	state = await readProof(page);
	const allTimeRead = requestsFor(state, "GET", "/api/gateway/audit").at(-1);
	expect(allTimeRead?.query).toEqual({ agent_id: AGENT_ID, limit: "100" });

	await page.getByLabel("Observability filter").selectOption("model");
	await page.getByTestId("observability-event-audit-proof-success").click();
	await expect(page.getByTestId("observability-trace")).toContainText(
		"search_docs"
	);
	await expect(page.getByTestId("observability-context-window")).toContainText(
		"128,000 tokens"
	);
	state = await readProof(page);
	expect(
		requestsFor(state, "GET", "/api/runs/run-proof-success/trace")
	).toEqual([
		{
			body: null,
			method: "GET",
			path: "/api/runs/run-proof-success/trace",
			query: {},
			status: 200,
		},
	]);
	expect(
		requestsFor(state, "GET", "/api/models/context-window").at(-1)
	).toMatchObject({
		method: "GET",
		query: { model: "openai/gpt-4o-mini" },
		status: 200,
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: test.info().outputPath("agent-observability-refresh-trace.png"),
	});
	expectKnownFixtureRequests(state);
});

test("saved views trim, persist, reapply, and delete the exact local query/filter/window", async ({
	page,
}) => {
	await openProof(page);
	await page.getByLabel("Observability filter").selectOption("errors");
	await page.getByLabel("Observability window").selectOption("7d");
	const search = page.getByLabel("Search observability");
	await search.fill("claude-3-5-sonnet");
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();

	const save = page.getByRole("button", {
		name: "Save current view",
		exact: true,
	});
	await expect(save).toBeDisabled();
	const name = page.getByLabel("Saved observability view name");
	await name.fill("   ");
	await expect(save).toBeDisabled();
	await name.fill("  Provider timeout / seven day  ");
	await save.click();
	const viewButton = page.getByRole("button", {
		name: "Provider timeout / seven day",
		exact: true,
	});
	await expect(viewButton).toBeVisible();
	const storedRaw = await page.evaluate(
		(key) => localStorage.getItem(key),
		`ryu-observability-views:${AGENT_ID}`
	);
	const stored = storedRaw ? parseProofJson(storedRaw) : null;
	expect(stored).toEqual([
		expect.objectContaining({
			filter: "errors",
			name: "Provider timeout / seven day",
			query: "claude-3-5-sonnet",
			timeRange: "7d",
		}),
	]);
	await page.reload();
	await expect(viewButton).toBeVisible();
	await expect(search).toHaveValue("");
	await expect(page.getByLabel("Observability filter")).toHaveValue("all");
	await expect(page.getByLabel("Observability window")).toHaveValue("24h");
	await viewButton.click();
	await expect(search).toHaveValue("claude-3-5-sonnet");
	await expect(page.getByLabel("Observability filter")).toHaveValue("errors");
	await expect(page.getByLabel("Observability window")).toHaveValue("7d");
	await expect(
		page.getByTestId("observability-event-audit-proof-error")
	).toBeVisible();
	const appliedViewState = await readProof(page);
	const appliedViewRead = requestsFor(
		appliedViewState,
		"GET",
		"/api/gateway/audit"
	).at(-1);
	expect(appliedViewRead?.query).toMatchObject({
		agent_id: AGENT_ID,
		limit: "100",
	});
	expectWindowStart(appliedViewRead?.query.from, 7 * 24 * 60 * 60_000);
	expectKnownFixtureRequests(appliedViewState);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: test.info().outputPath("agent-observability-saved-view-applied.png"),
	});

	await page
		.getByRole("button", {
			name: "Remove saved view Provider timeout / seven day",
			exact: true,
		})
		.click();
	await expect(viewButton).toHaveCount(0);
	expect(
		await page.evaluate(
			(key) => localStorage.getItem(key),
			`ryu-observability-views:${AGENT_ID}`
		)
	).toBe("[]");
	await page.reload();
	await expect(viewButton).toHaveCount(0);
	expectKnownFixtureRequests(await readProof(page));
});
