import { expect, type Page, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
	const policies = new Map<string, unknown>();
	await page.route(
		"**/api/pi-config/providers/*/account-pool",
		async (route) => {
			const pathname = new URL(route.request().url()).pathname;
			const providerId = pathname.split("/").at(-2) ?? "";
			const headers = {
				"access-control-allow-origin": "*",
				"access-control-allow-methods": "GET, PUT, OPTIONS",
				"access-control-allow-headers": "content-type, authorization",
			};
			if (route.request().method() === "OPTIONS") {
				return route.fulfill({ status: 204, headers });
			}
			if (route.request().method() === "PUT") {
				policies.set(providerId, route.request().postDataJSON());
			}
			return route.fulfill({
				headers,
				json: policies.get(providerId) ?? {
					strategy: "manual",
					drainThresholdPercent: 80,
					accounts: {},
				},
			});
		}
	);
});

// The providers are one list; a row opens that provider's page. A row is
// found by the provider's catalog id, and its one quiet line says what kind
// of provider it is and how it is connected.
const row = (page: Page, id: string) =>
	page.locator(`[data-provider-page-row="provider:${id}"]`);

async function backToList(page: Page) {
	await page.getByRole("button", { name: "Back to AI providers" }).click();
	await expect(page.locator("[data-provider-list]")).toBeVisible();
}

