import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { AppRequestValue } from "@ryuhq/core-client/app-request-json";
import type { GatewayProvidersConfig } from "../src/lib/api/gateway.ts";
import {
	type PluginDocument,
	pluginDocumentSchema,
} from "../src/lib/api/plugin-wire-values.ts";
import {
	accountRoutingInputSchema,
	clientKeyInputSchema,
	cloudSpeechInputSchema,
} from "./gateway-account-proof.contracts.ts";
import { sdkAccountProviders } from "./harness/sdk-accounts-fixture.ts";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
function evidencePath(ledgerPath: string): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	return override
		? path.join(override, ledgerPath)
		: path.resolve(import.meta.dirname, "../../../docs/proof", ledgerPath);
}

test("account routing selector saves quota-first and fill-first", async ({
	page,
}) => {
	let strategy = "round_robin";
	let drainThreshold = 80;
	const writes: PluginDocument[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const pathname = new URL(route.request().url()).pathname;
			if (pathname === "/api/gateway/config") {
				if (route.request().method() === "PUT") {
					const patch = accountRoutingInputSchema.parse(
						route.request().postDataJSON()
					);
					writes.push(patch);
					if (patch.providerAccountStrategies) {
						strategy = patch.providerAccountStrategies.openai;
					}
					if (patch.providerAccountDrainThresholds) {
						drainThreshold = patch.providerAccountDrainThresholds.openai;
					}
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({ ok: true }),
					});
					return;
				}
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						providers: {
							...sdkAccountProviders,
							openai: {
								api_key: "***",
								api_key_count: 2,
								base_url: "https://api.openai.com/v1",
							},
							accounts: {
								openai: [
									{
										id: "a".repeat(64),
										name: "Primary",
										enabled: true,
										priority: 0,
										source: "stored",
									},
									{
										id: "b".repeat(64),
										name: "Backup",
										enabled: true,
										priority: 1,
										source: "stored",
									},
								],
							},
							accountStrategies: { openai: strategy },
							accountDrainThresholds: { openai: drainThreshold },
						},
						configRevision: "a".repeat(64),
						auth: { require_auth: true, api_keys: [] },
					}),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: "{}",
			});
		}
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	await page.locator("#openai-account-strategy").click();
	await page.getByRole("option", { name: "Quota first" }).click();
	await expect.poll(() => writes.length).toBe(1);
	expect(writes[0]?.providerAccountStrategies).toEqual({
		openai: "quota_first",
	});
	await expect(page.locator("#openai-account-strategy")).toContainText(
		"Quota first"
	);
	await expect(
		page.getByText(/lowest observed rate-limit usage/)
	).toBeVisible();
	await page.locator("#openai-account-strategy").evaluate((element) => {
		element.scrollIntoView({ block: "center", behavior: "instant" });
	});
	const proof = evidencePath("account-routing/account-routing-quota-first.png");
	await mkdir(path.dirname(proof), { recursive: true });
	await page.screenshot({ path: proof, fullPage: true });
	await page.locator("#openai-account-strategy").click();
	await page.getByRole("option", { name: "Fill first" }).click();
	await expect.poll(() => writes.length).toBe(2);
	expect(writes[1]?.providerAccountStrategies).toEqual({
		openai: "fill_first",
	});
	await expect(page.locator("#openai-account-strategy")).toContainText(
		"Fill first"
	);
	await expect(
		page.getByText(/until its observed rate-limit usage reaches/)
	).toBeVisible();
	await page.keyboard.press("Escape");
	await page.getByLabel("Drain at used quota (%)").fill("65");
	const saveThreshold = page
		.locator("#openai-drain-threshold")
		.locator("xpath=../..")
		.getByRole("button", { name: "Save" });
	await saveThreshold.click();
	await expect.poll(() => writes.length).toBe(3);
	expect(writes[2]?.providerAccountDrainThresholds).toEqual({ openai: 65 });
	await expect(page.getByLabel("Drain at used quota (%)")).toHaveValue("65");
	await expect(saveThreshold).toBeEnabled();
	await page.locator("#openai-drain-threshold").evaluate((element) => {
		element.scrollIntoView({ block: "center", behavior: "instant" });
	});
	await page.screenshot({
		path: path.join(
			path.dirname(proof),
			"account-routing-fill-first-threshold.png"
		),
		fullPage: true,
	});
});

