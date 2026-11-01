import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { AppRequestValue } from "@ryuhq/core-client/app-request-json";
import type { GatewayProvidersConfig } from "../src/lib/api/gateway.ts";
import {
	type PluginDocument,
	pluginDocumentSchema,
} from "../src/lib/api/plugin-wire-values.ts";
import { clientKeyInputSchema } from "./gateway-account-proof.contracts.ts";
import { sdkAccountProviders } from "./harness/sdk-accounts-fixture.ts";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
function evidencePath(ledgerPath: string): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	return override
		? path.join(override, ledgerPath)
		: path.resolve(import.meta.dirname, "../../../docs/proof", ledgerPath);
}

// Replacing a credential needs the spending-limit acknowledgement
// (SpendLimitConfirm, already gating at 07d403e33, before Ryu Quiet): the button stays disabled until it is ticked.
async function confirmSpendLimit(
	page: Page,
	providerLabel: string,
	replace: Locator
): Promise<void> {
	await expect(replace).toBeDisabled();
	await page
		.getByRole("checkbox", {
			name: `I have set a spending limit for this key at ${providerLabel}`,
		})
		.click();
	await expect(replace).toBeEnabled();
}

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
	const replace = field
		.locator("..")
		.getByRole("button", { name: "Replace credential", exact: true });
	await confirmSpendLimit(page, "OpenAI", replace);
	await replace.click();
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
