import { expect, test } from "@playwright/test";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";
import { parseProofJson, parseProofJsonRecord } from "./fixture-json.ts";
import {
	armFailure,
	downloadedText,
	evidence,
	readProof,
} from "./prompt-studio-proof-helpers.ts";

test("Prompt Studio reports eval failures, retries with exact run options, saves durable results, and aborts on Stop", async ({
	page,
}) => {
	await page.goto("/prompt-studio-proof.html?reset=true");
	await page.getByLabel("Suite name").fill("Run proof suite");
	await page.getByRole("button", { name: "Save suite" }).click();
	await expect(page.getByText("1 versions")).toBeVisible();
	await page.getByRole("button", { name: "Add test case" }).click();
	await page.getByLabel("User message").first().fill("Explain {{topic}}");
	await page.getByLabel("Concurrency").fill("5");
	await page.getByLabel("Timeout (ms)").fill("8000");
	await page.getByLabel("Repeat cases").fill("4");
	await page.getByRole("switch", { name: "Cache outputs" }).click();
	await page
		.getByLabel("Run tags (key=value, comma-separated)")
		.fill("job=coverage");
	await page.getByLabel("Prompt prefix").fill("prefix:");
	await page.getByLabel("Prompt suffix").fill(":suffix");
	await armFailure(page, "eval-run");
	await page.getByRole("button", { name: "Run test cases" }).click();
	await expect(
		page.getByText("/api/gateway/evals/run failed: 503")
	).toBeVisible();
	expect((await readProof(page)).runs).toHaveLength(0);
	await page.getByRole("button", { name: "Run test cases" }).click();
	await expect(page.getByText("Results matrix")).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Run proof suite ·/ }).first()
	).toBeVisible();
	let snapshot = await readProof(page);
	const evalRequest = snapshot.requests.find(
		(request) =>
			request.path === "/api/gateway/evals/run" && request.method === "POST"
	);
	expect(evalRequest?.body).toMatchObject({
		agent_id: "prompt-studio-proof-agent",
		model: "gpt-4o-mini",
		max_concurrency: 5,
		timeout_ms: 8000,
		repeat: 4,
		cache: false,
		tags: { job: "coverage" },
		prefix: "prefix:",
		suffix: ":suffix",
		prompt_id: "primary",
		dataset: [expect.objectContaining({ prompt: "Explain {{topic}}" })],
	});
	expect(snapshot.runs).toHaveLength(1);
	expect(snapshot.runs[0]).toMatchObject({
		request: {
			run_config: {
				cache: false,
				max_concurrency: 5,
				repeat: 4,
				tags: { job: "coverage" },
				timeout_ms: 8000,
			},
		},
		result: { variants: [expect.objectContaining({ promptId: "primary" })] },
	});
	await page.reload();
	await expect(page.getByLabel("Suite name")).toHaveValue("Run proof suite");
	await expect(page.getByText("1 versions")).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Run proof suite ·/ }).first()
	).toBeVisible();
	await page
		.getByRole("button", { name: /Run proof suite ·/ })
		.first()
		.click();
	await expect(page.getByText("Results matrix")).toBeVisible();
	snapshot = await readProof(page);
	const savedRunId = snapshot.runs[0]?.id;
	expect(savedRunId).toBe("pr_prompt_studio_proof-1");
	expect(snapshot.requests).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				path: "/api/prompt-suites/ps_prompt_studio_proof/runs/pr_prompt_studio_proof-1",
				method: "GET",
			}),
			expect.objectContaining({
				path: "/api/prompt-suites/ps_prompt_studio_proof/runs/pr_prompt_studio_proof-1/reviews",
				method: "GET",
			}),
		])
	);
	await expect
		.poll(async () => page.evaluate(() => window.location.hash))
		.toContain(`run_id=${savedRunId}`);
	await page.reload();
	await expect(page.getByText("Results matrix")).toBeVisible();
	snapshot = await readProof(page);
	expect(snapshot.requests).toContainEqual({
		body: null,
		method: "GET",
		path: `/api/prompt-suites/ps_prompt_studio_proof/runs/${savedRunId}`,
	});
	expect(snapshot.requests).toContainEqual({
		body: null,
		method: "GET",
		path: `/api/prompt-suites/ps_prompt_studio_proof/runs/${savedRunId}/reviews`,
	});
	await page.evaluate(() => window.__promptStudioProof.holdNextEvalRun());
	await page.getByRole("button", { name: "Run test cases" }).click();
	await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
	await page.getByRole("button", { name: "Stop" }).click();
	await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
	await expect.poll(async () => (await readProof(page)).abortedRuns).toBe(1);
	await expect.poll(async () => (await readProof(page)).runs.length).toBe(1);
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-run-results.png"),
	});
});