test("cloud speech accounts can be configured and removed without returning credentials", async ({
	page,
}) => {
	let revision = "a".repeat(64);
	const google: {
		accountId: string;
		quotaProject: string;
		expiresAtUnixSecs: number | null;
		policy: { name: string; enabled: boolean; priority: number };
	}[] = [];
	const polly: {
		accountId: string;
		accessKeyHint: string;
		hasSessionToken: boolean;
		expiresAtUnixSecs: number | null;
		policy: { name: string; enabled: boolean; priority: number };
	}[] = [];
	const writes: PluginDocument[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const pathname = new URL(route.request().url()).pathname;
			let body: AppRequestValue = {};
			if (pathname === "/api/gateway/config") {
				body = {
					providers: {
						...sdkAccountProviders,
						google_tts: google.length
							? { mode: "supplied_oauth", account_count: google.length }
							: null,
						polly: polly.length
							? {
									mode: "explicit_aws",
									account_count: polly.length,
									region: "us-east-1",
								}
							: null,
					},
					configRevision: revision,
					webServiceSchema: 1,
					auth: { require_auth: true, api_keys: [] },
				};
			}
			if (pathname === "/api/gateway/speech-settings") {
				body = {
					speechSettingsSchema: 1,
					configRevision: revision,
					edgeTts: {
						provider: "edge-tts",
						anonymousConsumerOptIn: false,
						classification: "unofficial_anonymous_consumer",
						mode: "anonymous",
					},
				};
			}
			if (pathname === "/api/gateway/web-accounts") {
				body = { webServiceSchema: 1, configRevision: revision, providers: [] };
			}
			if (pathname === "/api/gateway/cloud-speech-accounts") {
				if (route.request().method() === "PUT") {
					const input = cloudSpeechInputSchema.parse(
						route.request().postDataJSON()
					);
					writes.push(input);
					expect(input.expectedRevision).toBe(revision);
					if (input.action === "add" && input.provider === "google-tts") {
						google.push({
							accountId: "c".repeat(64),
							quotaProject: String(input.quotaProject),
							expiresAtUnixSecs: null,
							policy: { name: "", enabled: true, priority: 0 },
						});
					}
					if (input.action === "add" && input.provider === "polly") {
						polly.push({
							accountId: "d".repeat(64),
							accessKeyHint: String(input.accessKeyId).slice(0, 4),
							hasSessionToken: false,
							expiresAtUnixSecs: null,
							policy: { name: "", enabled: true, priority: 0 },
						});
					}
					if (input.action === "configure") {
						const rows = input.provider === "google-tts" ? google : polly;
						const row = rows.find(
							(candidate) => candidate.accountId === input.accountId
						);
						if (row) {
							row.policy = input.accountPolicy;
						}
					}
					if (input.action === "remove" && input.provider === "google-tts") {
						google.splice(0, google.length);
					}
					if (input.action === "remove" && input.provider === "polly") {
						polly.splice(0, polly.length);
					}
					revision = writes.length.toString(16).repeat(64);
					body = {
						success: true,
						persisted: true,
						configRevision: revision,
						gateway_application: {
							status: "applied",
							requestedRevision: revision,
							appliedRevision: revision,
							epoch: {
								boot: "00000000-0000-4000-8000-000000000001",
								sequence: writes.length,
							},
						},
					};
				} else {
					body = {
						cloudSpeechAccountsSchema: 1,
						configRevision: revision,
						googleTts: google,
						polly: { region: "us-east-1", accounts: polly },
					};
				}
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		}
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	await page.getByLabel("OAuth access token").fill("synthetic-google-token");
	await page.getByLabel("Quota project").fill("example-project");
	await page.getByRole("button", { name: "Add Google account" }).click();
	await expect(page.getByText("Google · example-project")).toBeVisible();
	await expect(page.getByLabel("OAuth access token")).toHaveValue("");
	await expect(
		page.getByText("Saved and applied to new requests.")
	).toBeVisible();
	await page
		.getByText("Google · example-project")
		.locator("..")
		.getByRole("button", { name: "Routing" })
		.click();
	await page
		.getByLabel("Google · example-project account name")
		.fill("Backup voice");
	await page.getByLabel("Google · example-project priority").fill("3");
	await page.getByLabel("Google · example-project enabled").click();
	await page.getByRole("button", { name: "Save routing" }).click();
	await expect
		.poll(() => google[0]?.policy)
		.toEqual({ name: "Backup voice", enabled: false, priority: 3 });
	await page.getByRole("button", { name: "Amazon Polly" }).click();
	await page.getByLabel("Access key ID").fill("AKIA1234567890123456");
	await page.getByLabel("Secret access key").fill("synthetic-secret-key-1234");
	await page.getByRole("button", { name: "Add Polly account" }).click();
	await expect(page.getByText("Polly · AKIA•••• · us-east-1")).toBeVisible();
	await page.screenshot({
		path: evidencePath("speech-accounts-live/editor.png"),
		fullPage: true,
	});
	await page
		.getByText("Polly · AKIA•••• · us-east-1")
		.locator("..")
		.getByRole("button", { name: "Remove" })
		.click();
	await expect(page.getByText("Polly · AKIA•••• · us-east-1")).toHaveCount(0);
	expect(writes.map((write) => write.action)).toEqual([
		"add",
		"configure",
		"add",
		"remove",
	]);
	expect(JSON.stringify(google)).not.toContain("synthetic-google-token");
	expect(JSON.stringify(polly)).not.toContain("synthetic-secret-key-1234");
});

test("anonymous speech toggle saves the viewed revision and requires live application", async ({
	page,
}) => {
	const initial = "a".repeat(64);
	const applied = "b".repeat(64);
	let revision = initial;
	let enabled = false;
	const writes: PluginDocument[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const url = new URL(route.request().url());
			let body: AppRequestValue = {};
			if (url.pathname === "/api/gateway/config") {
				body = {
					providers: {
						...sdkAccountProviders,
						google_tts: { mode: "supplied_oauth", account_count: 2 },
						polly: {
							mode: "explicit_aws",
							account_count: 1,
							region: "us-east-1",
						},
					},
					webServiceSchema: 1,
					configRevision: revision,
					appliedProviderRevision: revision,
					auth: { require_auth: true, api_keys: [] },
				};
			}
			if (url.pathname === "/api/gateway/speech-settings") {
				if (route.request().method() === "PUT") {
					const input = pluginDocumentSchema.parse(
						route.request().postDataJSON()
					);
					writes.push(input);
					expect(input).toEqual({
						anonymousConsumerOptIn: true,
						expectedRevision: initial,
					});
					enabled = true;
					revision = applied;
					body = {
						success: true,
						persisted: true,
						gateway_restarted: false,
						configRevision: applied,
						gateway_application: {
							status: "applied",
							requestedRevision: applied,
							appliedRevision: applied,
							epoch: {
								boot: "00000000-0000-4000-8000-000000000001",
								sequence: 2,
							},
						},
					};
				} else {
					body = {
						speechSettingsSchema: 1,
						configRevision: revision,
						edgeTts: {
							provider: "edge-tts",
							anonymousConsumerOptIn: enabled,
							classification: "unofficial_anonymous_consumer",
							mode: "anonymous",
						},
					};
				}
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		}
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	const toggle = page.getByRole("switch", {
		name: "Enable anonymous Edge TTS",
		exact: true,
	});
	await expect(toggle).not.toBeChecked();
	await expect(
		page.getByRole("heading", { name: "Cloud speech connections" })
	).toBeVisible();
	await expect(
		page.getByText("2 saved accounts · Supplied OAuth tokens and quota project")
	).toBeVisible();
	await expect(
		page.getByText("1 saved account · Explicit AWS credentials · us-east-1")
	).toBeVisible();
	await toggle.check();
	await page
		.getByRole("button", { name: "Save speech settings", exact: true })
		.click();
	await expect.poll(() => writes.length).toBe(1);
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: "Saved and applied to new requests." })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Save speech settings", exact: true })
	).toBeDisabled();
	await page.reload();
	await expect(toggle).toBeChecked();
});

