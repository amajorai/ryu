import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";

import { z } from "zod";
import type { GatewayProviderAccount } from "../src/lib/api/gateway.ts";
import { parseProofJsonRecord } from "./fixture-json.ts";

const story = "/provider-routing-regressions-proof.html";
async function fixture(page: Page) {
	const logs: unknown[] = [];
	const errors: string[] = [];
	let account = "account-a";
	let gateway: GatewayProviderAccount = {
		id: "gateway-work",
		name: "Work",
		enabled: true,
		priority: 7,
		source: "stored",
		drainThresholdPercent: null,
	};
	let oauth = {
		strategy: "fill_first",
		drainThresholdPercent: 80,
		accounts: {
			"claude-work": {
				enabled: true,
				priority: 4,
				// SAFETY: This authored null value is an existing member of the numeric-or-null fixture threshold domain.
				drainThresholdPercent: null as number | null,
			},
		},
	};
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route(/\/api\/[^?]*(?:\?.*)?$/, async (route) => {
		const request = route.request();
		const endpoint = new URL(request.url()).pathname;
		if (!endpoint.startsWith("/api/")) {
			await route.continue();
			return;
		}
		const body = request.postData()
			? parseProofJsonRecord(request.postData() ?? "{}")
			: null;
		logs.push({
			endpoint,
			method: request.method(),
			body,
			activeAccount: account,
		});
		let result: NonNullable<Parameters<typeof route.fulfill>[0]>["json"];
		if (endpoint === "/api/pi-config") {
			result = {
				config: {
					provider: "openai",
					model: null,
					routing: "direct",
					thinkingLevel: null,
					configDir: "isolated-proof",
				},
			};
		} else if (endpoint === "/api/pi-config/catalog") {
			result = {
				apiTypes: ["openai-completions"],
				thinkingLevels: [],
				providers: [
					{
						id: "openai",
						label: "OpenAI",
						api: "openai-completions",
						authKind: "api-key",
						authEnv: "",
						configured: true,
						custom: false,
						routing: "direct",
						supportsDiscovery: true,
						suggestedModels: [],
						accounts: ["account-a", "account-b"].map((id) => ({
							accountId: id,
							label: id === "account-a" ? "Personal" : "Work",
							active: id === account,
							gatewayActive: false,
							kind: "api_key",
						})),
					},
				],
			};
		} else if (endpoint === "/api/pi-config/discover-models") {
			const url = body?.baseUrl;
			const label =
				body?.provider === "openai"
					? account === "account-a"
						? "Account A model"
						: "Account B model"
					: url === "http://127.0.0.1:17100/v1"
						? "First endpoint model"
						: url === "http://127.0.0.1:17200/v1"
							? "Second endpoint model"
							: null;
			result = {
				source: "discovery",
				models: label
					? [{ id: label.toLowerCase().replaceAll(" ", "-"), name: label }]
					: [],
			};
		} else if (endpoint === "/api/models/active") {
			result = { active: "" };
		} else if (endpoint === "/api/models/installed") {
			result = { models: [] };
		} else if (endpoint === "/api/gateway/config") {
			result = { providers: { accounts: { openai: [gateway] } } };
		} else if (endpoint === "/api/gateway/providers") {
			const decodedPolicy = z
				.record(z.string(), z.json())
				.safeParse(body?.accountPolicy);
			const policy = decodedPolicy.success ? decodedPolicy.data : null;
			if (
				!(policy && "drain_threshold_percent" in policy) ||
				"drainThresholdPercent" in policy
			) {
				await route.fulfill({
					status: 400,
					json: {
						error: "Canonical accountPolicy requires drain_threshold_percent",
					},
				});
				return;
			}
			const threshold = policy.drain_threshold_percent;
			if (
				threshold !== null &&
				(!isNativeNumber(threshold) || threshold < 0 || threshold > 100)
			) {
				await route.fulfill({
					status: 400,
					json: { error: "Invalid drain threshold" },
				});
				return;
			}
			gateway = { ...gateway, drainThresholdPercent: threshold };
			result = { success: true, gateway_restarted: true };
		} else if (
			endpoint === "/api/pi-config/providers/claude-pro-max/account-pool"
		) {
			if (request.method() === "PUT") {
				const received: typeof oauth = request.postDataJSON();
				oauth = received;
			}
			result = oauth;
		} else {
			await route.fulfill({
				status: 404,
				json: { error: `Unexpected proof endpoint ${endpoint}` },
			});
			return;
		}
		await route.fulfill({ json: result });
	});
	return {
		logs,
		errors,
		switchAccount() {
			account = "account-b";
		},
	};
}
async function proof(testInfo: TestInfo, logs: unknown[], errors: string[]) {
	expect(errors).toEqual([]);
	const files = [
		"src/components/agents/RyuPiConfig.tsx",
		"src/components/agents/pi-model-discovery-key.ts",
		"src/components/gateway/GatewayProviderKeyRow.tsx",
		"src/components/settings/OAuthAccountPoolControls.tsx",
		"src/lib/api/gateway.ts",
		"src/lib/api/pi-config.ts",
	];
	const sourceHashes = await Promise.all(
		files.map(async (file) => ({
			file,
			sha256: createHash("sha256")
				.update(await readFile(path.resolve(import.meta.dirname, "..", file)))
				.digest("hex"),
		}))
	);
	await writeFile(
		testInfo.outputPath("result.json"),
		JSON.stringify(
			{
				verifiedAt: new Date().toISOString(),
				deterministicCoreApiMocks: true,
				sourceHashes,
				logs,
				errors,
			},
			null,
			2
		)
	);
}
/** Opens the Pi model picker. A model list replaces the plain model field
 * with the picker only once discovery has returned models, so wait for the
 * picker before clicking rather than clicking the field that precedes it. */
