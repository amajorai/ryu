import { expect, type Page, test } from "@playwright/test";
import type { GatewayIntegrationsProofState } from "./harness/gateway-integrations-settings-proof.mock.ts";

declare global {
	interface Window {
		__GATEWAY_INTEGRATIONS_PROOF__?: GatewayIntegrationsProofState;
		__GATEWAY_INTEGRATIONS_STORES__?: {
			openSettings: () => void;
			snapshot: () => {
				gatewayOpen: boolean;
				gatewaySection: string;
				settingsOpen: boolean;
			};
		};
	}
}

const evidence = (name: string) => test.info().outputPath(name);

async function openProof(page: Page, query = ""): Promise<void> {
	await page.goto(`/gateway-integrations-settings-proof.html${query}`);
	await expect(page.locator("header h1")).toHaveText("Integrations");
	await expect(page.locator("#hf-token")).toHaveValue("hf-existing-token");
	await expect(page.locator("#aa-key")).toHaveValue("aa-existing-key");
}

async function proofState(page: Page): Promise<GatewayIntegrationsProofState> {
	const state = await page.evaluate(
		() => window.__GATEWAY_INTEGRATIONS_PROOF__
	);
	if (!state) {
		throw new Error("Gateway Integrations fixtures were not installed");
	}
	return state;
}

test("loads saved credentials, live mode and ingress choices, including own-relay setup", async ({
	page,
}) => {
	await openProof(page);
	await expect(
		page.getByRole("textbox", { name: "Hugging Face access token" })
	).toHaveValue("hf-existing-token");
	await expect(
		page.getByRole("textbox", { name: "Artificial Analysis API key" })
	).toHaveValue("aa-existing-key");
	await expect(page.locator("#aa-realtime")).not.toBeChecked();
	await expect(
		page.getByRole("heading", { name: "Webhook ingress" })
	).toBeVisible();
	await expect(page.locator("#ingress-url")).toHaveValue("");
	await expect(
		page.getByRole("button", { name: "Save", exact: true }).last()
	).toBeDisabled();
	await expect(
		page.getByRole("link", { name: /huggingface\.co\/settings\/tokens/u })
	).toHaveAttribute("target", "_blank");
	await expect(
		page.getByRole("link", { name: /artificialanalysis\.ai\/api-reference/u })
	).toHaveAttribute("href", "https://artificialanalysis.ai/api-reference");
	await expect(
		page.getByRole("link", { name: "platform.composio.dev" })
	).toHaveAttribute("href", "https://platform.composio.dev");
	await page.screenshot({
		path: evidence("gateway-integrations-loaded.png"),
		fullPage: true,
	});
});

test("saves trimmed Hugging Face and Artificial Analysis keys and clears an optional key", async ({
	page,
}) => {
	await openProof(page);
	const hfToken = page.getByRole("textbox", {
		name: "Hugging Face access token",
	});
	const aaKey = page.getByRole("textbox", {
		name: "Artificial Analysis API key",
	});
	await hfToken.fill("  hf_new_token  ");
	await page.getByRole("button", { name: "Save", exact: true }).nth(0).click();
	await expect(
		page.getByText("Hugging Face token saved", { exact: true })
	).toBeVisible();
	await expect(hfToken).toHaveValue("hf_new_token");
	await aaKey.fill("  aa_new_key  ");
	await page.getByRole("button", { name: "Save", exact: true }).nth(1).click();
	await expect(
		page.getByText("Artificial Analysis key saved", { exact: true })
	).toBeVisible();
	await hfToken.fill("");
	await page.getByRole("button", { name: "Save", exact: true }).nth(0).click();
	const state = await proofState(page);
	expect(state.preferences).toMatchObject({
		"aa-api-key": "aa_new_key",
		"hf-token": "",
	});
	expect(
		state.calls
			.filter((call) => call.method === "PUT")
			.map((call) => ({ path: call.path, body: call.body }))
	).toEqual([
		{ path: "/api/preferences/hf-token", body: { value: "hf_new_token" } },
		{ path: "/api/preferences/aa-api-key", body: { value: "aa_new_key" } },
		{ path: "/api/preferences/hf-token", body: { value: "" } },
	]);
});

