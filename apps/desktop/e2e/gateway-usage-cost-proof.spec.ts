import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import type {
	GatewayProvidersConfig,
	GatewayRoutingConfig,
} from "../src/lib/api/gateway.ts";

interface UsageCostSnapshot {
	config: { providers: GatewayProvidersConfig; routing: GatewayRoutingConfig };
	providerCreditRequests: string[];
	requests: { body: unknown; method: string; path: string }[];
}

interface UsageCostProofWindow extends Window {
	__usageCostProof: {
		failNextConfigWrite: boolean;
		releaseProviderCredits: () => void;
		releaseProfileStats: () => void;
		snapshot: () => UsageCostSnapshot;
	};
}

function screenshotPath(name: string): string {
	// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
	// the tracked proof ledger; without it the committed evidence is refreshed.
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	if (override) {
		return path.join(override, `${name}.png`);
	}
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

async function readProofState(page: import("@playwright/test").Page) {
	return page.evaluate(() =>
		/* SAFETY: gateway-usage-cost-proof.tsx installs __usageCostProof before this proof page is evaluated. */ (
			window as UsageCostProofWindow
		).__usageCostProof.snapshot()
	);
}

function section(page: import("@playwright/test").Page, title: string) {
	return page.getByRole("heading", { name: title }).locator("xpath=../..");
}

function configRequests(snapshot: UsageCostSnapshot, method: string) {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/gateway/config") && request.method === method
	);
}

test.describe.configure({ timeout: 60_000 });

test("renders sorted live quotas, account totals and models, BYOK balances, and read-only key counts", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.clock.install({ time: new Date("2026-09-25T12:00:00.000Z") });
	await page.goto("/gateway-usage-cost-proof.html");
	await expect(page.getByTestId("org-billing-context")).toContainText(
		"Example Organization"
	);
	await expect(page.getByTestId("org-billing-context")).toContainText(
		"Managed inference billing"
	);

	const quotaTable = page.getByRole("table").first();
	const quotaRows = await quotaTable.getByRole("row").allInnerTexts();
	expect(quotaRows.slice(1).map((row) => row.split("\t")[0])).toEqual([
		"Anthropic",
		"OpenAI",
	]);
	const anthropicQuota = quotaTable
		.getByRole("row")
		.filter({ hasText: "Anthropic" });
	await expect(anthropicQuota).toContainText("12 / 5,000");
	await expect(anthropicQuota).toContainText("2m 05s");
	await expect(anthropicQuota).toContainText("rate limited");
	const openAiQuota = quotaTable.getByRole("row").filter({ hasText: "OpenAI" });
	await expect(openAiQuota).toContainText("876 / 1,000");
	await expect(openAiQuota).toContainText("1m 01s");
	await expect(openAiQuota).toContainText("ok");
	await page.clock.runFor(1100);
	await expect(anthropicQuota).toContainText("2m 04s");

	const accountUsage = section(page, "Account usage rollup");
	await expect(accountUsage.getByText("$12", { exact: true })).toBeVisible();
	await expect(page.getByText("1,234", { exact: true }).first()).toBeVisible();
	await expect(page.getByText("3,345", { exact: true })).toBeVisible();
	const modelsTable = page.getByRole("table").nth(1);
	await expect(
		modelsTable.getByRole("row").filter({ hasText: "gpt-4.1" })
	).toContainText("1,234");
	await expect(
		modelsTable.getByRole("row").filter({ hasText: "claude-sonnet-4-5" })
	).toContainText("42");
	await expect(accountUsage).toBeVisible();

	const balances = section(page, "BYOK provider key balance");
	await expect(balances).toContainText("$12.34 left");
	await expect(balances).toContainText("Rate limited");
	await expect(balances).toContainText("Key rejected");

	const keys = section(page, "Additional account keys");
	await expect(keys.getByText("0 account keys", { exact: true })).toBeVisible();
	await expect(keys.getByText("1 account key", { exact: true })).toBeVisible();
	await expect(keys.getByText("3 account keys", { exact: true })).toBeVisible();
	await expect(keys).toContainText("OPENAI_API_KEYS");
	await expect(keys).toContainText("ANTHROPIC_API_KEYS");
	await expect(keys).toContainText("OPENROUTER_API_KEYS");

	const state = await readProofState(page);
	expect([...state.providerCreditRequests].sort()).toEqual([
		"deepseek",
		"moonshot",
		"openrouter",
	]);
	expect(
		state.requests.filter((request) =>
			request.path.endsWith("/api/gateway/config")
		)
	).toHaveLength(2);
	expect(browserErrors).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-usage-cost-populated"),
	});
});