async function openModelPicker(page: Page) {
	const picker = page.locator("button#pi-model");
	await expect(picker).toBeVisible();
	await picker.click();
}

function discoveryFor(page: Page, baseUrl: string) {
	return page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/pi-config/discover-models" &&
			response.request().postDataJSON()?.baseUrl === baseUrl
	);
}

test("RyuPiConfig refetches models after the catalog account switches", async ({
	page,
}, testInfo) => {
	const state = await fixture(page);
	await page.goto(story);
	await openModelPicker(page);
	await expect(
		page.getByRole("button", { name: "Account A model", exact: true })
	).toBeVisible();
	await page.keyboard.press("Escape");
	state.switchAccount();
	const refreshedModels = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/pi-config/discover-models"
	);
	await page.evaluate(() =>
		window.dispatchEvent(new Event("proof:refresh-provider-catalog"))
	);
	await refreshedModels;
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(resolve))
	);
	await openModelPicker(page);
	await expect(
		page.getByRole("button", { name: "Account B model", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Account A model", exact: true })
	).toHaveCount(0);
	await page.screenshot({
		path: testInfo.outputPath("account-b-models.png"),
		fullPage: true,
	});
	await proof(testInfo, state.logs, state.errors);
});
test("RyuPiConfig separates discovery for one custom ID with different endpoints", async ({
	page,
}, testInfo) => {
	const state = await fixture(page);
	await page.goto(story);
	await page.locator("#pi-provider").click();
	await page.getByRole("option", { name: /Custom \(OpenAI/ }).click();
	await page.keyboard.press("Escape");
	await page.getByLabel("Provider id", { exact: true }).fill("local-proof");
	const firstDiscovery = discoveryFor(page, "http://127.0.0.1:17100/v1");
	await page
		.getByLabel("Base URL", { exact: true })
		.fill("http://127.0.0.1:17100/v1");
	await firstDiscovery;
	await openModelPicker(page);
	await expect(
		page.getByRole("button", { name: "First endpoint model", exact: true })
	).toBeVisible();
	await page.keyboard.press("Escape");
	const secondDiscovery = discoveryFor(page, "http://127.0.0.1:17200/v1");
	await page
		.getByLabel("Base URL", { exact: true })
		.fill("http://127.0.0.1:17200/v1");
	await secondDiscovery;
	await openModelPicker(page);
	await expect(
		page.getByRole("button", { name: "Second endpoint model", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "First endpoint model", exact: true })
	).toHaveCount(0);
	await page.screenshot({
		path: testInfo.outputPath("custom-endpoint-models.png"),
		fullPage: true,
	});
	await proof(testInfo, state.logs, state.errors);
});
test("production account controls save zero and clear overrides without replacing priorities", async ({
	page,
}, testInfo) => {
	const state = await fixture(page);
	await page.goto(story);
	const gateway = page.getByRole("region", { name: "Gateway accounts" });
	const override = gateway.getByRole("spinbutton", {
		name: "OpenAI Work drain override",
	});
	await expect(override).toHaveValue("");
	await override.fill("0");
	await gateway.getByRole("button", { name: /Save/ }).click();
	await expect(gateway.getByRole("button", { name: /Save/ })).toBeDisabled();
	await page.reload();
	await expect(override).toHaveValue("0");
	await expect(
		gateway.getByRole("spinbutton", { name: "OpenAI Work priority" })
	).toHaveValue("7");
	await override.fill("");
	await gateway.getByRole("button", { name: /Save/ }).click();
	await expect(gateway.getByRole("button", { name: /Save/ })).toBeDisabled();
	const oauth = page.getByRole("region", { name: "Claude account routing" });
	const oauthOverride = oauth.getByRole("spinbutton", {
		name: "Drain override for Work Claude on claude-pro-max",
	});
	await oauthOverride.fill("0");
	await oauth.getByRole("button", { name: "Save routing" }).click();
	await expect(
		oauth.getByRole("button", { name: "Save routing" })
	).toBeDisabled();
	await page.reload();
	await expect(oauthOverride).toHaveValue("0");
	await expect(page.locator("#oauth-priority-claude-work")).toHaveValue("4");
	await oauthOverride.fill("");
	await oauth.getByRole("button", { name: "Save routing" }).click();
	await expect(
		oauth.getByRole("button", { name: "Save routing" })
	).toBeDisabled();
	await page.reload();
	await expect(override).toHaveValue("");
	await expect(oauthOverride).toHaveValue("");
	await page.screenshot({
		path: testInfo.outputPath("drain-inheritance-final.png"),
		fullPage: true,
	});
	await proof(testInfo, state.logs, state.errors);
});