test("keeps credential saves retryable after Core rejects a preference write", async ({
	page,
}) => {
	await openProof(page);
	await page.evaluate(() => {
		const state = window.__GATEWAY_INTEGRATIONS_PROOF__;
		if (!state) {
			throw new Error("Gateway Integrations fixtures were not installed");
		}
		state.failures["PUT /api/preferences/hf-token"] = {
			message: "Preference store is locked",
			remaining: 1,
			status: 500,
		};
	});
	const hfToken = page.getByRole("textbox", {
		name: "Hugging Face access token",
	});
	await hfToken.fill("hf_retry_token");
	const save = page.getByRole("button", { name: "Save", exact: true }).first();
	await save.click();
	await expect(
		page.getByText("Failed to save Hugging Face token", { exact: true })
	).toBeVisible();
	await expect(save).toBeEnabled();
	await expect(hfToken).toHaveValue("hf_retry_token");
	await expect(
		page.getByRole("button", { name: /Failed to save Hugging Face token/u })
	).toHaveCSS("opacity", "1");
	await page.screenshot({
		path: evidence("gateway-integrations-credential-save-error.png"),
		fullPage: true,
	});
	await save.click();
	await expect(
		page.getByText("Hugging Face token saved", { exact: true })
	).toBeVisible();
	expect((await proofState(page)).preferences["hf-token"]).toBe(
		"hf_retry_token"
	);
	await page.evaluate(() => {
		const state = window.__GATEWAY_INTEGRATIONS_PROOF__;
		if (!state) {
			throw new Error("Gateway Integrations fixtures were not installed");
		}
		state.failures["PUT /api/preferences/aa-api-key"] = {
			message: "Preference store is locked",
			remaining: 1,
			status: 500,
		};
	});
	const aaKey = page.getByRole("textbox", {
		name: "Artificial Analysis API key",
	});
	const saveAa = page.getByRole("button", { name: "Save", exact: true }).nth(1);
	await aaKey.fill("aa_retry_key");
	await saveAa.click();
	await expect(
		page.getByText("Failed to save Artificial Analysis key", { exact: true })
	).toBeVisible();
	await expect(saveAa).toBeEnabled();
	await saveAa.click();
	await expect(
		page.getByText("Artificial Analysis key saved", { exact: true })
	).toBeVisible();
	expect((await proofState(page)).preferences["aa-api-key"]).toBe(
		"aa_retry_key"
	);
});

test("rolls back the live-data switch after a rejected write and persists a successful retry", async ({
	page,
}) => {
	await openProof(page);
	await page.evaluate(() => {
		const state = window.__GATEWAY_INTEGRATIONS_PROOF__;
		if (!state) {
			throw new Error("Gateway Integrations fixtures were not installed");
		}
		state.failures["PUT /api/preferences/aa-mode"] = {
			message: "Rate-limited preference write",
			remaining: 1,
			status: 429,
		};
	});
	const live = page.getByRole("switch", {
		name: "Use live Artificial Analysis data",
	});
	await live.click();
	await expect(
		page.getByText("Failed to update data mode", { exact: true })
	).toBeVisible();
	await expect(live).not.toBeChecked();
	await live.click();
	await expect(
		page.getByText("Using live Artificial Analysis data", { exact: true })
	).toBeVisible();
	await expect(live).toBeChecked();
	expect((await proofState(page)).preferences["aa-mode"]).toBe("realtime");
	expect(
		(await proofState(page)).calls
			.filter(
				(call) =>
					call.method === "PUT" && call.path === "/api/preferences/aa-mode"
			)
			.map((call) => call.body)
	).toEqual([{ value: "realtime" }, { value: "realtime" }]);
});

