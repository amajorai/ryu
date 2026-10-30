import { expect, test } from "@playwright/test";
import {
	AGENT_ID,
	expectKnownFixtureRequests,
	openProof,
	readProof,
	requestsFor,
} from "./agent-observability-proof.fixture.ts";

test("prune reports failure, retries the exact POST, and persists the empty audit readback", async ({
	page,
}) => {
	await openProof(page);
	let state = await readProof(page);
	expect(state.auditEntries).toHaveLength(3);
	await page.evaluate(() =>
		window.__AGENT_OBSERVABILITY_PROOF__.failNext("prune")
	);
	const prune = page.getByRole("button", {
		name: "Prune local audit",
		exact: true,
	});
	await prune.click();
	await expect(page.getByRole("alert")).toContainText(
		"The retention pass failed."
	);
	await expect(page.getByText("/api/gateway/audit/prune failed")).toHaveCount(
		0
	);
	state = await readProof(page);
	expect(state.auditEntries).toHaveLength(3);
	expect(state.prunedRows).toBe(0);
	expect(
		requestsFor(state, "POST", "/api/gateway/audit/prune").map(
			(request) => request.status
		)
	).toEqual([503]);

	await prune.click();
	await expect(page.getByRole("status")).toHaveText(
		"Retention applied · 3 rows removed"
	);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByText("No events match this view.")).toBeVisible();
	state = await readProof(page);
	expect(state.auditEntries).toEqual([]);
	expect(state.prunedRows).toBe(3);
	expect(
		requestsFor(state, "POST", "/api/gateway/audit/prune").map(
			({ body, status }) => ({ body, status })
		)
	).toEqual([
		{ body: null, status: 503 },
		{ body: null, status: 200 },
	]);
	const finalRead = requestsFor(state, "GET", "/api/gateway/audit").at(-1);
	expect(finalRead).toMatchObject({
		query: { agent_id: AGENT_ID, limit: "100" },
		status: 200,
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: test.info().outputPath("agent-observability-pruned-empty.png"),
	});
	await page.reload();
	await expect(page.getByTestId("observability-summary")).toContainText(
		"Requests0"
	);
	const reloaded = await readProof(page);
	expect(reloaded.auditEntries).toEqual([]);
	expectKnownFixtureRequests(reloaded);
});

test("Quality handoff creates one local suite, retries trace import, and opens the exact conversation", async ({
	page,
}) => {
	await openProof(page);
	await page.getByTestId("observability-event-audit-proof-success").click();
	await expect(page.getByTestId("observability-trace")).toContainText(
		"search_docs"
	);
	await page.evaluate(() =>
		window.__AGENT_OBSERVABILITY_PROOF__.failNext("traceImport")
	);
	const addToQuality = page.getByRole("button", {
		name: "Add to Quality tests",
		exact: true,
	});
	await addToQuality.click();
	await expect(page.getByRole("alert")).toContainText(
		"Could not add this trace to Quality tests."
	);
	let state = await readProof(page);
	expect(state.suites).toHaveLength(1);
	const suiteLists = requestsFor(state, "GET", "/api/prompt-suites");
	expect(suiteLists.at(-1)?.query).toEqual({ agent_id: AGENT_ID });
	expect(requestsFor(state, "POST", "/api/prompt-suites")).toEqual([
		{
			body: {
				agent_id: AGENT_ID,
				config: {
					prompts: [],
					providers: ["openai/gpt-4o-mini"],
					tests: [],
				},
				label: "Trace baseline",
				name: "Agent regression suite",
			},
			method: "POST",
			path: "/api/prompt-suites",
			query: {},
			status: 200,
		},
	]);
	const importPath = "/api/prompt-suites/suite-observability-proof/traces";
	expect(
		requestsFor(state, "POST", importPath).map(({ body, status }) => ({
			body,
			status,
		}))
	).toEqual([{ body: { run_id: "run-proof-success" }, status: 503 }]);

	await addToQuality.click();
	await expect(page.getByRole("status")).toContainText(
		"Added to Agent regression suite as a versioned test case."
	);
	state = await readProof(page);
	expect(requestsFor(state, "POST", "/api/prompt-suites")).toHaveLength(1);
	expect(
		requestsFor(state, "POST", importPath).map(({ body, status }) => ({
			body,
			status,
		}))
	).toEqual([
		{ body: { run_id: "run-proof-success" }, status: 503 },
		{ body: { run_id: "run-proof-success" }, status: 200 },
	]);
	await addToQuality.click();
	await expect(page.getByRole("status")).toContainText(
		"This trace is already in Agent regression suite."
	);
	state = await readProof(page);
	expect(state.importedRunIds).toEqual(["run-proof-success"]);
	expect(
		requestsFor(state, "POST", importPath).map((request) => request.status)
	).toEqual([503, 200, 200]);
	expectKnownFixtureRequests(state);

	await page
		.getByRole("button", { name: "Open conversation", exact: true })
		.click();
	await expect(page.locator("body")).toHaveAttribute(
		"data-opened-run",
		"run-proof-success"
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: test
			.info()
			.outputPath("agent-observability-quality-retry-open-run.png"),
	});
});

test("scoring and security failures can be retried with the same exact local request bodies", async ({
	page,
}) => {
	await openProof(page);
	await page.getByTestId("observability-event-audit-proof-success").click();
	const score = page.getByRole("button", { name: "Score output", exact: true });
	await expect(score).toBeDisabled();
	await page.getByLabel("Completed output to score").fill("   ");
	await expect(score).toBeDisabled();
	await page
		.getByLabel("Completed output to score")
		.fill("  A grounded answer.  ");
	await page
		.getByLabel("Online scoring rubric")
		.fill("  The answer is grounded.  ");
	await expect(score).toBeEnabled();
	await page.evaluate(() =>
		window.__AGENT_OBSERVABILITY_PROOF__.failNext("score")
	);
	await score.click();
	await expect(page.getByRole("alert")).toContainText("Scoring failed.");
	await score.click();
	await expect(
		page.getByText("Online score 91%", { exact: true })
	).toBeVisible();
	let state = await readProof(page);
	const expectedScoreBody = {
		agent_id: AGENT_ID,
		assertions: [{ kind: "llm_rubric", rubric: "The answer is grounded." }],
		model: "openai/gpt-4o-mini",
		prompt: "req-proof-success",
		response: "  A grounded answer.  ",
	};
	expect(
		requestsFor(state, "POST", "/api/gateway/evals/score").map(
			({ body, status }) => ({ body, status })
		)
	).toEqual([
		{ body: expectedScoreBody, status: 503 },
		{ body: expectedScoreBody, status: 200 },
	]);

	await page.evaluate(() =>
		window.__AGENT_OBSERVABILITY_PROOF__.failNext("redteam")
	);
	const securityButton = page.getByTestId("observability-security-run");
	await securityButton.click();
	await expect(page.getByRole("alert")).toContainText(
		"The security checks could not run."
	);
	await securityButton.click();
	await expect(page.getByTestId("observability-security-result")).toContainText(
		"5/5 protected"
	);
	state = await readProof(page);
	expect(
		requestsFor(state, "POST", "/api/gateway/redteam/run").map(
			({ body, status }) => ({ body, status })
		)
	).toEqual([
		{ body: { agent_id: AGENT_ID, model: "gpt-4o-mini" }, status: 503 },
		{ body: { agent_id: AGENT_ID, model: "gpt-4o-mini" }, status: 200 },
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: test
			.info()
			.outputPath("agent-observability-score-redteam-retried.png"),
	});
	expectKnownFixtureRequests(state);
});
