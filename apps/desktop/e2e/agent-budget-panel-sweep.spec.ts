import path from "node:path";
import { expect, test } from "@playwright/test";

import type { GatewayBudgetConfig } from "../src/lib/api/gateway.ts";

interface BudgetPanelSnapshot {
	budgets: GatewayBudgetConfig;
	requests: { body: unknown; method: string; path: string; status: number }[];
}

const AGENT_ID = "agent-budget-sweep-agent";

function evidencePath(name: string): string {
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

async function snapshot(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const proof =
			/* SAFETY: main.tsx installs __agentBudgetPanelSweep before this proof page is evaluated. */ (
				window as Window & {
					__agentBudgetPanelSweep: { snapshot: () => BudgetPanelSnapshot };
				}
			).__agentBudgetPanelSweep;
		return proof.snapshot();
	});
}

function writes(state: BudgetPanelSnapshot) {
	return state.requests.filter(
		(request) =>
			request.method === "PUT" && request.path === "/api/gateway/config"
	);
}

test.describe.configure({ timeout: 60_000 });
const pageErrors = new WeakMap<import("@playwright/test").Page, string[]>();

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await expect(page.locator("body")).toHaveAttribute("data-harness-ready", "1");
	await expect(
		page.getByText("This agent's Gateway budget", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("$2.50 spend cap · Notify", { exact: true })
	).toBeVisible();
});
test.afterEach(({ page }) => {
	expect(pageErrors.get(page) ?? []).toEqual([]);
});

