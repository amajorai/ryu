import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const ORG_ID = "507f1f77bcf86cd799439091";
// RYU_OPENROUTER_ROUTING_PROOF_DIR redirects screenshots for verification runs
// that must not rewrite the tracked proof images.
const proofDir =
	process.env.RYU_OPENROUTER_ROUTING_PROOF_DIR ??
	path.resolve(import.meta.dirname, "../../../docs/proof/openrouter-routing");
const corsHeaders = {
	"Access-Control-Allow-Headers":
		"Authorization, Content-Type, x-ryu-user-jwt, x-ryu-user-id, x-ryu-agent-id",
	"Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
	"Access-Control-Allow-Origin": "*",
};

async function prepareProof(page: Page, plan: "business" | "pro") {
	let savedValue = "";
	await page.addInitScript(() => {
		localStorage.setItem("ryu_session_token", "openrouter-routing-proof");
	});

	await page.route("**/api/auth/get-session", (route) =>
		route.fulfill({
			contentType: "application/json",
			headers: corsHeaders,
			json: { session: { activeOrganizationId: ORG_ID } },
		})
	);
	await page.route("**/api/control-plane/orgs", (route) =>
		route.fulfill({
			contentType: "application/json",
			headers: corsHeaders,
			json: {
				organizations: [
					{
						createdAt: null,
						id: ORG_ID,
						isPersonal: false,
						logo: null,
						name: "Proof organization",
						role: "owner",
						slug: "proof-org",
					},
				],
			},
		})
	);
	await page.route("**/api/billing/subscription-status", (route) =>
		route.fulfill({
			contentType: "application/json",
			headers: corsHeaders,
			json: {
				// The billing wire contract requires a complete entitlement row;
				// a partial one is refused and the page keeps the plan gate.
				entitlement: {
					desktopAccess: true,
					managedInference: true,
					marketplaceApps: true,
					monthlyCreditPoolMicroUsd: 0,
					plan,
					seats: 1,
				},
				organizationId: ORG_ID,
				plan,
				scope: "org",
				subscription: null,
			},
		})
	);
	await page.route("**/api/preferences/node-routing-prefs", async (route) => {
		if (route.request().method() === "PUT") {
			const body = route.request().postDataJSON();
			savedValue = body.value ?? "";
			await route.fulfill({
				contentType: "application/json",
				headers: corsHeaders,
				json: { value: savedValue },
			});
			return;
		}
		await route.fulfill({
			contentType: "application/json",
			headers: corsHeaders,
			json: { value: savedValue || null },
		});
	});
	await page.route("https://openrouter.ai/api/v1/providers", (route) =>
		route.fulfill({
			contentType: "application/json",
			headers: corsHeaders,
			json: {
				data: [
					{ name: "Anthropic", slug: "anthropic" },
					{ name: "Azure", slug: "azure" },
					{ name: "Google Vertex", slug: "google-vertex" },
				],
			},
		})
	);

	return () => savedValue;
}

test.describe.configure({ timeout: 120_000 });

test("Business members can choose OpenRouter routing and privacy controls", async ({
	page,
}) => {
	await mkdir(proofDir, { recursive: true });
	const readSavedValue = await prepareProof(page, "business");
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});

	await page.goto("managed-openrouter-routing-proof.html");
	await expect(page.getByRole("heading", { name: "Gateway" })).toBeVisible();
	await expect(
		page.getByText("OpenRouter routing", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "OpenRouter provider strategy" })
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "OpenRouter provider strategy" })
	).toContainText("OpenRouter health-aware default");

	const strategy = page.getByRole("combobox", {
		name: "OpenRouter provider strategy",
	});
	await strategy.click();
	await page.getByRole("option", { name: "Higher throughput first" }).click();

	const providerInputs = page.getByRole("combobox", {
		name: "OpenRouter provider slug",
	});
	await providerInputs.nth(0).fill("azure");
	await page.getByRole("button", { name: "Add provider" }).click();
	await providerInputs.nth(0).fill("google-vertex");
	await page.getByRole("button", { name: "Add provider" }).click();
	await providerInputs.nth(1).fill("azure");
	await page.getByRole("button", { name: "Add", exact: true }).nth(0).click();
	await providerInputs.nth(2).fill("anthropic");
	await page.getByRole("button", { name: "Add", exact: true }).nth(1).click();

	const fallbackSwitch = page.getByRole("switch", {
		name: "Allow provider fallbacks",
	});
	await expect(fallbackSwitch).toBeChecked();
	// Gateway requires ZDR and excludes data-collecting providers for every
	// plan, so both controls are shown locked on rather than editable.
	const zdrSwitch = page.getByRole("switch", {
		name: "Require Zero Data Retention (ZDR)",
	});
	await expect(zdrSwitch).toBeChecked();
	await expect(zdrSwitch).toBeDisabled();
	const collection = page.getByRole("combobox", {
		name: "OpenRouter data collection",
	});
	await expect(collection).toContainText("Exclude data-collecting providers");
	await expect(collection).toBeDisabled();
	await page
		.getByRole("spinbutton", { name: "Prompt ($ per million tokens)" })
		.fill("2.5");
	await page
		.getByRole("textbox", { name: "OpenRouter fallback model id" })
		.fill("anthropic/claude-sonnet-4.6");
	await page.getByRole("button", { name: "Add model" }).click();

	await page.getByRole("button", { name: "Save routing preferences" }).click();
	await expect.poll(readSavedValue).not.toBe("");
	const saved: unknown = JSON.parse(readSavedValue());
	// The locked privacy policy is enforced by Gateway, not saved as an
	// editable preference, so the document carries only the chosen routing.
	expect(saved).toEqual({
		openrouter: {
			ignore: ["anthropic"],
			max_price: { prompt: 2.5 },
			only: ["azure"],
			order: ["azure", "google-vertex"],
			sort: "throughput",
		},
		openrouter_model_fallbacks: ["anthropic/claude-sonnet-4.6"],
	});

	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "OpenRouter provider strategy" })
	).toContainText("Higher throughput first");
	await expect(
		page.getByRole("switch", { name: "Require Zero Data Retention (ZDR)" })
	).toBeChecked();
	await expect(
		page.getByText("anthropic/claude-sonnet-4.6", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Move google-vertex up" })
	).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Move azure up" })
	).toBeDisabled();
	await expect(
		page.getByRole("spinbutton", { name: "Prompt ($ per million tokens)" })
	).toHaveValue("2.5");
	await expect(
		page.getByRole("switch", { name: "Allow provider fallbacks" })
	).toBeChecked();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(proofDir, "business-routing-settings.png"),
	});

	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});

test("non-Business organizations see the Business plan gate", async ({
	page,
}) => {
	await mkdir(proofDir, { recursive: true });
	await prepareProof(page, "pro");
	await page.goto("managed-openrouter-routing-proof.html");
	await expect(
		page.getByText("Business plan required", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "View Business plans" })
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "OpenRouter provider strategy" })
	).toHaveCount(0);
	await expect(
		page.getByRole("switch", { name: "Require Zero Data Retention (ZDR)" })
	).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(proofDir, "business-plan-gate.png"),
	});
});