test("new web service key grants are explicit and absent on legacy nodes", async ({
	page,
}) => {
	let webServiceSchema: number | undefined = 1;
	let keyEntries: {
		key: string;
		name: string;
		trusted_forwarder: boolean;
		allowed_operations?: string[];
	}[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const url = new URL(route.request().url());
			let body: AppRequestValue = {};
			if (url.pathname === "/api/gateway/config") {
				if (route.request().method() === "PUT") {
					keyEntries = clientKeyInputSchema.parse(
						route.request().postDataJSON()
					).auth.api_keys;
					body = { ok: true, persisted: true };
				} else {
					body = {
						providers: sdkAccountProviders,
						webServiceSchema,
						configRevision: "a".repeat(64),
						auth: {
							require_auth: true,
							api_keys: keyEntries.map((entry) => ({ ...entry, key: "***" })),
						},
					};
				}
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		}
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	const inference = page.getByRole("checkbox", {
		name: "LLM, embeddings & media",
		exact: true,
	});
	await expect(inference).toBeChecked();
	await expect(
		page.getByRole("checkbox", { name: "Web search", exact: true })
	).not.toBeChecked();
	await expect(
		page.getByRole("checkbox", { name: "Web fetch", exact: true })
	).not.toBeChecked();
	await inference.uncheck();
	await page.getByLabel("Key name", { exact: true }).fill("web-only");
	await expect(
		page.getByRole("button", { name: "Create key", exact: true })
	).toBeDisabled();
	await page.getByRole("checkbox", { name: "Web search", exact: true }).check();
	await page.screenshot({
		path: evidencePath("sdk-accounts/gateway-web-key-grants.png"),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Create key", exact: true }).click();
	await expect.poll(() => keyEntries.length).toBe(1);
	expect(keyEntries[0].allowed_operations).toEqual(["web_search"]);
	expect(keyEntries[0].trusted_forwarder).toBe(false);
	await page
		.getByLabel("Gateway model ID", { exact: true })
		.fill("model-for-cli");
	await expect(
		page.getByRole("button", { name: "Apply", exact: true }).first()
	).toBeDisabled();
	webServiceSchema = undefined;
	await page.reload();
	await expect(page.getByLabel("Key name", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "Web search", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("checkbox", { name: "Web fetch", exact: true })
	).toHaveCount(0);
});

test("native backup replacement uses the stored account ID and preserves the primary", async ({
	page,
}) => {
	const providers: GatewayProvidersConfig & AppRequestValue =
		structuredClone(sdkAccountProviders);
	providers.openai = {
		api_key: "***",
		api_key_count: 2,
		base_url: "https://api.openai.com/v1",
	};
	providers.accounts ??= {};
	providers.accounts.openai = [
		{
			id: "d".repeat(64),
			name: "Primary",
			source: "stored",
			enabled: true,
			priority: 0,
		},
		{
			id: "e".repeat(64),
			name: "Backup",
			source: "stored",
			enabled: true,
			priority: 1,
		},
	];
	const writes: PluginDocument[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const url = new URL(route.request().url());
			let body: AppRequestValue = {};
			if (url.pathname === "/api/gateway/config") {
				body = {
					providers,
					configRevision: "a".repeat(64),
					auth: { api_keys: [], require_auth: true },
				};
			}
			if (url.pathname === "/api/gateway/providers") {
				writes.push(pluginDocumentSchema.parse(route.request().postDataJSON()));
				body = {
					success: true,
					persisted: true,
					configRevision: "a".repeat(64),
					gateway_restarted: false,
					gateway_application: {
						status: "applied",
						requestedRevision: "a".repeat(64),
						appliedRevision: "a".repeat(64),
						epoch: {
							boot: "00000000-0000-4000-8000-000000000001",
							sequence: 2,
						},
					},
				};
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		}
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	const field = page.getByLabel("OpenAI Backup replacement credential", {
		exact: true,
	});
	await field.fill("synthetic-backup-replacement");
	await field
		.locator("..")
		.getByRole("button", { name: "Replace credential", exact: true })
		.click();
	await expect(field).toHaveValue("");
	await expect(
		page.getByLabel("OpenAI Primary name", { exact: true })
	).toHaveValue("Primary");
	expect(writes).toEqual([
		{
			provider: "openai",
			account_action: "replace",
			accountId: "e".repeat(64),
			api_key: "synthetic-backup-replacement",
			expectedRevision: "a".repeat(64),
		},
	]);
});

test("API keys page creates and revokes local client keys separately from provider credentials", async ({
	page,
}) => {
	let keys: { key: string; name: string; trusted_forwarder: boolean }[] = [];
	const writes: PluginDocument[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const url = new URL(route.request().url());
			let body: AppRequestValue = {};
			if (url.pathname === "/api/gateway/config") {
				if (route.request().method() === "PUT") {
					const write = clientKeyInputSchema.parse(
						route.request().postDataJSON()
					);
					writes.push(write);
					keys = write.auth.api_keys;
					body = { ok: true, persisted: true, configRevision: "a".repeat(64) };
				} else {
					body = {
						providers: sdkAccountProviders,
						configRevision: "a".repeat(64),
						appliedProviderRevision: "a".repeat(64),
						auth: {
							api_keys: keys.map((key) => ({ ...key, key: "***" })),
							require_auth: true,
						},
					};
				}
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		}
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	await expect(
		page.getByText("Gateway client API keys", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Connect a local CLI", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Manage in web", exact: true })
	).toHaveCount(0);
	await page.getByLabel("Key name", { exact: true }).fill("test-editor");
	await page.getByRole("button", { name: "Create key", exact: true }).click();
	await expect(
		page.getByText("Copy your key now", { exact: true })
	).toBeVisible();
	await expect.poll(() => keys.length).toBe(1);
	expect(keys[0].name).toBe("test-editor");
	expect(keys[0].trusted_forwarder).toBe(false);
	expect(keys[0].key.length).toBeGreaterThan(32);
	expect(writes[0]).toMatchObject({ expectedRevision: "a".repeat(64) });
	expect(writes[0]).not.toHaveProperty("providers");
	await page.reload();
	await expect(page.getByText("test-editor", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Copy your key now", { exact: true })
	).toHaveCount(0);
	await expect(page.getByText("••••••••", { exact: true })).toBeVisible();
	await page.screenshot({
		path: evidencePath("sdk-accounts/gateway-local-client-keys.png"),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Revoke", exact: true }).click();
	await expect.poll(() => keys.length).toBe(0);
	expect(writes).toHaveLength(2);
	expect(writes[1]).toMatchObject({ auth: { api_keys: [] } });
});

test("saved connection application retries the latest revision without sending credentials", async ({
	page,
}) => {
	let revision = "a".repeat(64);
	let appliedRevision = "b".repeat(64);
	const applications: PluginDocument[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const url = new URL(route.request().url());
			let body: AppRequestValue = {};
			if (url.pathname === "/api/gateway/config") {
				body = {
					providers: sdkAccountProviders,
					configRevision: revision,
					appliedProviderRevision: appliedRevision,
					auth: { api_keys: [], require_auth: true },
				};
			}
			if (url.pathname === "/api/gateway/providers/apply") {
				applications.push(
					pluginDocumentSchema.parse(route.request().postDataJSON())
				);
				if (applications.length === 1) {
					revision = "c".repeat(64);
					body = {
						success: true,
						persisted: false,
						configRevision: "a".repeat(64),
						gateway_restarted: false,
						gateway_application: {
							status: "superseded",
							requestedRevision: "a".repeat(64),
							currentRevision: revision,
						},
					};
				} else {
					appliedRevision = revision;
					body = {
						success: true,
						persisted: true,
						configRevision: revision,
						gateway_restarted: false,
						gateway_application: {
							status: "applied",
							requestedRevision: revision,
							appliedRevision,
							epoch: {
								boot: "00000000-0000-4000-8000-000000000001",
								sequence: 3,
							},
						},
					};
				}
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		}
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	await page
		.getByLabel("Groq Personal replacement credential")
		.fill("synthetic-unsaved-draft");
	await page
		.getByRole("button", { name: "Apply saved connections", exact: true })
		.click();
	await expect(
		page.getByRole("alert").filter({ hasText: "The saved revision changed." })
	).toHaveText(
		"The saved revision changed. Refresh and apply the latest saved connections."
	);
	await page
		.getByRole("button", { name: "Apply saved connections", exact: true })
		.click();
	await expect(
		page.getByText("Saved provider settings are active.", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Apply saved connections", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByLabel("Groq Personal replacement credential")
	).toHaveValue("synthetic-unsaved-draft");
	expect(applications).toEqual([
		{ revision: "a".repeat(64) },
		{ revision: "c".repeat(64) },
	]);
	await page
		.getByText("Saved provider settings are active.", { exact: true })
		.evaluate((element) => element.scrollIntoView({ block: "center" }));
	await page.screenshot({
		path: evidencePath("sdk-accounts/gateway-apply-retry.png"),
		fullPage: true,
	});
});

test("an unreachable status poll keeps unsaved account drafts and refetches on recovery", async ({
	page,
}) => {
	let reads = 0;
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const url = new URL(route.request().url());
			let body: AppRequestValue = {};
			if (url.pathname === "/api/gateway/config") {
				reads += 1;
				body = {
					providers: sdkAccountProviders,
					configRevision: "a".repeat(64),
					appliedProviderRevision: "b".repeat(64),
					auth: { api_keys: [], require_auth: true },
				};
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		}
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	const credential = page.getByLabel("Groq Personal replacement credential");
	const priority = page.getByLabel("Groq Personal priority");
	const apply = page.getByRole("button", {
		name: "Apply saved connections",
		exact: true,
	});
	await credential.fill("synthetic-unsaved-draft");
	await priority.fill("7");
	await expect(apply).toBeEnabled();
	const readsBeforeOutage = reads;
	await page.evaluate(() =>
		window.__gatewayDialogAccountsProof?.setReachable(false)
	);
	await expect(apply).toBeDisabled();
	await expect(credential).toHaveValue("synthetic-unsaved-draft");
	await expect(priority).toHaveValue("7");
	expect(reads).toBe(readsBeforeOutage);
	await page.evaluate(() =>
		window.__gatewayDialogAccountsProof?.setReachable(true)
	);
	await expect(apply).toBeEnabled();
	await expect.poll(() => reads).toBeGreaterThan(readsBeforeOutage);
	await expect(credential).toHaveValue("synthetic-unsaved-draft");
	await expect(priority).toHaveValue("7");
});

test("fleet credentials have no local credential writers", async ({ page }) => {
	const providers: GatewayProvidersConfig & AppRequestValue =
		structuredClone(sdkAccountProviders);
	const fleetAccount = providers.accounts?.["genai-groq"]?.[1];
	if (!fleetAccount) {
		throw new Error("Fleet test requires the external account fixture");
	}
	fleetAccount.source = "fleet";
	fleetAccount.name = "Fleet";
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		(route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(
					new URL(route.request().url()).pathname === "/api/gateway/config"
						? {
								providers,
								configRevision: "f".repeat(64),
								auth: { api_keys: [], require_auth: true },
							}
						: {}
				),
			})
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	await expect(page.getByLabel("Groq API key", { exact: true })).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Remove Groq Fleet" })
	).toBeDisabled();
	await expect(
		page.getByLabel("Groq Fleet replacement credential")
	).toHaveCount(0);
	await expect(
		page.getByText("Credential supplied by the fleet.", { exact: false })
	).toBeVisible();
});

test("Gateway dialog loads account connections on opening and carries the viewed revision", async ({
	page,
}) => {
	const errors: string[] = [];
	const writes: PluginDocument[] = [];
	let reads = 0;
	let externalEdit = false;
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const url = new URL(route.request().url());
			if (url.pathname === "/api/gateway/config") {
				reads += 1;
				const providers = structuredClone(sdkAccountProviders);
				if (externalEdit && providers.accounts?.["genai-groq"]?.[0]) {
					providers.accounts["genai-groq"][0].priority = 1;
				}
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						providers,
						configRevision: (externalEdit ? "d" : "c").repeat(64),
						auth: { api_keys: [], require_auth: true },
					}),
				});
			}
			if (url.pathname === "/api/gateway/providers") {
				writes.push(pluginDocumentSchema.parse(route.request().postDataJSON()));
				externalEdit = true;
				return route.fulfill({
					status: 409,
					contentType: "application/json",
					body: JSON.stringify({
						error: "Gateway configuration changed; refresh before saving",
						code: "config_revision_conflict",
					}),
				});
			}
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: "{}",
			});
		}
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	await expect(
		page.getByRole("heading", { name: "Additional provider connections" })
	)
		.toBeVisible({ timeout: 30_000 })
		.catch((cause) => {
			expect(errors).toEqual([]);
			throw cause;
		});
	await page
		.getByLabel("Groq Personal replacement credential")
		.fill("synthetic-replacement");
	await page
		.getByRole("button", { name: "Replace credential", exact: true })
		.click();
	await expect.poll(() => writes.length).toBe(1);
	expect(writes[0]).toMatchObject({
		expectedRevision: "c".repeat(64),
		accountId: "a".repeat(64),
	});
	await expect(
		page.getByText("Gateway configuration changed; refresh before saving", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByLabel("Groq Personal replacement credential")
	).toHaveValue("synthetic-replacement");
	const previousReads = reads;
	await page
		.getByRole("button", { name: "Refresh accounts", exact: true })
		.click();
	await expect.poll(() => reads).toBeGreaterThan(previousReads);
	await expect(page.getByLabel("Groq Personal priority")).toHaveValue("1");
	await expect(
		page.getByLabel("Groq Personal replacement credential")
	).toHaveValue("synthetic-replacement");
	await page
		.getByRole("button", { name: "Replace credential", exact: true })
		.click();
	await expect.poll(() => writes.length).toBe(2);
	expect(writes[1]).toMatchObject({ expectedRevision: "d".repeat(64) });
	expect(errors).toEqual([]);
	await page
		.getByText("Gateway configuration changed; refresh before saving", {
			exact: true,
		})
		.locator("..")
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: evidencePath("sdk-accounts/gateway-dialog.png"),
		fullPage: true,
	});
});

