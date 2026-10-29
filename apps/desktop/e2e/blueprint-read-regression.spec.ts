import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import type { BlueprintReadApi } from "./harness/blueprint-read-regression.types.ts";
declare global {
	interface Window {
		__blueprintRead: BlueprintReadApi;
	}
}
const planPath = "/plans/plan-read-regression";
async function mount(
	page: Page,
	failures: { detailFailures?: number; revisionFailures?: number }
): Promise<FrameLocator> {
	await page.goto("/");
	await page.waitForSelector("body[data-harness-ready='1']");
	const appHtml = await readFile(
		path.join(
			tmpdir(),
			"ryu-blueprint-read-regression-blueprint-build/index.html"
		),
		"utf8"
	);
	await page.evaluate((input) => window.__blueprintRead.mount(input), {
		appHtml,
		...failures,
	});
	await expect
		.poll(() => page.evaluate(() => window.__blueprintRead.connected()))
		.toBe(true);
	return page.frameLocator('iframe[title="Blueprint read regression"]');
}
async function calls(page: Page) {
	return await page.evaluate(() => window.__blueprintRead.calls());
}

test("Blueprint initial detail refusal retries only the exact selected plan reads and never enables decisions against an unread plan", async ({
	page,
}) => {
	const companion = await mount(page, { detailFailures: 2 });
	await expect(companion.getByRole("alert")).toContainText(
		"Selected plan detail read was refused."
	);
	await expect(
		companion.getByRole("button", { name: "Approve", exact: true })
	).toHaveCount(0);
	await expect(
		companion.getByRole("button", { name: "Request changes", exact: true })
	).toHaveCount(0);
	expect(
		(await calls(page)).filter((call) => call.path === planPath)
	).toHaveLength(1);
	await companion
		.getByRole("button", { name: "Retry loading plan", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await calls(page)).filter(
					(call) => call.path === planPath && call.status === "refused"
				).length
		)
		.toBe(2);
	await expect(companion.getByRole("alert")).toContainText(
		"Selected plan detail read was refused."
	);
	await companion
		.getByRole("button", { name: "Retry loading plan", exact: true })
		.click();
	await expect(
		companion.getByRole("heading", {
			name: "Recover reviewed plan reads",
			exact: true,
		})
	).toBeVisible();
	await expect(
		companion.getByText(
			"Confirmed revision 3: preserve rollback before import.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(companion.getByRole("alert")).toHaveCount(0);
	const captured = await calls(page);
	expect(
		captured.filter((call) => call.path === planPath).map((call) => call.status)
	).toEqual(["refused", "refused", "accepted"]);
	expect(
		captured.filter((call) => call.path === `${planPath}/revisions`)
	).toHaveLength(3);
	expect(
		captured.every((call) => call.method === "GET" && call.body === undefined)
	).toBe(true);
	await expect(
		companion.getByRole("button", { name: "Approve", exact: true })
	).toBeEnabled();
});

test("Blueprint incomplete initial revision read keeps decisions unavailable; held Retry reads the current persisted revision once", async ({
	page,
}) => {
	const companion = await mount(page, { revisionFailures: 1 });
	await expect(companion.getByRole("alert")).toContainText(
		"Selected plan revision list read was refused."
	);
	await expect(
		companion.getByRole("button", { name: "Approve", exact: true })
	).toHaveCount(0);
	await page.evaluate(() => {
		window.__blueprintRead.setPersistedRevision(4);
		window.__blueprintRead.holdNextDetail();
	});
	await companion
		.getByRole("button", { name: "Retry loading plan", exact: true })
		.click();
	try {
		await expect
			.poll(
				async () =>
					(await calls(page)).filter((call) => call.path === planPath).length
			)
			.toBe(2);
		const retry = companion.getByRole("button", {
			name: "Retry loading plan",
			exact: true,
		});
		await expect(retry).toBeDisabled();
		await retry.click({ force: true });
		expect(
			(await calls(page)).filter((call) => call.path === planPath)
		).toHaveLength(2);
		await expect(
			companion.getByText(
				"Confirmed revision 3: preserve rollback before import.",
				{ exact: true }
			)
		).toHaveCount(0);
		await expect(
			companion.getByRole("button", { name: "Approve", exact: true })
		).toHaveCount(0);
	} finally {
		await page.evaluate(() => window.__blueprintRead.releaseDetail());
	}
	await expect(companion.getByText("rev 4", { exact: true })).toBeVisible();
	await expect(
		companion.getByText(
			"Confirmed revision 4: preserve rollback before import.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Approve", exact: true })
	).toBeEnabled();
	await expect(companion.getByRole("alert")).toHaveCount(0);
	const captured = await calls(page);
	expect(captured.filter((call) => call.path === planPath)).toHaveLength(2);
	expect(
		captured.filter((call) => call.path === `${planPath}/revisions`)
	).toHaveLength(2);
	expect(
		captured.every((call) => call.method === "GET" && call.body === undefined)
	).toBe(true);
});