test("shows explicit empty quota and zero-usage states without inventing model rows", async ({
	page,
}) => {
	await page.goto("/gateway-usage-cost-proof.html?quota=empty&stats=empty");
	await expect(page.getByText("No provider quota observed yet.")).toBeVisible();
	await expect(page.getByText("No model usage recorded yet.")).toBeVisible();
	await expect(page.getByText("Total spend")).toBeVisible();
	await expect(
		page.getByText("Requests", { exact: true }).first()
	).toBeVisible();
	await expect(page.getByText("Tokens", { exact: true })).toBeVisible();
	await expect(page.getByRole("table")).toHaveCount(0);
});

test("keeps unreported quota values explicit instead of rendering them as zero", async ({
	page,
}) => {
	await page.goto("/gateway-usage-cost-proof.html?quota=partial");
	const quota = page.getByRole("table").first();
	const gemini = quota.getByRole("row").filter({ hasText: "Gemini" });
	await expect(gemini).toContainText("—");
	await expect(gemini).toContainText("ok");
	const openAi = quota.getByRole("row").filter({ hasText: "OpenAI" });
	await expect(openAi).toContainText("? / 100");
	await expect(openAi).toContainText("30s");
});

test("distinguishes a stored provider balance of zero, a missing key, and an unavailable balance", async ({
	page,
}) => {
	await page.goto("/gateway-usage-cost-proof.html?credits=edges");
	const balances = section(page, "BYOK provider key balance");
	await expect(balances).toContainText("No key stored");
	await expect(balances).toContainText("Unavailable");
	await expect(balances).toContainText("$0.00 left");
	expect((await readProofState(page)).providerCreditRequests.sort()).toEqual([
		"deepseek",
		"moonshot",
		"openrouter",
	]);
});

test("shows provider-balance loading until each in-flight balance response arrives", async ({
	page,
}) => {
	await page.goto("/gateway-usage-cost-proof.html?credits=pending");
	const balances = section(page, "BYOK provider key balance");
	await expect(balances.getByText("Checking…", { exact: true })).toHaveCount(3);
	await page.evaluate(() =>
		/* SAFETY: gateway-usage-cost-proof.tsx installs __usageCostProof before this proof page is evaluated. */ (
			window as UsageCostProofWindow
		).__usageCostProof.releaseProviderCredits()
	);
	await expect(balances).toContainText("$12.34 left");
	await expect(balances).toContainText("Rate limited");
	await expect(balances).toContainText("Key rejected");
});

test("exposes the account rollup loading state until its request resolves", async ({
	page,
}) => {
	await page.goto("/gateway-usage-cost-proof.html?stats=pending");
	await expect(page.getByText("Loading…")).toBeVisible();
	await page.evaluate(() =>
		/* SAFETY: gateway-usage-cost-proof.tsx installs __usageCostProof before this proof page is evaluated. */ (
			window as UsageCostProofWindow
		).__usageCostProof.releaseProfileStats()
	);
	await expect(page.getByText("gpt-4.1", { exact: true })).toBeVisible();
	await expect(page.getByText("Loading…")).toHaveCount(0);
});

test("recovers an account rollup request failure through the visible retry action", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto("/gateway-usage-cost-proof.html?stats=error");
	await expect(page.getByText("Request failed (503)")).toBeVisible();
	await page
		.getByRole("button", { name: "Retry account usage rollup" })
		.click();
	await expect(
		section(page, "Account usage rollup").getByText("$12", { exact: true })
	).toBeVisible();
	const state = await readProofState(page);
	expect(
		state.requests.filter((request) =>
			request.path.endsWith("/api/profile/me/stats")
		)
	).toHaveLength(2);
	expect(browserErrors).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-usage-cost-rollup-retry-recovered"),
	});
});