test("ChatGPT OAuth account routing saves strategy and priority", async ({
	page,
}) => {
	await page.goto("/provider-connections-proof.html");
	await expect(row(page, "chatgpt")).toContainText(
		"Subscription · Accounts: 2"
	);
	await row(page, "chatgpt").click();
	// The pool controls' heading is "Account routing" (already so at 07d403e33).
	// They sit in the Accounts section, right under the accounts they order.
	await expect(
		page
			.locator('[data-provider-page-section="accounts"]')
			.getByRole("heading", { name: "Account routing", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Account routing", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "ChatGPT account 2", exact: true })
	).toBeVisible();
	await page.getByLabel("Strategy").click();
	await page.getByRole("option", { name: "Round robin" }).click();
	await page.locator("#oauth-priority-chatgpt-b").fill("2");
	await page.getByRole("button", { name: "Save routing" }).click();
	await expect(
		page.getByRole("button", { name: "Save routing" })
	).toBeDisabled();
	const routingPanel = page
		.getByRole("heading", { name: "Account routing", exact: true })
		.locator("xpath=../..");
	await routingPanel.scrollIntoViewIfNeeded();
	await routingPanel.screenshot({
		path: proofEvidencePath("provider-connections/chatgpt-oauth-routing.png"),
	});
	await page.reload();
	await row(page, "chatgpt").click();
	await expect(page.getByLabel("Strategy")).toContainText("Round robin");
	await expect(page.locator("#oauth-priority-chatgpt-b")).toHaveValue("2");
});

test("provider connection groups and account actions render without errors", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/provider-connections-proof.html");

	// Two groups, connected and not. The three kinds of provider are told
	// apart by the row's line, not by three headings.
	await expect(
		page.getByRole("heading", { name: "Connected", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Other", exact: true })
	).toBeVisible();
	await expect(row(page, "managed-openrouter")).toContainText("Ryu managed");
	await expect(row(page, "claude-pro-max")).toContainText(
		"Subscription · Accounts: 2"
	);
	await expect(row(page, "openrouter")).toContainText(
		"API key · OpenRouter API key"
	);
	await expect(row(page, "local-model-server")).toContainText(
		"Custom · Configured"
	);
	await expect(row(page, "anthropic")).toContainText("API key · Not connected");

	await row(page, "claude-pro-max").click();
	await expect(page.getByRole("button", { name: "Add account" })).toBeVisible();
	await expect(
		page.getByText("Models from the installed Pi engine.")
	).toBeVisible();
	await page.getByLabel("Model", { exact: true }).click();
	await page.getByRole("option", { name: "Claude Haiku 4.5" }).click();
	await expect(page.getByLabel("Model", { exact: true })).toContainText(
		"Claude Haiku 4.5"
	);
	await page
		.getByRole("button", { name: "Claude account 2", exact: true })
		.click();
	await expect(page.getByText("Use for yourself")).toBeVisible();
	await expect(page.getByText("Set for Gateway", { exact: true })).toHaveCount(
		0
	);
	await page.getByText("Use for yourself").click();
	await expect(
		page.getByRole("button", { name: /Claude account 2 You/ })
	).toBeVisible();

	await backToList(page);
	await expect(row(page, "claude-pro-max")).toBeFocused();
	await row(page, "openrouter").click();
	await expect(
		page.getByRole("button", { name: "Login", exact: true })
	).toBeVisible();
	await expect(page.getByLabel("API key", { exact: true })).toBeVisible();

	const brokenImages = await page
		.locator("img")
		.evaluateAll(
			(images) =>
				images.filter(
					(image) =>
						image instanceof HTMLImageElement && image.naturalWidth === 0
				).length
		);
	expect(brokenImages).toBe(0);
	expect(pageErrors).toEqual([]);

	await page.screenshot({
		path: proofEvidencePath("provider-connections/provider-connections.png"),
		fullPage: true,
	});
});

test("custom provider shows saved model discovery after its endpoint goes offline", async ({
	page,
}) => {
	await page.goto("/provider-connections-proof.html");
	await row(page, "local-model-server").click();
	await expect(
		page.getByText("Showing models saved from the last successful discovery.")
	).toBeVisible();
	await expect(page.getByText("local-a", { exact: true })).toBeVisible();
	await expect(page.getByText("local-b", { exact: true })).toBeVisible();
	await page.screenshot({
		path: proofEvidencePath("provider-connections/custom-model-discovery.png"),
		fullPage: true,
	});
});

test("custom provider saves a replacement key from its existing card", async ({
	page,
}) => {
	await page.goto("/provider-connections-proof.html");
	await row(page, "local-model-server").click();
	const keyInput = page.locator("#key-local-model-server");
	await keyInput.fill("synthetic-ui-replacement-key");
	// Saving a key needs the spending-limit acknowledgement (SpendLimitConfirm,
	// already gating at 07d403e33, before Ryu Quiet).
	const save = page.getByRole("button", { name: "Save", exact: true });
	await expect(save).toBeDisabled();
	await page
		.getByRole("checkbox", {
			name: "I have set a spending limit for this key at Local model server",
		})
		.click();
	await save.click();
	await expect(
		page.getByRole("button", { name: /Local API key You/ })
	).toBeVisible();
	await expect(keyInput).toHaveValue("");
	await expect(page.getByText("local-a", { exact: true })).toBeVisible();
	await page.screenshot({
		path: proofEvidencePath(
			"provider-connections/custom-provider-key-save.png"
		),
		fullPage: true,
	});
});

test("official ChatGPT plan reuses a saved registration for explicit plan consent", async ({
	page,
}) => {
	await page.route(
		"**/api/pi-config/providers/chatgpt-plan/login?*",
		async (route) => {
			const query = new URL(route.request().url()).searchParams;
			expect(query.get("accountId")).toBe("plan-a");
			expect(query.get("enablePlanUse")).toBe("true");
			await route.fulfill({
				json: { sessionId: "plan-consent-proof" },
				headers: { "access-control-allow-origin": "*" },
			});
		}
	);
	await page.route(
		"**/api/pi-config/login/plan-consent-proof/events",
		(route) =>
			route.fulfill({
				contentType: "text/event-stream",
				headers: { "access-control-allow-origin": "*" },
				body: `data: ${JSON.stringify({ type: "success", accountId: "plan-a", planUseAuthorized: true })}\n\n`,
			})
	);
	await page.goto("/provider-connections-proof.html");
	await row(page, "chatgpt-plan").click();
	await expect(
		page.getByText("Identity is saved. Plan use needs separate permission.")
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Continue with ChatGPT", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Enable plan use", exact: true })
		.click();
	await expect(
		page.getByRole("dialog", { name: "Your ChatGPT plan is connected" })
	).toBeVisible();
	await page.getByRole("button", { name: "Got it", exact: true }).click();
	await expect(
		page.getByText("Models discovered live from the provider.")
	).toBeVisible();
	await page.locator("[data-provider-page]").screenshot({
		path: proofEvidencePath("provider-connections/chatgpt-plan-connected.png"),
	});
});

test("login failure shows the server's actionable explanation", async ({
	page,
}) => {
	await page.route(
		"**/api/pi-config/providers/claude-pro-max/login",
		async (route) => {
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				headers: { "access-control-allow-origin": "*" },
				body: JSON.stringify({
					error:
						"Provider login runtime could not be prepared. Check Bun and registry access.",
				}),
			});
		}
	);
	await page.goto("/provider-connections-proof.html");
	await row(page, "claude-pro-max").click();
	await page.getByRole("button", { name: "Add account", exact: true }).click();
	await expect(
		page.getByRole("dialog", { name: "Sign in to Claude" })
	).toBeVisible();
	await expect(
		page.getByText(
			"Provider login runtime could not be prepared. Check Bun and registry access."
		)
	).toBeVisible();
});

test("browser OAuth offers a normal authorization link", async ({ page }) => {
	const headers = { "access-control-allow-origin": "*" };
	await page.route("**/api/pi-config/providers/claude-pro-max/login", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			headers,
			body: JSON.stringify({ sessionId: "link-proof" }),
		})
	);
	await page.route("**/api/pi-config/login/link-proof/events", (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/event-stream",
			headers,
			body: `data: ${JSON.stringify({ type: "auth_url", url: "https://claude.ai/oauth/authorize?test=proof" })}\n\n`,
		})
	);
	await page.goto("/provider-connections-proof.html");
	await row(page, "claude-pro-max").click();
	await page.getByRole("button", { name: "Add account", exact: true }).click();
	const link = page.getByRole("link", { name: "Open the authorization page" });
	await expect(link).toHaveAttribute(
		"href",
		"https://claude.ai/oauth/authorize?test=proof"
	);
	await expect(link).toHaveAttribute("target", "_blank");
	await expect(link).toHaveAttribute("rel", /noopener/);
});
