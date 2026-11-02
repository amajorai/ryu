import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { AppRequestValue } from "@ryuhq/core-client/app-request-json";
import type { GatewayProvidersConfig } from "../src/lib/api/gateway.ts";
import {
	type PluginDocument,
	pluginDocumentSchema,
} from "../src/lib/api/plugin-wire-values.ts";
import { sdkAccountProviders } from "./harness/sdk-accounts-fixture.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
function evidencePath(ledgerPath: string): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	return override
		? path.join(override, ledgerPath)
		: proofEvidencePath(ledgerPath);
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
	const replace = page.getByRole("button", {
		name: "Replace credential",
		exact: true,
	});
	await confirmSpendLimit(page, "Groq", replace);
	await replace.click();
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
	const replace = page.getByRole("button", {
		name: "Replace credential",
		exact: true,
	});
	await confirmSpendLimit(page, "Groq", replace);
	await replace.click();
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
