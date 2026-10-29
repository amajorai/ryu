import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { BlueprintListApi } from "./harness/blueprint-list-regression.types.ts";
declare global {
	interface Window {
		__blueprintList: BlueprintListApi;
	}
}
test("Blueprint contextless initial listing refusal offers explicit read retry without enabling decisions; recovery reads only list and selected plan", async ({
	page,
}) => {
	await page.goto("/");
	await page.waitForSelector("body[data-harness-ready='1']");
	const appHtml = await readFile(
		path.join(
			tmpdir(),
			"ryu-blueprint-list-regression-blueprint-build/index.html"
		),
		"utf8"
	);
	await page.evaluate((input) => window.__blueprintList.mount(input), {
		appHtml,
		listFailures: 1,
	});
	await expect
		.poll(() => page.evaluate(() => window.__blueprintList.connected()))
		.toBe(true);
	const companion = page.frameLocator(
		'iframe[title="Blueprint list regression"]'
	);
	await expect(companion.getByRole("alert")).toContainText(
		"Initial plan listing was refused."
	);
	expect(await page.evaluate(() => window.__blueprintList.calls())).toEqual([
		{ method: "GET", path: "/plans", status: "refused" },
	]);
	await expect(
		companion.getByRole("button", { name: "Approve", exact: true })
	).toHaveCount(0);
	// The current production loadPlans catch only sets an alert and never enables
	// retry. Keep this strict recoverability oracle instead of simulating recovery
	// with a test-only remount or calling the production client directly.
	const retry = companion.getByRole("button", {
		name: /Retry loading plans?/u,
	});
	await expect(retry).toBeVisible();
	await retry.click();
	await expect(
		companion.getByText(
			"Confirmed revision 3: preserve rollback before import.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Approve", exact: true })
	).toBeEnabled();
	const ledger = await page.evaluate(() => window.__blueprintList.calls());
	expect(
		ledger.filter((call) => call.path === "/plans").map((call) => call.status)
	).toEqual(["refused", "accepted"]);
	expect(
		ledger.filter((call) => call.path === "/plans/plan-read-regression")
	).toHaveLength(1);
	expect(
		ledger.filter(
			(call) => call.path === "/plans/plan-read-regression/revisions"
		)
	).toHaveLength(1);
	expect(
		ledger.every((call) => call.method === "GET" && call.body === undefined)
	).toBe(true);
});
