import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

const compatible = [
	{ id: "huggingface", label: "Hugging Face" },
	{ id: "mistral", label: "Mistral" },
	{ id: "nvidia", label: "NVIDIA NIM" },
	{ id: "together", label: "Together AI" },
	{ id: "fireworks", label: "Fireworks AI" },
];
const id = (provider: string, account: string) =>
	createHash("sha256").update(`${provider}:${account}`).digest("hex");

test("selected production provider UI preserves catalog, named-account writes, picker identity, and rename readback", async ({
	page,
}, testInfo) => {
	let revision = "a".repeat(64);
	const writes: unknown[] = [];
	const errors: string[] = [];
	let label = "Personal";
	let activeAccount = "account-one";
	const accounts = Object.fromEntries(
		compatible.map((provider) => [
			provider.id,
			[
				{
					id: id(provider.id, "primary"),
					name: "Primary",
					enabled: true,
					priority: 0,
					source: "stored",
					drainThresholdPercent: null,
				},
				{
					id: id(provider.id, "work"),
					name: "Work",
					enabled: true,
					priority: 7,
					source: "stored",
					drainThresholdPercent: null,
				},
			],
		])
	);
	const providers = {
		compatible: Object.fromEntries(
			compatible.map((provider) => [
				provider.id,
				{
					api_key: "***",
					api_key_count: 2,
					base_url: "https://example.invalid/v1",
				},
			])
		),
		accounts,
		genai: { keys: [], sdk_providers: [] },
	};
	const catalog = () => ({
		apiTypes: ["openai-completions"],
		thinkingLevels: [],
		providers: [
			{
				id: "custom/service",
				label: "Local model service",
				api: "openai-completions",
				authKind: "api-key",
				authEnv: "",
				configured: true,
				custom: true,
				routing: "direct",
				supportsDiscovery: true,
				suggestedModels: [],
				accounts: [
					{
						accountId: "account-one",
						label,
						active: activeAccount === "account-one",
						gatewayActive: false,
						kind: "api_key",
					},
					{
						accountId: "account-two",
						label: "Backup",
						active: activeAccount === "account-two",
						gatewayActive: false,
						kind: "api_key",
					},
				],
			},
		],
	});
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const endpoint = new URL(request.url()).pathname;
			const body = request.postData() ? request.postDataJSON() : null;
			let output: NonNullable<Parameters<typeof route.fulfill>[0]>["json"] = {};
			if (endpoint === "/api/gateway/config") {
				output = {
					providers,
					configRevision: revision,
					auth: { require_auth: true, api_keys: [] },
					routing: {
						default: "nvidia",
						fallback_chain: [],
						model_map: {},
						modality_map: {},
					},
				};
			} else if (endpoint === "/api/gateway/providers") {
				writes.push({ endpoint, method: request.method(), body });
				if (
					body?.account_action === "add" &&
					body.provider === "nvidia" &&
					body.expectedRevision === revision &&
					body.api_key === "synthetic-provider-proof-key"
				) {
					accounts.nvidia.push({
						id: id("nvidia", "added"),
						name: "Added account",
						enabled: true,
						priority: 8,
						source: "stored",
						drainThresholdPercent: null,
					});
					providers.compatible.nvidia.api_key_count = 3;
					revision = "c".repeat(64);
					await route.fulfill({
						json: {
							success: true,
							configRevision: revision,
							gateway_application: {
								status: "applied",
								requestedRevision: revision,
								appliedRevision: revision,
							},
						},
					});
					return;
				}
				const policy = body?.accountPolicy;
				if (
					body?.expectedRevision !== revision ||
					!policy ||
					!("drain_threshold_percent" in policy) ||
					"drainThresholdPercent" in policy
				) {
					await route.fulfill({
						status: 400,
						json: { error: "Revision and canonical policy required" },
					});
					return;
				}
				const row = accounts[body.provider]?.find(
					(account) => account.id === body.accountId
				);
				if (!row) {
					await route.fulfill({
						status: 404,
						json: { error: "Unknown selected account" },
					});
					return;
				}
				Object.assign(row, {
					name: policy.name,
					enabled: policy.enabled,
					priority: policy.priority,
					drainThresholdPercent: policy.drain_threshold_percent,
				});
				revision = "b".repeat(64);
				output = {
					success: true,
					configRevision: revision,
					gateway_application: {
						status: "applied",
						requestedRevision: revision,
						appliedRevision: revision,
					},
				};
			} else if (endpoint === "/api/pi-config/catalog") {
				output = catalog();
			} else if (endpoint === "/api/pi-config") {
				output = {
					config: {
						provider: "custom/service",
						model: null,
						routing: "direct",
						thinkingLevel: null,
						configDir: "isolated-proof",
					},
				};
			} else if (
				endpoint === "/api/pi-config/providers/custom%2Fservice/accounts/rename"
			) {
				writes.push({ endpoint, method: request.method(), body });
				if (
					request.method() !== "POST" ||
					body?.accountId !== "account-one" ||
					!isNativeText(body?.label)
				) {
					await route.fulfill({
						status: 400,
						json: { error: "Account identity and label required" },
					});
					return;
				}
				label = body.label;
				output = catalog();
			} else if (
				endpoint === "/api/pi-config/providers/custom%2Fservice/accounts/switch"
			) {
				writes.push({ endpoint, method: request.method(), body });
				if (body?.accountId !== "account-two" || body.target !== "self") {
					await route.fulfill({
						status: 400,
						json: { error: "Saved account and target required" },
					});
					return;
				}
				activeAccount = body.accountId;
				output = catalog();
			} else if (endpoint === "/api/apps") {
				output = { apps: [] };
			} else if (endpoint === "/api/gateway/web-accounts") {
				output = {
					webServiceSchema: 1,
					configRevision: revision,
					providers: [],
				};
			} else if (endpoint === "/api/gateway/cloud-speech-accounts") {
				output = {
					cloudSpeechAccountsSchema: 1,
					configRevision: revision,
					google: [],
					polly: [],
				};
			} else if (endpoint === "/api/gateway/speech-settings") {
				output = {
					speechSettingsSchema: 1,
					configRevision: revision,
					edgeTts: { anonymousConsumerOptIn: false },
					googleTranslateTts: { anonymousConsumerOptIn: false },
				};
			}
			await route.fulfill({ json: output });
		}
	);
	await page.goto("/provider-ui-contract-repair.html");
	for (const provider of compatible) {
		await expect(
			page.getByRole("textbox", {
				name: `${provider.label} Work name`,
				exact: true,
			})
		).toBeVisible();
		await expect(
			page.getByRole("textbox", {
				name: `${provider.label} Primary name`,
				exact: true,
			})
		).toBeVisible();
	}
	const name = page.getByRole("textbox", {
		name: "NVIDIA NIM Work name",
		exact: true,
	});
	const row = name.locator("xpath=../..");
	await name.fill("Saved Work");
	await page
		.getByRole("spinbutton", { name: "NVIDIA NIM Work priority", exact: true })
		.fill("3");
	await page
		.getByRole("spinbutton", {
			name: "NVIDIA NIM Work drain override",
			exact: true,
		})
		.fill("0");
	await row.getByRole("button", { name: "Save account", exact: true }).click();
	await expect(
		page.getByRole("textbox", {
			name: "NVIDIA NIM Saved Work name",
			exact: true,
		})
	).toHaveValue("Saved Work");
	expect(writes[0]).toEqual({
		endpoint: "/api/gateway/providers",
		method: "PUT",
		body: {
			provider: "nvidia",
			account_action: "configure",
			expectedRevision: "a".repeat(64),
			accountId: id("nvidia", "work"),
			accountPolicy: {
				name: "Saved Work",
				enabled: true,
				priority: 3,
				drain_threshold_percent: 0,
			},
		},
	});
	await page.reload();
	const keyInput = page.getByLabel("NVIDIA NIM API key", { exact: true });
	await expect(keyInput).toHaveAttribute("type", "password");
	await keyInput.fill("synthetic-provider-proof-key");
	await keyInput
		.locator('xpath=ancestor::*[@data-slot="item"][1]')
		.getByRole("button", { name: "Add account", exact: true })
		.click();
	await expect(
		page.getByRole("textbox", {
			name: "NVIDIA NIM Added account name",
			exact: true,
		})
	).toBeVisible();
	await expect(keyInput).toHaveValue("");
	expect(writes.at(-1)).toEqual({
		endpoint: "/api/gateway/providers",
		method: "PUT",
		body: {
			provider: "nvidia",
			api_key: "synthetic-provider-proof-key",
			account_action: "add",
			expectedRevision: "b".repeat(64),
		},
	});
	await page.reload();
	await expect(
		page.getByRole("textbox", {
			name: "NVIDIA NIM Added account name",
			exact: true,
		})
	).toHaveValue("Added account");
	expect(accounts.nvidia.at(-1)?.id).toBe(id("nvidia", "added"));
	await expect(
		page.getByRole("spinbutton", {
			name: "NVIDIA NIM Saved Work drain override",
			exact: true,
		})
	).toHaveValue("0");
	await page
		.getByRole("textbox", { name: "NVIDIA NIM Saved Work name", exact: true })
		.evaluate((element) => element.scrollIntoView({ block: "center" }));
	await page.screenshot({
		path: testInfo.outputPath("gateway-named-account.png"),
		fullPage: true,
	});
	await page.goto("/provider-ui-contract-repair.html?panel=routing");
	await page.getByRole("button", { name: "Add mapping", exact: true }).click();
	await page.locator("#mapping-provider").click();
	for (const provider of compatible) {
		await expect(
			page.getByRole("option", { name: provider.label, exact: true })
		).toBeVisible();
	}
	await page.getByRole("option", { name: "NVIDIA NIM", exact: true }).click();
	await expect(page.locator("#mapping-provider")).toContainText("NVIDIA NIM");
	await page.keyboard.press("Escape");
	await page.goto("/provider-ui-contract-repair.html?panel=rename");
	await page
		.getByRole("button", { name: "Choose saved account", exact: true })
		.click();
	await page.getByRole("option", { name: /Backup/ }).click();
	await page.getByRole("option", { name: /^Use for yourself/ }).click();
	await expect
		.poll(() => writes.at(-1))
		.toEqual({
			endpoint: "/api/pi-config/providers/custom%2Fservice/accounts/switch",
			method: "POST",
			body: { accountId: "account-two", target: "self" },
		});
	await page
		.getByRole("button", { name: "Choose saved account", exact: true })
		.click();
	await expect(page.getByRole("option", { name: /Backup/ })).toHaveAttribute(
		"data-checked",
		"true"
	);
	await page
		.getByRole("button", { name: "Rename account Personal", exact: true })
		.click();
	await page
		.getByRole("textbox", { name: "Label for Personal", exact: true })
		.fill("Work account");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Work account", { exact: true })).toBeVisible();
	expect(writes.at(-1)).toEqual({
		endpoint: "/api/pi-config/providers/custom%2Fservice/accounts/rename",
		method: "POST",
		body: { accountId: "account-one", label: "Work account" },
	});
	await page.screenshot({
		path: testInfo.outputPath("renamed-account.png"),
		fullPage: true,
	});
	await page.reload();
	await page
		.getByRole("button", { name: "Choose saved account", exact: true })
		.click();
	await expect(page.getByText("Work account", { exact: true })).toBeVisible();
	await expect(page.getByRole("option", { name: /Backup/ })).toHaveAttribute(
		"data-checked",
		"true"
	);
	expect(errors).toEqual([]);
	const sources = JSON.parse(
		await readFile(
			path.resolve(
				import.meta.dirname,
				"../../../docs/proof/provider-ui-contract-repair/selected-source-hashes.json"
			),
			"utf8"
		)
	);
	await writeFile(
		testInfo.outputPath("result.json"),
		JSON.stringify(
			{
				passed: true,
				mockHttp: true,
				selectedSources: sources,
				writes,
				errors,
				keyMaterial:
					"synthetic disposable add credential; UI masked and cleared",
			},
			null,
			2
		)
	);
});
