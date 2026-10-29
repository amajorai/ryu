import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	type CloudEnvironmentState,
	parseCloudEnvironmentState,
} from "@ryuhq/protocol/cloud-environments";
import { z } from "zod";
import type { CloudGithubConnection } from "../src/lib/api/cloud-github.ts";

const proofDirectory = path.resolve("../../docs/proof/cloud-environments");

test("real Core store saves and reloads published settings and sealed vault metadata", async ({
	page,
}) => {
	const core = "http://127.0.0.1:5250";
	const name = `Verified cloud ${Date.now()}`;
	const secret = `proof-secret-${Date.now()}`;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`/cloud-environments-proof.html?core=${encodeURIComponent(core)}`
	);
	await page
		.getByRole("button", { name: "Create environment", exact: true })
		.click();
	await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
	await page
		.getByRole("textbox", { name: "Install script", exact: true })
		.fill("printf 'prepared\\n'");
	await page
		.getByRole("textbox", { name: "Start instructions", exact: true })
		.fill("Use this cloud workspace for the task.");
	await page.getByRole("button", { name: "Publish", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page
		.getByRole("button", { name: "Personal vault", exact: true })
		.click();
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Key", exact: true })
		.fill("PROOF_NETWORK_SECRET");
	await page.getByLabel("Value", { exact: true }).fill(secret);
	await page
		.getByRole("combobox", { name: "Type", exact: true })
		.selectOption("networkSecret");
	await page
		.getByRole("textbox", { name: "Allowed domains", exact: true })
		.fill("api.example.com");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.reload();
	await page
		.getByRole("button", { name: "Personal vault", exact: true })
		.click();
	await expect(
		page.getByText("PROOF_NETWORK_SECRET", { exact: true })
	).toBeVisible();
	await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
	const response = await page.request.get(`${core}/api/cloud-environments`, {
		headers: {
			authorization: "Bearer proof-node-token",
			"x-ryu-user-jwt": "cloud-proof-user-identity",
		},
	});
	expect(response.ok()).toBe(true);
	const payload = await response.text();
	expect(payload).not.toContain(secret);
	const snapshot = parseCloudEnvironmentState(JSON.parse(payload));
	expect(
		snapshot.environments.some(
			(environment) => environment.name === name && environment.published
		)
	).toBe(true);
	expect(
		snapshot.vault.some(
			(entry) => entry.key === "PROOF_NETWORK_SECRET" && entry.hasValue
		)
	).toBe(true);
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-real-store-vault.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Environments", exact: true }).click();
	await expect(page.getByText(name, { exact: true })).toBeVisible();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-real-store-published.png"),
		fullPage: true,
		animations: "disabled",
	});
	expect(errors).toEqual([]);
	await writeFile(
		path.join(proofDirectory, "real-store-browser.json"),
		JSON.stringify(
			{
				scope:
					"Production settings component and real Core module/store; synthetic local test identity; no mocked API responses",
				revision: snapshot.revision,
				errors,
			},
			null,
			2
		)
	);
});

test.beforeEach(async () => {
	const manifest = z
		.record(z.string(), z.string())
		.parse(
			JSON.parse(
				await readFile(
					path.resolve(
						"../../target/cloud-environments-proof-build/source-hashes.json"
					),
					"utf8"
				)
			)
		);
	for (const [file, hash] of Object.entries(manifest)) {
		expect(
			createHash("sha256")
				.update(await readFile(path.resolve("../..", file)))
				.digest("hex"),
			`Proof build is stale for ${file}`
		).toBe(hash);
	}
	await mkdir(proofDirectory, { recursive: true });
	await writeFile(
		path.join(proofDirectory, "ui-build-inputs.json"),
		JSON.stringify(manifest, null, 2)
	);
});
interface CloudProofBrowserLog {
	consoleMessages: string[];
	errors: string[];
	requests: string[];
}