test("saves and reloads a cost tier while preserving every unrelated routing field and retrying failed writes", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto("/gateway-usage-cost-proof.html");
	const openAiTier = page.getByRole("combobox", {
		name: "Cost tier for OpenAI",
	});
	await expect(openAiTier).toContainText("Cheap (1)");
	await expect(
		page.getByRole("combobox", { name: "Cost tier for vendor_internal" })
	).toContainText("Free (2)");
	await openAiTier.click();
	await page.getByRole("option", { name: "Free (2)" }).click();

	await page.evaluate(() => {
		/* SAFETY: gateway-usage-cost-proof.tsx installs __usageCostProof before this proof page is evaluated. */ (
			window as UsageCostProofWindow
		).__usageCostProof.failNextConfigWrite = true;
	});
	const save = page.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await expect(page.getByText("/api/gateway/config failed: 503")).toBeVisible();
	await expect(openAiTier).toContainText("Free (2)");
	expect(configRequests(await readProofState(page), "PUT")).toHaveLength(1);

	await save.click();
	await expect(
		page.getByText("Saved. Restart the gateway for changes to take effect.")
	).toBeVisible();
	let state = await readProofState(page);
	expect(configRequests(state, "PUT")).toHaveLength(2);
	const write = configRequests(state, "PUT").at(-1);
	const routing = z
		.object({
			routing: z
				.object({
					provider_tiers: z.record(z.string(), z.number()).optional(),
					default_provider: z.string(),
					fallback_chain: z.array(z.string()),
					model_map: z.record(z.string(), z.json()),
				})
				.passthrough()
				.optional(),
		})
		.parse(write?.body).routing;
	expect(routing?.provider_tiers).toEqual({
		anthropic: 0,
		openai: 2,
		vendor_internal: 2,
	});
	expect(routing).toMatchObject({
		default_provider: "anthropic",
		fallback_chain: ["openai", "openrouter"],
		model_map: {
			"friendly-code-model": {
				provider: "openai",
				provider_model: "gpt-4.1-mini",
			},
		},
		smart_routing: {
			enabled: true,
			similarity_threshold: 0.42,
			strategy: "embedding",
		},
		modality_map: { image: { provider: "fal", model: "flux-schnell" } },
		eval_routing: {
			candidates: ["anthropic", "openai"],
			enabled: true,
			explore_ratio: 0.15,
		},
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-usage-cost-tier-saved"),
	});

	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "Cost tier for OpenAI" })
	).toContainText("Free (2)");
	state = await readProofState(page);
	expect(state.config.routing.provider_tiers?.openai).toBe(2);
	expect(browserErrors).toEqual([]);
});

test("retries failed cost-tier and additional-key reads independently instead of showing false zero counts", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto("/gateway-usage-cost-proof.html?failConfigReads=2");
	await expect(
		page.getByRole("button", { name: "Retry provider cost tier load" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Retry additional account key counts" })
	).toBeVisible();
	await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(3);
	await expect(page.getByText("0 account keys", { exact: true })).toHaveCount(
		0
	);

	await page
		.getByRole("button", { name: "Retry provider cost tier load" })
		.click();
	await expect(
		page.getByRole("combobox", { name: "Cost tier for OpenAI" })
	).toContainText("Cheap (1)");
	await page
		.getByRole("button", { name: "Retry additional account key counts" })
		.click();
	await expect(page.getByText("0 account keys", { exact: true })).toBeVisible();
	await expect(page.getByText("1 account key", { exact: true })).toBeVisible();
	await expect(page.getByText("3 account keys", { exact: true })).toBeVisible();
	const state = await readProofState(page);
	expect(configRequests(state, "GET")).toHaveLength(4);
	expect(browserErrors).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-usage-cost-config-retry-recovered"),
	});
});

test("disables tier editing and marks key counts unavailable when the Gateway cannot be reached", async ({
	page,
}) => {
	await page.goto("/gateway-usage-cost-proof.html?reachable=false");
	await expect(
		page.getByText(
			"Gateway unreachable. Start the gateway and refresh to configure provider tiers."
		)
	).toBeVisible();
	await expect(
		page.getByText(
			"Gateway unreachable. Start the gateway and refresh to view account keys."
		)
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Cost tier for OpenAI" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(3);
	const state = await readProofState(page);
	expect(configRequests(state, "GET")).toHaveLength(0);
	expect(configRequests(state, "PUT")).toHaveLength(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-usage-cost-unreachable"),
	});
});