test("saves exact agent rule while preserving other budget scopes and reads it back", async ({
	page,
}) => {
	const limit = page.getByRole("spinbutton", { name: "Spend cap (USD)" });
	await limit.fill("12.34");
	await page.getByRole("checkbox", { name: "Model calls" }).uncheck();
	await page.getByRole("checkbox", { name: "Paid tools" }).uncheck();
	await page.getByLabel("Action when spend cap is reached").click();
	await page.getByRole("option", { name: /^Restrict/ }).click();
	await page.getByRole("spinbutton", { name: "Max tokens cap" }).fill("512");

	await page.getByRole("button", { name: "Save budget" }).click();
	await expect(
		page.getByText("Budget updated. Changes take effect immediately.")
	).toBeVisible();
	await expect(
		page.getByText("$12.34 spend cap · Restrict", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Live spend: $0.40 / $12.34", { exact: true })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("option")).toHaveCount(0);

	const saved = await snapshot(page);
	const expectedRule = {
		action: "restrict",
		alert: "warn",
		include: { model: false, media: true, tools: false },
		limit: 12_340_000,
		restrict_max_tokens: 512,
	};
	expect(saved.budgets.agents[AGENT_ID]).toEqual(expectedRule);
	expect(saved.budgets.agents["agent-budget-sweep-keep"]).toEqual({
		action: "stop",
		alert: "warn",
		include: { model: true, media: true, tools: true },
		limit: 3_000_000,
	});
	expect(saved.budgets.users["user-budget-sweep-keep"]).toMatchObject({
		limit: 5_000_000,
	});
	expect(saved.budgets.session).toMatchObject({ limit: 4_000_000 });
	expect(writes(saved)).toHaveLength(1);
	expect(writes(saved)[0]?.body).toEqual({
		budgets: saved.budgets,
	});

	await page.screenshot({
		fullPage: true,
		path: evidencePath("agent-budget-panel-saved-readback"),
	});
	await page.getByRole("spinbutton", { name: "Spend cap (USD)" }).fill("-1");
	await page.getByRole("button", { name: "Save budget" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Spend cap must be a non-negative USD amount (up to 6 decimals)."
	);
	await expect(
		page.getByText("Budget updated. Changes take effect immediately.")
	).toHaveCount(0);
	expect(writes(await snapshot(page))).toHaveLength(1);
	await page.reload();
	await expect(
		page.getByText("$12.34 spend cap · Restrict", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("spinbutton", { name: "Spend cap (USD)" })
	).toHaveValue("12.34");
	await expect(
		page.getByRole("spinbutton", { name: "Max tokens cap" })
	).toHaveValue("512");
	await expect(
		page.getByRole("checkbox", { name: "Model calls" })
	).not.toBeChecked();
	await expect(page.getByRole("checkbox", { name: "Media" })).toBeChecked();
	await expect(
		page.getByRole("checkbox", { name: "Paid tools" })
	).not.toBeChecked();
});

test("rejects negative and over-precision values without issuing a Gateway write", async ({
	page,
}) => {
	const limit = page.getByRole("spinbutton", { name: "Spend cap (USD)" });
	for (const invalid of ["-1", "1.0000001"]) {
		await limit.fill(invalid);
		await page.getByRole("button", { name: "Save budget" }).click();
		await expect(page.getByRole("alert")).toHaveText(
			"Spend cap must be a non-negative USD amount (up to 6 decimals)."
		);
		expect(writes(await snapshot(page))).toEqual([]);
	}
	await page.screenshot({
		fullPage: true,
		path: evidencePath("agent-budget-panel-invalid-no-write"),
	});
});

test("keeps the draft and retries a failed save with the same exact rule", async ({
	page,
}) => {
	await page.getByRole("spinbutton", { name: "Spend cap (USD)" }).fill("9.75");
	await page.evaluate(() => {
		window.__agentBudgetPanelSweep.failNextConfigWrite = true;
	});
	await page.getByRole("button", { name: "Save budget" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"The Gateway is temporarily unavailable. Try again."
	);
	await expect(
		page.getByRole("spinbutton", { name: "Spend cap (USD)" })
	).toHaveValue("9.75");
	await expect(
		page.getByText("$2.50 spend cap · Notify", { exact: true })
	).toBeVisible();
	const afterFailure = await snapshot(page);
	expect(writes(afterFailure)).toHaveLength(1);
	expect(writes(afterFailure)[0]?.status).toBe(503);
	expect(afterFailure.budgets.agents[AGENT_ID]).toMatchObject({
		limit: 2_500_000,
	});

	await page.screenshot({
		fullPage: true,
		path: evidencePath("agent-budget-panel-save-retry-error"),
	});
	await page.getByRole("button", { name: "Save budget" }).click();
	await expect(
		page.getByText("Budget updated. Changes take effect immediately.")
	).toBeVisible();
	const afterRetry = await snapshot(page);
	expect(writes(afterRetry)).toHaveLength(2);
	expect(writes(afterRetry)[1]?.status).toBe(200);
	expect(writes(afterRetry)[1]?.body).toEqual(writes(afterFailure)[0]?.body);
	expect(writes(afterRetry)[1]?.body).toMatchObject({
		budgets: { agents: { [AGENT_ID]: { limit: 9_750_000 } } },
	});
	await expect(
		page.getByText("$9.75 spend cap · Notify", { exact: true })
	).toBeVisible();
});

test("keeps an existing rule after remove failure, then deletes only that agent rule on retry", async ({
	page,
}) => {
	await page.evaluate(() => {
		window.__agentBudgetPanelSweep.failNextConfigWrite = true;
	});
	await page.getByRole("button", { name: "Remove cap" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"The Gateway is temporarily unavailable. Try again."
	);
	await expect(
		page.getByText("$2.50 spend cap · Notify", { exact: true })
	).toBeVisible();
	const afterFailure = await snapshot(page);
	expect(writes(afterFailure)).toHaveLength(1);
	expect(writes(afterFailure)[0]?.status).toBe(503);
	expect(afterFailure.budgets.agents[AGENT_ID]).toMatchObject({
		limit: 2_500_000,
	});

	await page.getByRole("button", { name: "Remove cap" }).click();
	await expect(
		page.getByText("No cap configured yet.", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Remove cap" })).toHaveCount(0);
	const removed = await snapshot(page);
	expect(writes(removed)).toHaveLength(2);
	expect(writes(removed)[1]?.status).toBe(200);
	expect(writes(removed)[1]?.body).toEqual(writes(afterFailure)[0]?.body);
	expect(removed.budgets.agents).toEqual({
		"agent-budget-sweep-keep": {
			action: "stop",
			alert: "warn",
			include: { model: true, media: true, tools: true },
			limit: 3_000_000,
		},
	});
	expect(removed.budgets.users["user-budget-sweep-keep"]).toMatchObject({
		limit: 5_000_000,
	});
	expect(removed.budgets.session).toMatchObject({ limit: 4_000_000 });
	await page.screenshot({
		fullPage: true,
		path: evidencePath("agent-budget-panel-remove-retry-readback"),
	});
	await page.reload();
	await expect(
		page.getByText("No cap configured yet.", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Remove cap" })).toHaveCount(0);
});

test("downgrade picker, media inclusion and alert tier persist through the real agent budget caller", async ({
	page,
}) => {
	await page.getByRole("checkbox", { name: /^Media / }).uncheck();
	await page.getByLabel("Action when spend cap is reached").click();
	await page.getByRole("option", { name: /^Downgrade/ }).click();
	await page
		.getByRole("button", { name: "Downgrade to model", exact: true })
		.click();
	await page
		.getByRole("textbox", { name: "Custom model id" })
		.fill("local-budget-model");
	await page.getByRole("button", { name: "Use this model" }).click();
	await page.getByLabel("Notify when this rule fires").click();
	await page.getByRole("option", { name: /^Email/ }).click();
	await page.getByRole("button", { name: "Save budget" }).click();
	await expect(
		page.getByText("Budget updated. Changes take effect immediately.")
	).toBeVisible();
	const saved = await snapshot(page);
	expect(saved.budgets.agents[AGENT_ID]).toEqual({
		action: "downgrade",
		alert: "email",
		downgrade_to: "local-budget-model",
		include: { model: true, media: false, tools: true },
		limit: 2_500_000,
	});
	expect(writes(saved)).toHaveLength(1);
	expect(writes(saved)[0]?.body).toEqual({ budgets: saved.budgets });
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Downgrade to model", exact: true })
	).toContainText("local-budget-model");
	await expect(
		page.getByRole("checkbox", { name: /^Media / })
	).not.toBeChecked();
	await expect(page.getByLabel("Notify when this rule fires")).toContainText(
		"Email"
	);
	await page.screenshot({
		path: evidencePath("agent-budget-downgrade-alert-reloaded"),
		fullPage: true,
	});
});