test("Prompt Studio filters and exports result cells and maintains durable run history", async ({
	page,
}) => {
	await page.goto("/prompt-studio-proof.html?reset=true");
	const promptEditor = page
		.locator("#prompt-studio-editor [contenteditable='true']")
		.first();
	await expect(promptEditor).toContainText("Use {{topic}}.");
	await page.getByLabel("Suite name").fill("Matrix proof suite");
	await page.getByRole("button", { name: "Save suite" }).click();
	await expect(page.getByText("1 versions")).toBeVisible();
	await page.getByRole("button", { name: "Run test cases" }).click();
	await expect(page.getByText("Results matrix")).toBeVisible();
	await expect(page.getByText("4 visible cells")).toBeVisible();
	const unavailableModelCard = page
		.getByText("gpt-4.1-mini", { exact: true })
		.first()
		.locator("..");
	await expect(unavailableModelCard).toContainText("Policy");
	await expect(unavailableModelCard).toContainText("N/A");

	const jsonOutputCell = page.locator("tbody tr").nth(1).locator("td").nth(1);
	await jsonOutputCell.getByText("Inspect full cell").click();
	await expect(jsonOutputCell).toContainText("Latency score: N/A");
	await jsonOutputCell
		.getByLabel("Cell output render mode")
		.selectOption("json");
	await expect(jsonOutputCell.locator("pre").nth(1)).toHaveText(
		'{\n  "answer": "Prompt engineering is writing instructions for a model."\n}'
	);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await jsonOutputCell.getByRole("button", { name: "Copy" }).nth(0).click();
	await expect(page.getByText("Copied", { exact: true })).toBeVisible();
	await expect
		.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
		.toContain("Give a brief answer about prompt engineering");
	await jsonOutputCell.getByRole("button", { name: "Copy" }).nth(1).click();
	await expect(page.getByText("Copied", { exact: true })).toBeVisible();
	await expect
		.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(
			'{"answer":"Prompt engineering is writing instructions for a model."}'
		);
	await jsonOutputCell.getByText("Inspect full cell").click();
	const markdownOutputCell = page
		.locator("tbody tr")
		.nth(1)
		.locator("td")
		.nth(2);
	await markdownOutputCell.getByText("Inspect full cell").click();
	await markdownOutputCell
		.getByLabel("Cell output render mode")
		.selectOption("markdown");
	await expect(markdownOutputCell.locator("strong")).toHaveText("clear");
	await markdownOutputCell
		.getByLabel("Cell output render mode")
		.selectOption("text");
	await expect(markdownOutputCell.locator("strong")).toHaveCount(0);
	await expect(markdownOutputCell).toContainText("**clear**");
	await markdownOutputCell.getByText("Inspect full cell").click();

	await page.getByLabel("Search result matrix").fill("A concise explanation");
	await expect(page.getByText("1 visible cells")).toBeVisible();
	await page.getByLabel("Search result matrix").fill("");
	await page.getByLabel("Filter result metadata").fill("team=billing");
	await expect(page.getByText("2 visible cells")).toBeVisible();
	await page.getByLabel("Filter result metadata").fill("");
	await page.getByLabel("Search result matrix").fill("locale.{0,8}en");
	await page.getByRole("switch", { name: "Regex result search" }).click();
	await expect(page.getByText("2 visible cells")).toBeVisible();
	await page.getByLabel("Search result matrix").fill("");
	await page.getByRole("switch", { name: "Regex result search" }).click();
	const firstCell = page.locator("tbody tr").first().locator("td").nth(1);
	await firstCell.locator('[data-slot="tooltip-trigger"]').first().hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
		'found one of the values: "concise"'
	);
	await page.getByLabel("Result matrix filter").selectOption("pass");
	await expect(page.getByText("2 visible cells")).toBeVisible();
	await page.getByLabel("Result matrix filter").selectOption("error");
	await expect(page.getByText("0 visible cells")).toBeVisible();
	await page.getByLabel("Result matrix filter").selectOption("different");
	await expect(page.getByText("4 visible cells")).toBeVisible();
	await page.getByLabel("Result matrix filter").selectOption("fail");
	await expect(page.getByText("2 visible cells")).toBeVisible();
	await page.getByLabel("Results export format").selectOption("csv");
	const csvDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	const csv = await downloadedText(await csvDownload);
	expect(csv).toContain("latency_available,policy_available");
	expect(csv.trim().split(/\r?\n/u)).toHaveLength(3);

	await page.getByLabel("Result matrix filter").selectOption("all");
	await firstCell.getByRole("button", { name: "Highlight" }).click();
	await expect
		.poll(async () => Object.keys((await readProof(page)).reviews).length)
		.toBe(1);
	const failReviewCell = page.locator("tbody tr").first().locator("td").nth(2);
	await failReviewCell.getByRole("button", { name: "Fail" }).click();
	await expect
		.poll(async () => Object.keys((await readProof(page)).reviews).length)
		.toBe(2);
	const review = Object.values((await readProof(page)).reviews)[0];
	expect(review).toMatchObject({ highlighted: true, pass: true });
	expect(
		Object.values((await readProof(page)).reviews).find(
			(saved) => saved.result_key === "primary:gpt-4.1-mini:0"
		)
	).toMatchObject({ pass: false });
	await page.getByLabel("Result matrix filter").selectOption("highlighted");
	await expect(page.getByText("1 visible cells")).toBeVisible();
	await page.getByLabel("Results export format").selectOption("human_yaml");
	const reviewDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	const reviewYaml = await downloadedText(await reviewDownload);
	expect(reviewYaml).toContain("highlighted: true");
	expect(reviewYaml).toContain("pass: true");
	await page.getByLabel("Result matrix filter").selectOption("all");
	await page.getByLabel("Results export format").selectOption("json");
	const allJsonDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	const allJson = z
		.array(pluginDocumentSchema)
		.parse(parseProofJson(await downloadedText(await allJsonDownload)));
	expect(allJson).toHaveLength(4);
	await page.getByLabel("Results export format").selectOption("yaml");
	const allYamlDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	expect(
		z
			.array(pluginDocumentSchema)
			.parse(parseYaml(await downloadedText(await allYamlDownload)))
	).toHaveLength(4);
	await page.getByLabel("Results export format").selectOption("failed_json");
	const failedJsonDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	const failedRows = z
		.array(z.object({ score: z.object({ assertions_pass: z.boolean() }) }))
		.parse(parseProofJson(await downloadedText(await failedJsonDownload)));
	expect(failedRows).toHaveLength(2);
	expect(failedRows.every((row) => row.score.assertions_pass === false)).toBe(
		true
	);
	await page.getByLabel("Results export format").selectOption("dpo_jsonl");
	const dpoDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	const dpoRows = (await downloadedText(await dpoDownload))
		.trim()
		.split(/\r?\n/u)
		.map((line) => parseProofJsonRecord(line));
	expect(dpoRows).toHaveLength(2);
	expect(dpoRows[0]).toMatchObject({
		chosen_model: expect.any(String),
		rejected_model: expect.any(String),
	});
	await page.getByLabel("Results export format").selectOption("human_yaml");
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-results-matrix.png"),
	});

	let snapshot = await readProof(page);
	expect(snapshot.runs).toHaveLength(1);
	const originalRun = snapshot.runs[0];
	expect(originalRun).toBeDefined();
	const originalName = originalRun?.name ?? "";
	await page.getByRole("button", { name: `Duplicate ${originalName}` }).click();
	await expect.poll(async () => (await readProof(page)).runs.length).toBe(2);
	snapshot = await readProof(page);
	const duplicateRun = snapshot.runs.find((run) => run.id !== originalRun?.id);
	expect(duplicateRun?.name).toBe(`${originalName} copy`);
	const duplicateName = duplicateRun?.name ?? "";
	await page.getByRole("button", { name: duplicateName, exact: true }).click();
	await expect(page.getByText("Results matrix")).toBeVisible();
	await page
		.getByRole("button", { name: `Compare ${originalName}`, exact: true })
		.click();
	await expect(page.getByText("Run comparison")).toBeVisible();
	await expect(page.getByText(`vs ${originalRun?.id}`)).toBeVisible();
	await page.getByRole("button", { name: `Rename ${duplicateName}` }).click();
	await page
		.getByLabel(`Rename ${duplicateName}`)
		.fill("Renamed comparison run");
	await page
		.getByRole("button", { name: `Save name for ${duplicateName}` })
		.click();
	await expect
		.poll(
			async () =>
				(await readProof(page)).runs.find((run) => run.id === duplicateRun?.id)
					?.name
		)
		.toBe("Renamed comparison run");
	snapshot = await readProof(page);
	expect(snapshot.requests).toContainEqual({
		body: { name: "Renamed comparison run" },
		method: "PUT",
		path: `/api/prompt-suites/ps_prompt_studio_proof/runs/${duplicateRun?.id}`,
	});
	await page
		.getByRole("button", { name: "Delete Renamed comparison run" })
		.click();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(
		(await readProof(page)).requests.filter(
			(request) => request.method === "DELETE"
		)
	).toHaveLength(0);
	await page
		.getByRole("button", { name: "Delete Renamed comparison run" })
		.click();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect.poll(async () => (await readProof(page)).runs.length).toBe(1);
	await expect(
		page.getByRole("button", { name: "Renamed comparison run", exact: true })
	).toHaveCount(0);
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-run-history.png"),
	});
});
