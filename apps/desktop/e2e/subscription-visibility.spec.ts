import path from "node:path";
import { expect, test } from "@playwright/test";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";
import type { SubscriptionCostAccountUsage } from "../src/lib/api/subscription-costs.ts";

function pricedAccount({
	accountId,
	estimatedCostMicroUsd,
	inputTokens,
	modelId,
	outputTokens,
	providerId,
}: {
	accountId: string;
	estimatedCostMicroUsd: number;
	inputTokens: number;
	modelId: string;
	outputTokens: number;
	providerId: string;
}): SubscriptionCostAccountUsage {
	const turns = 3;
	return {
		accountId,
		estimatedCostMicroUsd,
		inputTokens,
		missingInputTurns: 0,
		missingOutputTurns: 0,
		models: [
			{
				estimatedCostMicroUsd,
				inputTokens,
				missingInputTurns: 0,
				missingOutputTurns: 0,
				modelId,
				outputTokens,
				priceSource: "models.dev",
				turns,
				unpricedInputTokens: 0,
				unpricedOutputTokens: 0,
			},
		],
		outputTokens,
		providerId,
		turns,
		unpricedInputTokens: 0,
		unpricedOutputTokens: 0,
	};
}

const costAccounts: SubscriptionCostAccountUsage[] = [
	pricedAccount({
		accountId: "personal",
		estimatedCostMicroUsd: 125_000,
		inputTokens: 12_000,
		modelId: "gpt-5.5",
		outputTokens: 2000,
		providerId: "codex",
	}),
	pricedAccount({
		accountId: "work",
		estimatedCostMicroUsd: 75_000,
		inputTokens: 10_000,
		modelId: "gpt-5.5",
		outputTokens: 1000,
		providerId: "codex",
	}),
	pricedAccount({
		accountId: "team",
		estimatedCostMicroUsd: 450_000,
		inputTokens: 5000,
		modelId: "claude-sonnet-4",
		outputTokens: 2500,
		providerId: "claude",
	}),
];

test("retained usage page stays quiet while hidden and reuses fresh account data", async ({
	page,
}) => {
	let reads = 0;
	let costReads = 0;
	let costWrites = 0;
	let trackingEnabled = false;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/**", async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		if (!pathname.startsWith("/api/")) {
			return route.continue();
		}
		if (pathname.endsWith("/api/usage/subscription-costs/settings")) {
			costWrites += 1;
			const input = pluginDocumentSchema.parse(route.request().postDataJSON());
			trackingEnabled = input.enabled === true;
			return route.fulfill({ json: { enabled: trackingEnabled } });
		}
		if (pathname.endsWith("/api/usage/subscription-costs")) {
			costReads += 1;
			return route.fulfill({
				json: {
					enabled: trackingEnabled,
					month: "2026-09",
					accounts: trackingEnabled ? costAccounts : [],
				},
			});
		}
		if (!(pathname.includes("/accounts/") && pathname.endsWith("/usage"))) {
			return route.fulfill({ json: {} });
		}
		reads += 1;
		await route.fulfill({
			json: {
				agent_id: "codex",
				available: true,
				engine: "codex",
				plan: "Pro",
				windows: [
					{ label: "Session", used_percent: 25, window_seconds: 18_000 },
				],
				meters: [],
			},
		});
	});
	await page.goto("/subscription-visibility-proof.html");
	await expect(
		page.getByRole("button", { name: "Show usage", exact: true })
	).toBeVisible();
	expect(reads).toBe(0);
	await page.getByRole("button", { name: "Show usage", exact: true }).click();
	await expect(
		page.getByRole("region", { name: "Subscription usage" })
	).toBeVisible();
	await expect(
		page
			.getByTestId("subscription-usage-account-personal")
			.getByText("Personal", { exact: true })
	).toBeVisible();
	await expect.poll(() => reads).toBe(3);
	await expect.poll(() => costReads).toBe(1);
	await expect(
		page
			.getByTestId("subscription-usage-account-personal")
			.getByRole("progressbar", { name: "Session: 75% left" })
	).toBeVisible();
	const costToggle = page.getByRole("switch", {
		name: "Track API-equivalent subscription usage",
	});
	await expect(costToggle).not.toBeChecked();
	await costToggle.click();
	await expect.poll(() => costWrites).toBe(1);
	await expect.poll(() => costReads).toBe(2);
	await expect(costToggle).toBeChecked();
	await expect(
		page.getByTestId("subscription-cost-provider-total-codex")
	).toHaveText("$0.20");
	await expect(
		page.getByTestId("subscription-cost-provider-total-claude")
	).toHaveText("$0.45");
	await expect(page.getByTestId("subscription-cost-total")).toHaveText("$0.65");
	await expect(
		page.getByTestId("subscription-cost-account-codex-personal")
	).toContainText("Personal");
	await expect(
		page.getByTestId("subscription-cost-account-codex-personal")
	).toContainText("$0.125");
	await expect(
		page.getByTestId("subscription-cost-account-codex-work")
	).toContainText("Work");
	await expect(
		page.getByTestId("subscription-cost-account-claude-team")
	).toContainText("Work");
	await expect(
		page.getByTestId("subscription-cost-account-claude-team")
	).toContainText("$0.45");
	await page.getByRole("button", { name: "Hide usage", exact: true }).click();
	await expect(
		page.getByRole("region", { name: "Subscription usage" })
	).toBeHidden();
	await page.getByRole("button", { name: "Show usage", exact: true }).click();
	await expect(
		page
			.getByTestId("subscription-usage-account-personal")
			.getByText("Personal", { exact: true })
	).toBeVisible();
	await expect(
		page
			.getByTestId("subscription-usage-account-personal")
			.getByRole("progressbar", { name: "Session: 75% left" })
	).toBeVisible();
	expect(reads).toBe(3);
	expect(costReads).toBe(2);
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/subscription-api-equivalent-usage-2026-09-24.png"
		),
		fullPage: true,
		animations: "disabled",
	});
});

test("a sealed-account read failure shows an unavailable usage state", async ({
	page,
}) => {
	test.setTimeout(90_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/**", async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		if (!pathname.startsWith("/api/")) {
			return route.continue();
		}
		if (pathname.endsWith("/api/usage/subscription-costs/settings")) {
			return route.fulfill({ json: { enabled: false } });
		}
		if (pathname.endsWith("/api/usage/subscription-costs")) {
			return route.fulfill({
				json: { enabled: false, month: "2026-09", accounts: [] },
			});
		}
		if (pathname.includes("/accounts/") && pathname.endsWith("/usage")) {
			const failed = pathname.includes("/accounts/personal/");
			return route.fulfill({
				json: failed
					? {
							agent_id: "codex",
							available: false,
							engine: "codex",
							reason: "error",
							windows: [],
						}
					: {
							agent_id: "codex",
							available: true,
							engine: "codex",
							windows: [{ label: "Session", used_percent: 25 }],
						},
			});
		}
		return route.fulfill({ json: {} });
	});
	const navigation = await page.goto("/subscription-visibility-proof.html");
	expect(navigation?.status()).toBe(200);
	await page.getByRole("button", { name: "Show usage", exact: true }).click();
	const account = page.getByTestId("subscription-usage-account-personal");
	await expect(account).toContainText("Personal");
	await expect(account).toContainText(
		"Usage could not be read. Try refresh again later."
	);
	await expect(account).not.toContainText("Start or sign in");
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/subscription-usage-credential-error.png"
		),
		fullPage: true,
		animations: "disabled",
	});
});
