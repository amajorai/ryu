import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { AppRequestValue } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";
import {
	type PluginDocument,
	pluginDocumentSchema,
} from "../src/lib/api/plugin-wire-values.ts";
import {
	type GatewaySpeechEditInput,
	gatewaySpeechEditInputSchema,
} from "../src/lib/api/speech-settings-contracts.ts";
import { sdkAccountProviders } from "./harness/sdk-accounts-fixture.ts";

const speechInputProofSchema = z.custom<
	GatewaySpeechEditInput & PluginDocument
>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		gatewaySpeechEditInputSchema.safeParse(value).success
);

test("Google Translate opt-in persists independently of Edge and Google Cloud", async ({
	page,
}) => {
	let enabled = false;
	let revision = "a".repeat(64);
	const writes: GatewaySpeechEditInput[] = [];
	const pageErrors: string[] = [];
	const requests: string[] = [];
	page.on("pageerror", (error) => {
		pageErrors.push(error.message);
		console.error("Google speech proof page error:", error.message);
	});
	page.on("requestfailed", (request) =>
		console.error(
			"Google speech proof failed request:",
			request.url(),
			request.failure()?.errorText
		)
	);
	page.on("console", (message) => {
		if (message.type() === "error") {
			console.error("Google speech proof console error:", message.text());
		}
	});
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const pathname = new URL(route.request().url()).pathname;
			requests.push(`${route.request().method()} ${pathname}`);
			let body: AppRequestValue = {};
			if (pathname === "/api/gateway/config") {
				body = {
					providers: {
						...sdkAccountProviders,
						google_tts: { mode: "supplied_oauth", account_count: 2 },
					},
					webServiceSchema: 1,
					configRevision: revision,
					appliedProviderRevision: revision,
					auth: { require_auth: true, api_keys: [] },
				};
			}
			if (pathname === "/api/gateway/web-accounts") {
				body = { webServiceSchema: 1, configRevision: revision, providers: [] };
			}
			if (pathname === "/api/gateway/cloud-speech-accounts") {
				body = {
					cloudSpeechAccountsSchema: 1,
					configRevision: revision,
					googleTts: ["1", "2"].map((id) => ({
						accountId: id.repeat(64),
						quotaProject: `voice-project-${id}`,
						expiresAtUnixSecs: null,
						policy: { name: `Voice account ${id}`, enabled: true, priority: 0 },
					})),
					polly: { region: "us-east-1", accounts: [] },
				};
			}
			if (pathname === "/api/gateway/speech-settings") {
				if (route.request().method() === "PUT") {
					const input = speechInputProofSchema.parse(
						route.request().postDataJSON()
					);
					expect(input).toEqual({
						provider: "google-translate-tts",
						anonymousConsumerOptIn: !enabled,
						expectedRevision: revision,
					});
					writes.push(input);
					enabled = !enabled;
					revision = (enabled ? "b" : "c").repeat(64);
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
								sequence: writes.length + 1,
							},
						},
					};
				} else {
					body = {
						speechSettingsSchema: 1,
						configRevision: revision,
						edgeTts: {
							provider: "edge-tts",
							anonymousConsumerOptIn: false,
							classification: "unofficial_anonymous_consumer",
							mode: "anonymous",
						},
						googleTranslateTts: {
							provider: "google-translate-tts",
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
	await page.goto("/gateway-dialog-accounts-proof.html", {
		waitUntil: "commit",
	});
	const toggle = page.getByRole("switch", {
		name: "Enable anonymous Google Translate TTS",
		exact: true,
	});
	const edge = page.getByRole("switch", {
		name: "Enable anonymous Edge TTS",
		exact: true,
	});
	const save = page.getByRole("button", {
		name: "Save speech settings",
		exact: true,
	});
	await expect(toggle).toBeVisible({ timeout: 120_000 });
	await expect(toggle).not.toBeChecked();
	await toggle.check();
	await save.click();
	await expect.poll(() => writes.length).toBe(1);
	await expect(save).toBeDisabled();
	await page.reload({ waitUntil: "commit" });
	await expect(toggle).toBeVisible({ timeout: 120_000 });
	await expect(toggle).toBeChecked();
	await expect(edge).not.toBeChecked();
	await expect(
		page.getByText("2 saved accounts · Supplied OAuth tokens and quota project")
	).toBeVisible();
	const proof = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/google-translate-speech"
	);
	await mkdir(proof, { recursive: true });
	await toggle.scrollIntoViewIfNeeded();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.screenshot({
		path: path.join(proof, "enabled.png"),
		fullPage: true,
	});
	await toggle.uncheck();
	await save.click();
	await expect.poll(() => writes.length).toBe(2);
	await expect(save).toBeDisabled();
	await page.reload({ waitUntil: "commit" });
	await expect(toggle).toBeVisible({ timeout: 120_000 });
	await expect(toggle).not.toBeChecked();
	await expect(edge).not.toBeChecked();
	await expect(
		page.getByText("2 saved accounts · Supplied OAuth tokens and quota project")
	).toBeVisible();
	expect(pageErrors).toEqual([]);
	await toggle.scrollIntoViewIfNeeded();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.screenshot({
		path: path.join(proof, "disabled.png"),
		fullPage: true,
	});
	await writeFile(
		path.join(proof, "ui-result.json"),
		JSON.stringify(
			{
				scope:
					"Production Gateway dialog with deterministic API fixture; no vendor traffic",
				passed: true,
				writes,
				requests,
				pageErrors,
				finalTranslateOptIn: enabled,
				edgeOptIn: false,
				cloudAccountCount: 2,
			},
			null,
			2
		)
	);
});
