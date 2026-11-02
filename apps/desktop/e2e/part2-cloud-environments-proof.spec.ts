// Continues cloud-environments-proof.spec.ts (split under the file token limit); helpers live in cloud-environments-proof.helpers.ts.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	browserLog,
	installFixture,
	proofDirectory,
} from "./cloud-environments-proof.helpers.ts";

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
