import path from "node:path";
import { expect, test } from "@playwright/test";

const evidence = (name: string) =>
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence",
		name
	);

test("rejects a partial URL/token pair without sending either write", async ({
	page,
}) => {
	await page.goto("/managed-inference-settings-proof.html");
	const fleetUrl = page.getByLabel("Fleet URL");
	const save = page.getByRole("button", { name: "Save", exact: true });
	await expect(fleetUrl).toBeVisible();
	await expect(save).toBeEnabled();
	await fleetUrl.fill("https://fleet.customer.example");
	await save.click();
	await expect(page.getByText("Both fields are required")).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.__managedInferenceProof.writes))
		.toEqual([]);
	await page.screenshot({
		animations: "disabled",
		path: evidence("gateway-managed-inference-validation.png"),
		fullPage: true,
	});
});

test("saves both values and reloads the active managed inference configuration", async ({
	page,
}) => {
	await page.goto("/managed-inference-settings-proof.html");
	const fleetUrl = page.getByLabel("Fleet URL");
	const token = page.getByLabel("Organization token");
	const save = page.getByRole("button", { name: "Save", exact: true });
	await expect(save).toBeEnabled();
	await fleetUrl.fill(" https://fleet.customer.example ");
	await token.fill(" rgw_customer_token ");
	await save.click();
	await expect(page.getByText("Managed inference connected")).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: evidence("gateway-managed-inference-connected.png"),
		fullPage: true,
	});
	await expect
		.poll(() => page.evaluate(() => window.__managedInferenceProof.writes))
		.toEqual([
			{ key: "managed-gateway-url", value: "https://fleet.customer.example" },
			{ key: "managed-gateway-token", value: "rgw_customer_token" },
		]);
	await page.reload();
	await expect(page.getByLabel("Fleet URL")).toHaveValue(
		"https://fleet.customer.example"
	);
	await expect(page.getByLabel("Organization token")).toHaveValue(
		"rgw_customer_token"
	);
});

test("clears both saved values to return to the local gateway", async ({
	page,
}) => {
	await page.goto("/managed-inference-settings-proof.html?configured=true");
	const fleetUrl = page.getByLabel("Fleet URL");
	const token = page.getByLabel("Organization token");
	const save = page.getByRole("button", { name: "Save", exact: true });
	await expect(fleetUrl).toHaveValue("https://fleet.example.test");
	await expect(token).toHaveValue("rgw_existing_token");
	await fleetUrl.fill("");
	await token.fill("");
	await save.click();
	await expect(page.getByText("Managed inference disconnected")).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.__managedInferenceProof.writes))
		.toEqual([
			{ key: "managed-gateway-url", value: "" },
			{ key: "managed-gateway-token", value: "" },
		]);
	await page.reload();
	await expect(page.getByLabel("Fleet URL")).toHaveValue("");
	await expect(page.getByLabel("Organization token")).toHaveValue("");
});

test("recovers from a partial preference failure and retries both writes", async ({
	page,
}) => {
	await page.goto(
		"/managed-inference-settings-proof.html?configured=true&failKey=managed-gateway-token"
	);
	const fleetUrl = page.getByLabel("Fleet URL");
	const token = page.getByLabel("Organization token");
	const save = page.getByRole("button", { name: "Save", exact: true });
	await fleetUrl.fill("https://fleet.retry.example");
	await token.fill("rgw_retry_token");
	await save.click();
	await expect(page.getByText("Failed to save")).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: evidence("gateway-managed-inference-write-error.png"),
		fullPage: true,
	});
	await expect(save).toBeEnabled();
	await expect(fleetUrl).toHaveValue("https://fleet.retry.example");
	await expect(token).toHaveValue("rgw_retry_token");
	await expect
		.poll(() => page.evaluate(() => window.__managedInferenceProof.writes))
		.toEqual([
			{ key: "managed-gateway-url", value: "https://fleet.retry.example" },
			{ key: "managed-gateway-token", value: "rgw_retry_token" },
		]);
	await page.evaluate(() => {
		window.__managedInferenceProof.failPreferenceKey = null;
	});
	await save.click();
	await expect(page.getByText("Managed inference connected")).toBeVisible();
	await page.reload();
	await expect(page.getByLabel("Fleet URL")).toHaveValue(
		"https://fleet.retry.example"
	);
	await expect(page.getByLabel("Organization token")).toHaveValue(
		"rgw_retry_token"
	);
});

test("retains active configuration when rollout discovery is switched off", async ({
	page,
}) => {
	await page.goto(
		"/managed-inference-settings-proof.html?flag=false&configured=true"
	);
	await expect(
		page.getByRole("heading", { name: "Managed inference", exact: true })
	).toBeVisible();
	await expect(page.getByLabel("Fleet URL")).toHaveValue(
		"https://fleet.example.test"
	);
	await expect(page.getByLabel("Organization token")).toHaveValue(
		"rgw_existing_token"
	);

	await page.goto("/managed-inference-settings-proof.html?flag=false");
	await page.evaluate(() => {
		localStorage.removeItem("managed-inference-settings-proof.preferences");
	});
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Managed inference", exact: true })
	).toHaveCount(0);
});