test("Gateway dialog accepts a live receipt without a restart", async ({
	page,
}) => {
	const revision = "e".repeat(64);
	let applied = false;
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const url = new URL(route.request().url());
			let body: AppRequestValue = {};
			if (url.pathname === "/api/gateway/config") {
				body = {
					providers: sdkAccountProviders,
					configRevision: revision,
					auth: { api_keys: [], require_auth: true },
				};
			}
			if (url.pathname === "/api/gateway/providers") {
				expect(route.request().postDataJSON()).toMatchObject({
					expectedRevision: revision,
					account_action: "replace",
				});
				applied = true;
				body = {
					success: true,
					persisted: true,
					configRevision: revision,
					gateway_restarted: false,
					gateway_application: {
						status: "applied",
						requestedRevision: revision,
						appliedRevision: revision,
						epoch: {
							boot: "00000000-0000-4000-8000-000000000001",
							sequence: 2,
						},
					},
				};
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		}
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	const credential = page.getByLabel("Groq Personal replacement credential");
	await credential.fill("synthetic-replacement");
	await page
		.getByRole("button", { name: "Replace credential", exact: true })
		.click();
	await expect.poll(() => applied).toBe(true);
	await expect(credential).toHaveValue("");
	await expect(
		page.getByText("Connection saved, but Gateway restart did not finish.", {
			exact: false,
		})
	).toHaveCount(0);
	await credential.evaluate((element) =>
		element.scrollIntoView({ block: "center" })
	);
	await page.screenshot({
		path: evidencePath("sdk-accounts/gateway-live-application.png"),
		fullPage: true,
	});
});
