// Continues gateway-model-mapping-proof.spec.ts (split under the file token limit); helpers live in gateway-model-mapping-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	configWrites,
	gatewayConfigRequests,
	readProofState,
	screenshotPath,
} from "./gateway-model-mapping-proof.helpers.ts";

test.describe.configure({ timeout: 60_000 });

test("read-only permission disables add, edit, and remove without sending writes", async ({
	page,
}) => {
	await page.goto("/gateway-model-mapping-proof.html?readOnly=true");
	await expect(
		page.getByText("friendly-code-model", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Add mapping" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Edit mapping for friendly-code-model" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Remove mapping for friendly-code-model" })
	).toBeDisabled();
	await expect(
		page.getByRole("combobox", { name: "Default provider" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Move up" }).nth(1)
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Move down" }).first()
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Remove openai from fallback chain" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Remove local from fallback chain" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "OpenRouter", exact: true })
	).toBeDisabled();
	const proof = await readProofState(page);
	expect(configWrites(proof)).toHaveLength(0);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-routing-read-only-controls"),
	});

	await page.goto("/gateway-model-mapping-proof.html?unreachable=true");
	await expect(page.getByText(/Gateway unreachable/)).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Add mapping" })
	).toBeDisabled();
	const unreachable = await readProofState(page);
	expect(gatewayConfigRequests(unreachable)).toEqual([]);
});

test("keeps provider-dependent routing controls disabled until a provider is configured", async ({
	page,
}) => {
	await page.goto("/gateway-model-mapping-proof.html?noProviders=true");
	await expect(
		page.getByRole("combobox", { name: "Default provider" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Add mapping", exact: true })
	).toBeDisabled();
	const proof = await readProofState(page);
	expect(configWrites(proof)).toHaveLength(0);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-routing-no-configured-providers"),
	});
});

test("retries a failed initial Gateway config read", async ({ page }) => {
	await page.goto("/gateway-model-mapping-proof.html?failRead=true");
	await expect(page.getByRole("alert")).toContainText(
		"/api/gateway/config failed: 503"
	);
	await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(
		page.getByText("friendly-code-model", { exact: true })
	).toBeVisible();
	const proof = await readProofState(page);
	expect(
		proof.requests.filter(
			(request) =>
				request.path.endsWith("/api/gateway/config") && request.method === "GET"
		)
	).toHaveLength(2);
	expect(configWrites(proof)).toHaveLength(0);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-model-mapping-config-read-retried"),
	});
});
