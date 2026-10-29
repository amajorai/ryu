import path from "node:path";
import { expect, test } from "@playwright/test";

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

test("ChatGPT OAuth account routing saves strategy and priority", async ({
	page,
}) => {
	await page.goto("/provider-connections-proof.html");
	await page.getByRole("button", { name: /^ChatGPT Connected/ }).click();
	await expect(
		page.getByRole("heading", { name: "OAuth account routing" })
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
		.getByRole("heading", { name: "OAuth account routing" })
		.locator("xpath=../..");
	await routingPanel.scrollIntoViewIfNeeded();
	await routingPanel.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/provider-connections/chatgpt-oauth-routing.png"
		),
	});
	await page.reload();
	await page.getByRole("button", { name: /^ChatGPT Connected/ }).click();
	await expect(page.getByLabel("Strategy")).toContainText("Round robin");
	await expect(page.locator("#oauth-priority-chatgpt-b")).toHaveValue("2");
});

test("provider connection groups and account actions render without errors", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/provider-connections-proof.html");

	await expect(
		page.getByRole("heading", { name: "Ryu managed" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "OAuth accounts" })
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

	await page.getByRole("button", { name: /Claude \(Pro\/Max/ }).click();
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

	await page.getByRole("button", { name: /OpenRouter Configured/ }).click();
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
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/provider-connections/provider-connections.png"
		),
		fullPage: true,
	});
});

test("custom provider shows saved model discovery after its endpoint goes offline", async ({
	page,
}) => {
	await page.goto("/provider-connections-proof.html");
	await page
		.getByRole("button", { name: /Local model server Configured/ })
		.click();
	await expect(
		page.getByText("Showing models saved from the last successful discovery.")
	).toBeVisible();
	await expect(page.getByText("local-a", { exact: true })).toBeVisible();
	await expect(page.getByText("local-b", { exact: true })).toBeVisible();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/provider-connections/custom-model-discovery.png"
		),
		fullPage: true,
	});
});

test("custom provider saves a replacement key from its existing card", async ({
	page,
}) => {
	await page.goto("/provider-connections-proof.html");
	await page
		.getByRole("button", { name: /Local model server Configured/ })
		.click();
	const keyInput = page.locator("#key-local-model-server");
	await keyInput.fill("synthetic-ui-replacement-key");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByRole("button", { name: /Local API key You/ })
	).toBeVisible();
	await expect(keyInput).toHaveValue("");
	await expect(page.getByText("local-a", { exact: true })).toBeVisible();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/provider-connections/custom-provider-key-save.png"
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
	await page
		.getByRole("button", { name: /ChatGPT plan \(self-hosted\)/ })
		.click();
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
	await page
		.getByRole("button", { name: /ChatGPT plan \(self-hosted\)/ })
		.locator("xpath=../..")
		.screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/provider-connections/chatgpt-plan-connected.png"
			),
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
	await page.getByRole("button", { name: /Claude \(Pro\/Max/ }).click();
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
	await page.getByRole("button", { name: /Claude \(Pro\/Max/ }).click();
	await page.getByRole("button", { name: "Add account", exact: true }).click();
	const link = page.getByRole("link", { name: "Open the authorization page" });
	await expect(link).toHaveAttribute(
		"href",
		"https://claude.ai/oauth/authorize?test=proof"
	);
	await expect(link).toHaveAttribute("target", "_blank");
	await expect(link).toHaveAttribute("rel", /noopener/);
});
