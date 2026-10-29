import { expect, type Page, test } from "@playwright/test";

// Browser-only NodeRoutingSettings behavior on the shipping component: the
// quantization checkboxes live inside <label> wrappers (label activation is a
// browser behavior), and the provider strategy Select is operated by keyboard.
// Runs through node-routing-coverage.playwright.config.ts.
const ORG_ID = "507f1f77bcf86cd799439092";
const corsHeaders = {
	"Access-Control-Allow-Headers":
		"Authorization, Content-Type, x-ryu-user-jwt, x-ryu-user-id, x-ryu-agent-id",
	"Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
	"Access-Control-Allow-Origin": "*",
};
const SEED = {
	fallback: ["anthropic"],
	openrouter: { experimental_region: { pin: "eu-west" } },
};

async function prepareBusinessNode(page: Page) {
	const store = { value: JSON.stringify(SEED), puts: [] as string[] };
	await page.addInitScript(() => {
		localStorage.setItem("ryu_session_token", "node-routing-coverage");
	});
	await page.route("**/api/auth/get-session", (route) =>
		route.fulfill({
			headers: corsHeaders,
			json: { session: { activeOrganizationId: ORG_ID } },
		})
	);
	await page.route("**/api/auth/token", (route) =>
		route.fulfill({ headers: corsHeaders, json: { token: "member-jwt" } })
	);
	await page.route("**/api/control-plane/orgs", (route) =>
		route.fulfill({
			headers: corsHeaders,
			json: {
				organizations: [
					{
						id: ORG_ID,
						isPersonal: false,
						name: "Coverage organization",
						role: "owner",
						slug: "coverage-org",
					},
				],
			},
		})
	);
	await page.route("**/api/billing/subscription-status", (route) =>
		route.fulfill({
			headers: corsHeaders,
			json: {
				entitlement: {
					desktopAccess: true,
					managedInference: true,
					marketplaceApps: true,
					monthlyCreditPoolMicroUsd: 0,
					plan: "business",
					seats: 1,
				},
				organizationId: ORG_ID,
				plan: "business",
				scope: "org",
				subscription: null,
			},
		})
	);
	await page.route("**/api/preferences/node-routing-prefs", async (route) => {
		if (route.request().method() === "PUT") {
			store.value = route.request().postDataJSON().value;
			store.puts.push(store.value);
		}
		await route.fulfill({
			headers: corsHeaders,
			json: { key: "node-routing-prefs", value: store.value },
		});
	});
	await page.route("https://openrouter.ai/api/v1/providers", (route) =>
		route.fulfill({
			headers: corsHeaders,
			json: { data: [{ name: "Azure", slug: "azure" }] },
		})
	);
	return store;
}

/** Quantization checkboxes by aria-label: "fp8" is a substring of "mxfp8". */
function quantization(page: Page, precision: string) {
	return page.locator(
		`[role="checkbox"][aria-label="${precision} quantization"]`
	);
}

async function openBusinessRouting(page: Page) {
	await page.goto("managed-openrouter-routing-proof.html");
	await expect(
		page.getByRole("combobox", { name: "OpenRouter provider strategy" })
	).toBeEnabled();
}

test("quantization checkboxes toggle by pointer, label text and Space, save the exact list and reload checked", async ({
	page,
}) => {
	const store = await prepareBusinessNode(page);
	await openBusinessRouting(page);
	const fp8 = quantization(page, "fp8");
	const int4 = quantization(page, "int4");
	const bf16 = quantization(page, "bf16");
	await expect(fp8).not.toBeChecked();
	await fp8.click();
	await expect(fp8).toBeChecked();
	await int4.click();
	await expect(int4).toBeChecked();
	// Clicking the visible label text toggles its checkbox exactly once.
	await page.locator("label", { has: bf16 }).getByText("bf16").click();
	await expect(bf16).toBeChecked();
	await fp8.focus();
	await page.keyboard.press("Space");
	await expect(fp8).not.toBeChecked();
	await expect(int4).toBeChecked();

	await page.getByRole("button", { name: "Save routing preferences" }).click();
	await expect.poll(() => store.puts.length).toBe(1);
	expect(JSON.parse(store.puts[0] ?? "{}")).toEqual({
		...SEED,
		openrouter: { ...SEED.openrouter, quantizations: ["int4", "bf16"] },
	});

	await page.reload();
	await openBusinessRouting(page);
	await expect(quantization(page, "int4")).toBeChecked();
	await expect(quantization(page, "bf16")).toBeChecked();
	await expect(quantization(page, "fp8")).not.toBeChecked();
	await quantization(page, "int4").click();
	await quantization(page, "bf16").click();
	await page.getByRole("button", { name: "Save routing preferences" }).click();
	await expect.poll(() => store.puts.length).toBe(2);
	// Clearing every precision removes the key; unrelated options remain.
	expect(JSON.parse(store.puts[1] ?? "{}")).toEqual(SEED);
});

test("the provider strategy select opens and commits by keyboard and keeps focus on its trigger", async ({
	page,
}) => {
	const store = await prepareBusinessNode(page);
	await openBusinessRouting(page);
	const strategy = page.getByRole("combobox", {
		name: "OpenRouter provider strategy",
	});
	await strategy.focus();
	await page.keyboard.press("Enter");
	const latency = page.getByRole("option", { name: "Lower latency first" });
	await expect(latency).toBeVisible();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await expect(latency).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(latency).toBeHidden();
	await expect(strategy).toContainText("Lower latency first");
	await expect(strategy).toBeFocused();
	await page.getByRole("button", { name: "Save routing preferences" }).click();
	await expect.poll(() => store.puts.length).toBe(1);
	expect(JSON.parse(store.puts[0] ?? "{}")).toEqual({
		...SEED,
		openrouter: { ...SEED.openrouter, sort: "latency" },
	});
});
