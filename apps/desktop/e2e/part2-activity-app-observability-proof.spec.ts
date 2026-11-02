// Continues activity-app-observability-proof.spec.ts (split under the file token limit); helpers live in activity-app-observability-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	callsFor,
	evidencePath,
	openObservability,
	RUN_ID,
} from "./activity-app-observability-proof.helpers.ts";

test.describe.configure({ timeout: 90_000 });

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