test("selects an ingress backend with exact payload and restores the previous choice on rejection", async ({
	page,
}) => {
	await openProof(page, "?backend=tailscale-funnel");
	const backend = page.getByRole("combobox");
	await expect(backend).toContainText("Tailscale Funnel");
	await backend.click();
	for (const name of [
		"Ryu Relay (managed) (default)",
		"Tailscale Funnel",
		"Cloudflare Tunnel",
		"Self-hosted relay",
	]) {
		await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
	}
	await page.evaluate(() => {
		const state = window.__GATEWAY_INTEGRATIONS_PROOF__;
		if (!state) {
			throw new Error("Gateway Integrations fixtures were not installed");
		}
		state.failures["POST /api/webhook-ingress/backend"] = {
			message: "RYU_WEBHOOK_INGRESS_URL pins ingress to Self-hosted relay.",
			remaining: 1,
			status: 409,
		};
	});
	await page
		.getByRole("option", { name: "Cloudflare Tunnel", exact: true })
		.click();
	await expect(
		page.getByText("Failed to set ingress backend", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText(
			"RYU_WEBHOOK_INGRESS_URL pins ingress to Self-hosted relay.",
			{
				exact: true,
			}
		)
	).toBeVisible();
	await expect(backend).toContainText("Tailscale Funnel");
	expect((await proofState(page)).ingress.backend).toBe("tailscale-funnel");
	await page.screenshot({
		path: evidence("gateway-integrations-ingress-conflict.png"),
		fullPage: true,
	});
	await backend.click();
	await page
		.getByRole("option", { name: "Cloudflare Tunnel", exact: true })
		.click();
	await expect(backend).toContainText("Cloudflare Tunnel");
	expect((await proofState(page)).ingress.backend).toBe("cloudflared");
	expect(
		(await proofState(page)).calls
			.filter(
				(call) =>
					call.method === "POST" && call.path === "/api/webhook-ingress/backend"
			)
			.map((call) => ({ method: call.method, body: call.body }))
	).toEqual([
		{ method: "POST", body: { backend: "cloudflared" } },
		{ method: "POST", body: { backend: "cloudflared" } },
	]);
});

test("saves the trimmed public relay URL before selecting own-relay", async ({
	page,
}) => {
	await openProof(page);
	const url = page.getByRole("textbox", {
		name: "Self-hosted relay public URL",
	});
	const save = page.getByRole("button", { name: "Save", exact: true }).last();
	await url.fill("  https://ryu.example.com  ");
	await expect(page.getByText(/Not saved yet/u)).toBeVisible();
	await expect(save).toBeEnabled();
	await save.click();
	await expect(
		page.getByText("Public URL saved", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Public URL saved/u })
	).toHaveCSS("opacity", "1");
	await expect(url).toHaveValue("https://ryu.example.com");
	await expect(save).toBeDisabled();
	expect((await proofState(page)).preferences["webhook.ingress.url"]).toBe(
		"https://ryu.example.com"
	);
	const savedCall = (await proofState(page)).calls.find(
		(call) =>
			call.method === "PUT" &&
			call.path === "/api/preferences/webhook.ingress.url"
	);
	expect(savedCall).toMatchObject({
		body: { value: "https://ryu.example.com" },
	});
	await page.screenshot({
		path: evidence("gateway-integrations-own-relay-url-saved.png"),
		fullPage: true,
	});

	const backend = page.getByRole("combobox");
	await backend.click();
	await page
		.getByRole("option", { name: "Self-hosted relay", exact: true })
		.click();
	await expect(backend).toContainText("Self-hosted relay");
	expect((await proofState(page)).ingress.backend).toBe("own-relay");
});

test("leaves a failed public-URL save dirty and retryable", async ({
	page,
}) => {
	await openProof(page);
	await page.evaluate(() => {
		const state = window.__GATEWAY_INTEGRATIONS_PROOF__;
		if (!state) {
			throw new Error("Gateway Integrations fixtures were not installed");
		}
		state.failures["PUT /api/preferences/webhook.ingress.url"] = {
			message: "Preference store is locked",
			remaining: 1,
			status: 500,
		};
	});
	const url = page.getByRole("textbox", {
		name: "Self-hosted relay public URL",
	});
	const save = page.getByRole("button", { name: "Save", exact: true }).last();
	await url.fill("https://retry.example.com");
	await save.click();
	await expect(
		page.getByText("Failed to save the public URL", { exact: true })
	).toBeVisible();
	await expect(save).toBeEnabled();
	await expect(url).toHaveValue("https://retry.example.com");
	await save.click();
	await expect(
		page.getByText("Public URL saved", { exact: true })
	).toBeVisible();
	expect((await proofState(page)).preferences["webhook.ingress.url"]).toBe(
		"https://retry.example.com"
	);
});

test("hides ingress controls when talking to an older Core without webhook ingress", async ({
	page,
}) => {
	await openProof(page, "?oldCore");
	await expect(
		page.getByRole("heading", { name: "Webhook ingress" })
	).toHaveCount(0);
	await expect(page.locator("#ingress-url")).toHaveCount(0);
	await expect(
		page.getByRole("textbox", { name: "Hugging Face access token" })
	).toBeVisible();
});

test("opens Gateway API keys and Marketplace, closing the large settings host", async ({
	page,
}) => {
	await openProof(page);
	await page.evaluate(() =>
		window.__GATEWAY_INTEGRATIONS_STORES__?.openSettings()
	);
	await page
		.getByRole("button", { name: "Open Gateway keys", exact: true })
		.click();
	let stores = await page.evaluate(() =>
		window.__GATEWAY_INTEGRATIONS_STORES__?.snapshot()
	);
	expect(stores).toMatchObject({
		gatewayOpen: true,
		gatewaySection: "keys",
		settingsOpen: false,
	});

	await page.goto("/gateway-integrations-settings-proof.html");
	await expect(page.locator("#hf-token")).toHaveValue("hf-existing-token");
	await page
		.getByRole("button", { name: "Open Marketplace", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Marketplace proof route" })
	).toBeVisible();
	stores = await page.evaluate(() =>
		window.__GATEWAY_INTEGRATIONS_STORES__?.snapshot()
	);
	expect(stores).toMatchObject({ gatewayOpen: false, settingsOpen: false });
});