const browserLog: CloudProofBrowserLog = {
	errors: [],
	consoleMessages: [],
	requests: [],
};

test.afterEach(async ({ page }, testInfo) => {
	await mkdir(proofDirectory, { recursive: true });
	await writeFile(
		path.join(proofDirectory, "browser-log.json"),
		JSON.stringify(browserLog, null, 2)
	);
	if (testInfo.status !== testInfo.expectedStatus) {
		await page.screenshot({
			path: path.join(proofDirectory, "cloud-proof-failure.png"),
			fullPage: true,
			animations: "disabled",
		});
	}
});

test("smoke renders the real cloud settings component", async ({ page }) => {
	await mkdir(proofDirectory, { recursive: true });
	const pending = new Map<string, number>();
	const timings: { url: string; event: string; duration: number }[] = [];
	const started = Date.now();
	const errors: string[] = [];
	page.on("request", (request) => {
		pending.set(request.url(), Date.now());
		timings.push({
			url: request.url(),
			event: "request",
			duration: Date.now() - started,
		});
	});
	page.on("response", (response) => {
		const url = response.url();
		timings.push({
			url,
			event: `response ${response.status()}`,
			duration: Date.now() - (pending.get(url) ?? started),
		});
		pending.delete(url);
	});
	page.on("requestfailed", (request) => {
		errors.push(`${request.url()}: ${request.failure()?.errorText}`);
		pending.delete(request.url());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	await installFixture(page);
	const interval = setInterval(() => {
		process.stdout.write(
			`Cloud proof pending ${JSON.stringify([...pending].map(([url, time]) => ({ url, elapsed: Date.now() - time })))}\n`
		);
	}, 10_000);
	try {
		await page.goto("/cloud-environments-proof.html", {
			waitUntil: "commit",
			timeout: 180_000,
		});
		await expect(
			page.getByRole("button", { name: "Create environment", exact: true })
		).toBeVisible({ timeout: 60_000 });
		await page.screenshot({
			path: path.join(proofDirectory, "cloud-environments-smoke.png"),
			fullPage: true,
			animations: "disabled",
			timeout: 15_000,
		});
	} finally {
		clearInterval(interval);
		await writeFile(
			path.join(proofDirectory, "resource-timing.json"),
			JSON.stringify({ errors, timings, pending: [...pending] }, null, 2)
		);
		process.stdout.write(`Cloud proof errors ${JSON.stringify(errors)}\n`);
	}
});

async function installFixture(page: Page) {
	let snapshot: CloudEnvironmentState = {
		schemaVersion: 1,
		revision: 0,
		environments: [],
		vault: [],
	};
	let failSave = false;
	const requests: string[] = [];
	await page.route(
		/\/api\/cloud-environments(?:\/(?:import|shared(?:\/[^/]+\/import)?|[^/]+\/launch))?$/,
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			requests.push(`${request.method()} ${url.pathname}`);
			if (request.headers().authorization !== "Bearer cloud-proof-node-token") {
				await route.fulfill({
					status: 401,
					json: { error: "Unauthorized fixture request" },
				});
				return;
			}
			if (request.headers()["x-ryu-user-jwt"] !== "cloud-proof-user-identity") {
				await route.fulfill({
					status: 403,
					json: { error: "Missing fixture user identity" },
				});
				return;
			}
			if (url.pathname.startsWith("/alternate/")) {
				await route.fulfill({
					json: { schemaVersion: 1, revision: 0, environments: [], vault: [] },
				});
				return;
			}
			if (url.pathname.endsWith("/launch")) {
				await route.fulfill({
					status: 501,
					json: {
						error: {
							code: "cloud_environment_runtime_unsupported",
							message: "Restricted domain policies require a supported runtime",
						},
					},
				});
				return;
			}
			if (url.pathname.endsWith("/shared")) {
				const source = snapshot.environments[0];
				await route.fulfill({
					json: {
						environments: source
							? [
									{
										...source,
										id: "shared-profile",
										name: "Shared project template",
										privacy: "shared",
										published: true,
										vaultKeys: [],
										tailscaleVaultKey: null,
									},
								]
							: [],
					},
				});
				return;
			}
			if (url.pathname.endsWith("/shared/shared-profile/import")) {
				const source = snapshot.environments[0];
				if (source) {
					snapshot = {
						...snapshot,
						revision: snapshot.revision + 1,
						environments: [
							...snapshot.environments,
							{
								...source,
								id: "imported-profile",
								name: "Shared project template",
								privacy: "private",
								published: false,
								vaultKeys: [],
								tailscaleVaultKey: null,
							},
						],
					};
				}
				await route.fulfill({ json: snapshot });
				return;
			}
			if (url.pathname.endsWith("/import") && request.method() === "GET") {
				await route.fulfill({
					json: { names: ["DEMO_ACCESS_TOKEN", "DEMO_REGION"] },
				});
				return;
			}
			if (url.pathname.endsWith("/import") && request.method() === "POST") {
				const parsed = z
					.object({ keys: z.array(z.string()) })
					.safeParse(request.postDataJSON());
				if (!parsed.success) {
					await route.fulfill({
						status: 400,
						json: { error: "Invalid import" },
					});
					return;
				}
				const input = parsed.data;
				snapshot = {
					...snapshot,
					revision: snapshot.revision + 1,
					vault: [
						...snapshot.vault,
						...input.keys
							.filter((key): key is string => isNativeText(key))
							.map((key) => ({
								id: `import-${key}`,
								key,
								kind: "variable" as const,
								hasValue: true,
								domains: [],
								environmentIds: [],
							})),
					],
				};
			}
			if (request.method() === "PUT") {
				if (failSave) {
					await route.fulfill({
						status: 500,
						json: { error: "Could not save cloud settings" },
					});
					return;
				}
				const parsed = z
					.object({ vault: z.array(z.record(z.string(), z.json())) })
					.passthrough()
					.safeParse(request.postDataJSON());
				if (!parsed.success) {
					await route.fulfill({
						status: 400,
						json: { error: "Invalid fixture snapshot" },
					});
					return;
				}
				const input = parsed.data;
				const vault = input.vault.map((entry) => {
					const value = "value" in entry ? entry.value : undefined;
					const metadata = Object.fromEntries(
						Object.entries(entry).filter(([key]) => key !== "value")
					);
					return {
						...metadata,
						hasValue:
							(isNativeText(value) && value.length > 0) ||
							snapshot.vault.some(
								(saved) => saved.id === metadata.id && saved.hasValue
							),
					};
				});
				snapshot = parseCloudEnvironmentState({
					...input,
					vault,
					revision: snapshot.revision + 1,
				});
			}
			await route.fulfill({ json: snapshot });
		}
	);
	return {
		requests,
		getSnapshot: () => snapshot,
		setSnapshot: (next: CloudEnvironmentState) => {
			snapshot = parseCloudEnvironmentState(next);
		},
		setFailSave: (value: boolean) => {
			failSave = value;
		},
	};
}

test("cloud environment settings save, reload and report errors", async ({
	page,
}) => {
	await mkdir(proofDirectory, { recursive: true });
	const errors: string[] = [];
	const consoleMessages: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) =>
		consoleMessages.push(`${message.type()}: ${message.text()}`)
	);
	const fixture = await installFixture(page);
	browserLog.errors = errors;
	browserLog.consoleMessages = consoleMessages;
	browserLog.requests = fixture.requests;
	await page.goto("/cloud-environments-proof.html", {
		waitUntil: "domcontentloaded",
		timeout: 180_000,
	});
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-environments-initial-render.png"),
		fullPage: true,
		animations: "disabled",
	});
	await expect(
		page.getByRole("button", { name: "Create environment", exact: true })
	).toBeVisible();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-environments-empty.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("button", { name: "Create environment", exact: true })
		.click();
	await page
		.getByRole("textbox", { name: "Name", exact: true })
		.fill("Repository cloud setup");
	await page
		.getByRole("textbox", { name: "Repositories", exact: true })
		.fill("https://github.com/example/project.git");
	await page
		.getByRole("textbox", { name: "Install script", exact: true })
		.fill("#!/usr/bin/env bash\nprintf 'Cloud setup complete\\n'");
	await page
		.getByRole("textbox", { name: "Start instructions", exact: true })
		.fill("Use the prepared checkout and run the project's tests.");
	await page
		.getByRole("button", { name: "Manage variables", exact: true })
		.click();
	await page
		.getByRole("textbox", { name: "Key", exact: true })
		.fill("INLINE_REGION");
	await page.getByLabel("Value", { exact: true }).fill("fixture-region");
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-environment-inline-variables.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByRole("textbox", { name: "Name", exact: true })
	).toHaveValue("Repository cloud setup");
	await expect(
		page.getByRole("textbox", { name: "Install script", exact: true })
	).toHaveValue("#!/usr/bin/env bash\nprintf 'Cloud setup complete\\n'");
	expect(fixture.getSnapshot().vault).toHaveLength(0);
	await page
		.getByRole("combobox", { name: "Allowed domain policy" })
		.selectOption("custom");
	await page
		.getByRole("switch", { name: "Allow internet access", exact: true })
		.click();
	await expect(
		page.getByRole("combobox", { name: "Allowed domain policy" })
	).toBeDisabled();
	await page
		.getByRole("switch", { name: "Allow internet access", exact: true })
		.click();
	await page
		.getByRole("combobox", { name: "Allowed domain policy" })
		.selectOption("packageManagers");
	await page
		.getByRole("combobox", { name: "Allowed domain policy" })
		.selectOption("custom");
	const domains = page.getByRole("textbox", {
		name: "Additional allowed domains",
	});
	await domains.fill("api.example.com");
	await domains.press("End");
	await domains.press("Enter");
	await domains.pressSequentially("*.example.org");
	await expect(domains).toHaveValue("api.example.com\n*.example.org");
	await page.getByRole("button", { name: "Save draft", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		page.getByText("Repository cloud setup", { exact: true })
	).toBeVisible();
	await page.reload();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await expect(
		page.getByRole("textbox", { name: "Install script", exact: true })
	).toHaveValue("#!/usr/bin/env bash\nprintf 'Cloud setup complete\\n'");
	await expect(
		page.getByRole("combobox", { name: "Allowed domain policy" })
	).toHaveValue("custom");
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-environment-settings.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("combobox", { name: "Tailscale vault key" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-environment-network-and-vpn.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("button", { name: "Publish", exact: true })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-environment-editor-controls.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Publish", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(fixture.getSnapshot().environments[0]?.published).toBe(true);
	await page
		.getByRole("button", { name: "Run setup check", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText(
		"Restricted domain policies require a supported runtime"
	);
	await page
		.getByRole("button", { name: "Reload saved settings", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Personal vault", exact: true })
		.click();
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Key", exact: true })
		.fill("DEMO_API_KEY");
	await page
		.getByLabel("Value", { exact: true })
		.fill("fixture-secret-hidden-after-save");
	await page
		.getByRole("combobox", { name: "Type", exact: true })
		.selectOption("networkSecret");
	await page
		.getByRole("textbox", { name: "Allowed domains", exact: true })
		.fill("api.example.com");
	await page
		.getByRole("checkbox", { name: "Repository cloud setup", exact: true })
		.check();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByText("DEMO_API_KEY", { exact: true })).toBeVisible();
	await page
		.getByRole("combobox", { name: "Filter vault entry types" })
		.selectOption("networkSecret");
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-vault-type-filter.png"),
		fullPage: true,
		animations: "disabled",
	});
	await expect(page.getByText("INLINE_REGION", { exact: true })).toHaveCount(0);
	await page
		.getByRole("textbox", { name: "Search cloud environments and vault" })
		.fill("missing-entry");
	await expect(
		page.getByText("No matching vault entries.", { exact: true })
	).toBeVisible();
	await page
		.getByRole("textbox", { name: "Search cloud environments and vault" })
		.fill("");
	await page
		.getByRole("combobox", { name: "Filter vault entry types" })
		.selectOption("all");
	expect(JSON.stringify(fixture.getSnapshot())).not.toContain(
		"fixture-secret-hidden-after-save"
	);
	await page
		.getByRole("button", { name: "Import from node", exact: true })
		.click();
	await page
		.getByRole("checkbox", { name: "DEMO_REGION", exact: true })
		.check();
	await page
		.getByRole("button", { name: "Import selected", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByText("DEMO_REGION", { exact: true })).toBeVisible();
	await page.reload();
	await page
		.getByRole("button", { name: "Personal vault", exact: true })
		.click();
	await expect(page.getByText("DEMO_API_KEY", { exact: true })).toBeVisible();
	await page
		.getByRole("textbox", { name: "Search cloud environments and vault" })
		.fill("DEMO_API_KEY");
	await page.getByRole("button", { name: "Edit", exact: true }).first().click();
	await expect(page.getByLabel("Value", { exact: true })).toHaveValue("");
	await page
		.getByRole("textbox", { name: "Allowed domains", exact: true })
		.fill("api.example.com, auth.example.com");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(
		fixture.getSnapshot().vault.find((entry) => entry.key === "DEMO_API_KEY")
			?.hasValue
	).toBe(true);
	await page
		.getByRole("textbox", { name: "Search cloud environments and vault" })
		.fill("");
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-personal-vault.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Environments", exact: true }).click();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await page.getByRole("checkbox", { name: /DEMO_API_KEY/ }).check();
	await page.getByRole("button", { name: "Set VPN key", exact: true }).click();
	await page
		.getByLabel("Tailscale auth key", { exact: true })
		.fill("fixture-vpn-key-hidden");
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-environment-vpn-key-dialog.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Save VPN key", exact: true }).click();
	fixture.setFailSave(true);
	await page.getByRole("button", { name: "Save draft", exact: true }).click();
	await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
		"Could not save cloud settings"
	);
	await expect(page.getByRole("dialog").getByRole("alert")).toBeInViewport();
	await page.getByRole("dialog").getByRole("alert").scrollIntoViewIfNeeded();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-environment-save-error.png"),
		fullPage: true,
		animations: "disabled",
	});
	expect(fixture.getSnapshot().environments[0]?.tailscaleVaultKey).toBeNull();
	fixture.setFailSave(false);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await page
		.getByRole("button", { name: "Reload saved settings", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await page.getByRole("checkbox", { name: /DEMO_API_KEY/ }).check();
	await page.getByRole("button", { name: "Set VPN key", exact: true }).click();
	await page
		.getByLabel("Tailscale auth key", { exact: true })
		.fill("fixture-vpn-key-hidden");
	await page.getByRole("button", { name: "Save VPN key", exact: true }).click();
	await page
		.getByRole("combobox", { name: "Environment sharing" })
		.selectOption("shared");
	await page.getByRole("button", { name: "Publish", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const vpnKey = fixture.getSnapshot().environments[0]?.tailscaleVaultKey;
	expect(vpnKey).toMatch(/^CLOUD_VPN_/);
	expect(fixture.getSnapshot().environments[0]?.vaultKeys).not.toContain(
		vpnKey
	);
	expect(fixture.getSnapshot().environments[0]?.privacy).toBe("shared");
	expect(JSON.stringify(fixture.getSnapshot())).not.toContain(
		"fixture-vpn-key-hidden"
	);
	await page.reload();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "Tailscale vault key" })
	).toHaveValue(vpnKey ?? "");
	await expect(
		page.getByRole("textbox", { name: "Name", exact: true })
	).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth
		)
	).toBe(true);
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-environment-mobile.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("button", { name: "Publish", exact: true })
		.scrollIntoViewIfNeeded();
	await expect(
		page.getByRole("button", { name: "Publish", exact: true })
	).toBeInViewport();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-environment-mobile-controls.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.setViewportSize({ width: 1280, height: 900 });
	await page
		.getByRole("button", { name: "Browse shared templates", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Import template", exact: true })
		.click();
	expect(
		fixture
			.getSnapshot()
			.environments.find((entry) => entry.id === "imported-profile")
	).toMatchObject({
		privacy: "private",
		published: false,
		vaultKeys: [],
		tailscaleVaultKey: null,
	});
	await page
		.getByRole("button", { name: "Personal vault", exact: true })
		.click();
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await page.getByText("Paste .env entries", { exact: true }).click();
	await page
		.getByRole("textbox", { name: "Paste .env entries" })
		.fill("PASTED_REGION=fixture-eu\nPASTED_MODE=fixture-test");
	await page
		.getByRole("checkbox", { name: "Repository cloud setup", exact: true })
		.check();
	await page
		.getByRole("checkbox", { name: "Shared project template", exact: true })
		.check();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	const multiScope = fixture
		.getSnapshot()
		.vault.find((entry) => entry.key === "PASTED_REGION")?.environmentIds;
	expect(multiScope).toHaveLength(2);
	await page
		.getByRole("textbox", { name: "Search cloud environments and vault" })
		.fill("PASTED_REGION");
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await expect(
		page.getByRole("checkbox", { name: "Repository cloud setup", exact: true })
	).toBeChecked();
	await expect(
		page.getByRole("checkbox", { name: "Shared project template", exact: true })
	).toBeChecked();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-vault-multiple-environments.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Save", exact: true }).click();
	expect(
		fixture.getSnapshot().vault.find((entry) => entry.key === "PASTED_REGION")
			?.environmentIds
	).toEqual(multiScope);
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await expect(
		page.getByText("No matching vault entries.", { exact: true })
	).toBeVisible();
	expect(
		fixture.getSnapshot().vault.some((entry) => entry.key === "PASTED_REGION")
	).toBe(false);
	await page
		.getByRole("textbox", { name: "Search cloud environments and vault" })
		.fill("");
	await page.getByRole("button", { name: "Environments", exact: true }).click();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-environments-complete.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Edit", exact: true }).first().click();
	await page
		.getByRole("textbox", { name: "Name", exact: true })
		.fill("Unsaved previous node draft");
	await page.evaluate(() =>
		window.dispatchEvent(new Event("cloud-proof-switch-target"))
	);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		page.getByText(
			"No cloud environments yet. Create one to save your repository setup.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		page.getByText("Repository cloud setup", { exact: true })
	).toHaveCount(0);
	await writeFile(
		path.join(proofDirectory, "browser-log.json"),
		JSON.stringify(
			{ errors, consoleMessages, requests: fixture.requests },
			null,
			2
		)
	);
	expect(errors).toEqual([]);
});

test("cloud task chooser verifies GitHub, creates a repository environment and sends only its ID", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	const baseEnvironment = {
		id: "published-native",
		name: "Cloud project",
		repositories: ["fixture-owner/project"],
		installScript: "fixture-install-content",
		startInstructions: "fixture-start-content",
		internet: {
			enabled: true,
			domainPolicy: "all" as const,
			allowedDomains: [],
		},
		privacy: "private" as const,
		vaultKeys: [],
		tailscaleVaultKey: null,
		published: true,
	};
	fixture.setSnapshot({
		...fixture.getSnapshot(),
		environments: [
			baseEnvironment,
			{
				...baseEnvironment,
				id: "hidden-draft",
				name: "Unpublished draft",
				published: false,
			},
		],
	});
	let connection: CloudGithubConnection = {
		connected: false,
		login: null,
		vaultKey: null,
		repositories: [],
	};
	await page.route("**/api/cloud-environments/github", async (route) => {
		if (route.request().method() === "POST") {
			expect(route.request().postDataJSON()).toEqual({
				token: "fixture-token-verified-by-core",
				revision: fixture.getSnapshot().revision,
			});
			connection = {
				connected: true,
				login: "verified-owner",
				vaultKey: "GITHUB_TOKEN",
				repositories: [
					{ fullName: "verified-owner/private-repo", private: true },
				],
			};
			fixture.setSnapshot({
				...fixture.getSnapshot(),
				revision: fixture.getSnapshot().revision + 1,
				vault: [
					...fixture.getSnapshot().vault,
					{
						id: "github-credential",
						key: "GITHUB_TOKEN",
						kind: "networkSecret",
						domains: ["github.com", "api.github.com"],
						environmentIds: [],
						hasValue: true,
					},
				],
			});
		}
		await route.fulfill({
			json: { ...connection, state: fixture.getSnapshot() },
		});
	});
	const sent: unknown[] = [];
	await page.route("**/api/chat/stream", async (route) => {
		sent.push(route.request().postDataJSON());
		const chunks = [
			{ type: "start", messageId: "cloud-answer" },
			{ type: "text-start", id: "answer" },
			{
				type: "text-delta",
				id: "answer",
				delta: "Cloud task request accepted.",
			},
			{ type: "text-end", id: "answer" },
			{ type: "finish" },
		];
		await route.fulfill({
			headers: {
				"content-type": "text/event-stream",
				"x-vercel-ai-ui-message-stream": "v1",
			},
			body:
				chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
				"data: [DONE]\n\n",
		});
	});
	await page.goto("/cloud-environments-proof.html?task=1");
	await expect(
		page.getByRole("button", { name: "Use cloud", exact: true })
	).toBeEnabled();
	await page
		.getByRole("textbox", { name: "Task message" })
		.fill("Inspect the prepared repository.");
	await page.getByRole("button", { name: "Use cloud", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Send task", exact: true })
	).toBeDisabled();
	await page.getByRole("button", { name: "Choose cloud environment" }).click();
	await expect(
		page.getByRole("button", { name: "Unpublished draft", exact: true })
	).toHaveCount(0);
	await page
		.getByRole("textbox", { name: "Search cloud environments", exact: true })
		.fill("missing");
	await expect(
		page.getByText("No matching environments.", { exact: true })
	).toBeVisible();
	await page
		.getByRole("textbox", { name: "Search cloud environments", exact: true })
		.fill("");
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-task-environment-picker.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("button", { name: "Connect GitHub", exact: true })
		.click();
	await page
		.getByLabel("GitHub personal access token", { exact: true })
		.fill("fixture-token-verified-by-core");
	await page
		.getByRole("button", { name: "Verify and connect", exact: true })
		.click();
	await expect(
		page.getByText("Connected as verified-owner", { exact: true })
	).toBeVisible();
	await expect(
		page.getByLabel("GitHub personal access token", { exact: true })
	).toHaveValue("");
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-github-verified-repositories.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("button", { name: /verified-owner\/private-repo/ })
		.click();
	await expect(
		page.getByRole("textbox", { name: "Repositories", exact: true })
	).toHaveValue("verified-owner/private-repo");
	await expect(
		page.getByRole("checkbox", { name: "GITHUB_TOKEN", exact: true })
	).toBeChecked();
	await page.getByRole("button", { name: "Publish", exact: true }).click();
	const profile = fixture
		.getSnapshot()
		.environments.find((environment) =>
			environment.repositories.includes("verified-owner/private-repo")
		);
	expect(profile?.vaultKeys).toEqual(["GITHUB_TOKEN"]);
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await page.getByRole("button", { name: "Choose cloud environment" }).click();
	await page.getByRole("button", { name: "private-repo", exact: true }).click();
	await page
		.getByRole("combobox", { name: "Task agent" })
		.selectOption("custom-acp");
	await expect(
		page.getByRole("button", { name: "Send task", exact: true })
	).toBeDisabled();
	await expect(
		page.getByText(/Cloud tasks currently support the Ryu native agent/)
	).toBeVisible();
	await page.getByRole("combobox", { name: "Task agent" }).selectOption("ryu");
	await page.getByRole("button", { name: "Send task", exact: true }).click();
	await expect(
		page.getByText("Cloud task request accepted.", { exact: true })
	).toBeVisible();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({
		cloudEnvironmentId: profile?.id,
		agent_id: "ryu",
	});
	expect(JSON.stringify(sent[0])).not.toContain(
		"fixture-token-verified-by-core"
	);
	expect(JSON.stringify(sent[0])).not.toContain("fixture-install-content");
	expect(JSON.stringify(sent[0])).not.toContain("fixture-start-content");
	await expect(
		page.getByRole("button", { name: "Cloud", exact: true })
	).toBeDisabled();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-task-request-handoff.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("reopened cloud chat retains its immutable environment binding", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	fixture.setSnapshot({
		...fixture.getSnapshot(),
		environments: [
			{
				id: "bound-profile",
				name: "Bound project",
				repositories: [],
				installScript: "",
				startInstructions: "",
				internet: { enabled: true, domainPolicy: "all", allowedDomains: [] },
				privacy: "private",
				vaultKeys: [],
				tailscaleVaultKey: null,
				published: true,
			},
		],
	});
	await page.route(
		"**/api/cloud-environments/task-binding/existing-chat",
		(route) =>
			route.fulfill({
				json: { cloudEnvironmentId: "bound-profile", state: "completed" },
			})
	);
	await page.goto(
		"/cloud-environments-proof.html?task=1&conversation=existing-chat"
	);
	await expect(
		page.getByRole("button", { name: "Cloud", exact: true })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Choose cloud environment" })
	).toContainText("Bound project");
	await page.getByRole("button", { name: "Choose cloud environment" }).click();
	await expect(
		page.getByRole("button", { name: "Bound project", exact: true })
	).toBeDisabled();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-task-immutable-binding.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("changing the target retains cloud intent and requires a new environment choice", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	fixture.setSnapshot({
		...fixture.getSnapshot(),
		environments: [
			{
				id: "first-node-profile",
				name: "First node cloud",
				repositories: [],
				installScript: "",
				startInstructions: "",
				internet: { enabled: true, domainPolicy: "all", allowedDomains: [] },
				privacy: "private",
				vaultKeys: [],
				tailscaleVaultKey: null,
				published: true,
			},
		],
	});
	await page.goto("/cloud-environments-proof.html?task=1");
	await expect(
		page.getByRole("button", { name: "Use cloud", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Use cloud", exact: true }).click();
	await page.getByRole("button", { name: "Choose cloud environment" }).click();
	await page
		.getByRole("button", { name: "First node cloud", exact: true })
		.click();
	await page
		.getByRole("textbox", { name: "Task message" })
		.fill("Run this in the selected cloud environment.");
	await expect(
		page.getByRole("button", { name: "Send task", exact: true })
	).toBeEnabled();
	await page.evaluate(() =>
		window.dispatchEvent(new Event("cloud-proof-switch-target"))
	);
	await expect(
		page.getByRole("button", { name: "Cloud", exact: true })
	).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Choose cloud environment" })
	).toContainText("Choose environment");
	await expect(
		page.getByRole("button", { name: "Send task", exact: true })
	).toBeDisabled();
	await expect(
		page.getByText("Choose a published cloud environment before sending.", {
			exact: true,
		})
	).toBeVisible();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-task-target-switch.png"),
		fullPage: true,
		animations: "disabled",
	});
});
