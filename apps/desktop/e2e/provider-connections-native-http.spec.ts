import { expect, type Page, test } from "@playwright/test";
import {
	control,
	open,
	registerProviderProofHooks,
	state,
	writes,
} from "./provider-connections-native-http-support.ts";

registerProviderProofHooks();

// Saving a key needs the spending-limit acknowledgement (SpendLimitConfirm,
// already gating at 07d403e33, before Ryu Quiet): Save stays disabled until it
// is ticked.
async function confirmSpendLimit(page: Page): Promise<void> {
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	await page
		.getByRole("checkbox", {
			name: "I have set a spending limit for this key at Local model server",
		})
		.click();
}
test("real hook retries refused catalog then activates exact model and reloads current config", async ({
	page,
	request,
}) => {
	await control(request, "refuse", "GET", "/api/pi-config/catalog", 503);
	await page.goto("/provider-connections-native-http.html");
	await expect(page.getByText(/Failed to load providers:/)).toBeVisible();
	expect(writes(await state(request), "/api/pi-config")).toEqual([]);
	await control(request, "allow", "GET", "/api/pi-config/catalog");
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await open(page, "OpenRouter");
	await page.locator("#openrouter-model-custom").fill("remote-model");
	await page
		.getByRole("button", { name: "Use this provider", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "In use", exact: true })
	).toBeDisabled();
	const saved = await state(request);
	expect(
		writes(saved, "/api/pi-config").map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual([
		{
			body: {
				provider: "openrouter",
				model: "remote-model",
				thinkingLevel: null,
				api: "openai-completions",
			},
			status: 200,
		},
	]);
	expect(saved.config).toMatchObject({
		provider: "openrouter",
		model: "remote-model",
	});
	await page.reload();
	await open(page, "OpenRouter");
	await expect(page.locator("#openrouter-model-custom")).toHaveValue(
		"remote-model"
	);
	await expect(
		page.getByRole("button", { name: "In use", exact: true })
	).toBeDisabled();
});
test("custom key refusal retains draft and identical retry saves actual credential without exposing it in catalog", async ({
	page,
	request,
}) => {
	await control(request, "refuse", "POST", "/api/pi-config/providers", 503);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "Local model server");
	const key = page.locator("#key-local-model-server");
	await key.fill("synthetic-replacement-key");
	await confirmSpendLimit(page);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Could not save credential", { exact: true })
	).toBeVisible();
	await expect(key).toHaveValue("synthetic-replacement-key");
	expect((await state(request)).secrets).toEqual({});
	await control(request, "allow", "POST", "/api/pi-config/providers");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(key).toHaveValue("");
	const saved = await state(request);
	expect(saved.secrets).toEqual({
		"local-model-server": "synthetic-replacement-key",
	});
	expect(
		writes(saved, "/api/pi-config/providers").map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual(
		[503, 200].map((status) => ({
			body: {
				provider: "local-model-server",
				apiKey: "synthetic-replacement-key",
			},
			status,
		}))
	);
	expect(JSON.stringify(saved.catalog)).not.toContain(
		"synthetic-replacement-key"
	);
	await page.reload();
	await open(page, "Local model server");
	await expect(key).toHaveValue("");
	expect((await state(request)).secrets["local-model-server"]).toBe(
		"synthetic-replacement-key"
	);
});
test("held key save keeps its action disabled and retains the draft until acknowledgment", async ({
	page,
	request,
}) => {
	await control(request, "hold", "POST", "/api/pi-config/providers");
	await page.goto("/provider-connections-native-http.html");
	await open(page, "Local model server");
	await page.locator("#key-local-model-server").fill("synthetic-held-key");
	await confirmSpendLimit(page);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Saving…", exact: true })
	).toBeDisabled();
	await expect(page.locator("#key-local-model-server")).toHaveValue(
		"synthetic-held-key"
	);
	expect((await state(request)).secrets).toEqual({});
	expect(writes(await state(request), "/api/pi-config/providers")).toHaveLength(
		1
	);
	await control(request, "release", "POST", "/api/pi-config/providers");
	await expect(page.locator("#key-local-model-server")).toHaveValue("");
	expect(writes(await state(request), "/api/pi-config/providers")).toHaveLength(
		1
	);
	expect((await state(request)).secrets["local-model-server"]).toBe(
		"synthetic-held-key"
	);
});
test("routing refused write rolls back visible switch then identical retry persists and reloads", async ({
	page,
	request,
}) => {
	await control(request, "refuse", "POST", "/api/pi-config/providers", 503);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "OpenRouter");
	const toggle = page
		.getByText("Route through Gateway", { exact: true })
		.locator("..")
		.getByRole("switch");
	await expect(toggle).not.toBeChecked();
	await toggle.click();
	await expect(
		page.getByText("Could not update routing", { exact: true })
	).toBeVisible();
	await expect(toggle).not.toBeChecked();
	expect(
		(await state(request)).catalog.providers.find((p) => p.id === "openrouter")
			?.routing
	).toBe("direct");
	await control(request, "allow", "POST", "/api/pi-config/providers");
	await toggle.click();
	await expect(toggle).toBeChecked();
	await expect
		.poll(
			async () =>
				(await state(request)).catalog.providers.find(
					(p) => p.id === "openrouter"
				)?.routing
		)
		.toBe("gateway");
	expect(
		writes(await state(request), "/api/pi-config/providers").map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual(
		[503, 200].map((status) => ({
			body: { provider: "openrouter", routing: "gateway" },
			status,
		}))
	);
	await page.reload();
	await open(page, "OpenRouter");
	await expect(toggle).toBeChecked();
});
test("discovery genuine503 has visible failure and no hidden config write; retry displays acknowledged saved models", async ({
	page,
	request,
}) => {
	await control(
		request,
		"refuse",
		"POST",
		"/api/pi-config/discover-models",
		503
	);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "Local model server");
	await expect(
		page.getByText("Could not discover models", { exact: true })
	).toBeVisible();
	expect(writes(await state(request), "/api/pi-config/providers")).toEqual([]);
	await control(request, "allow", "POST", "/api/pi-config/discover-models");
	await page
		.getByRole("button", { name: "Discover models", exact: true })
		.click();
	await expect(
		page.getByText("Showing models saved from the last successful discovery.")
	).toBeVisible();
	await expect(
		page.getByRole("switch", {
			name: "Enable Local model server model local-a",
			exact: true,
		})
	).toBeVisible();
	expect(
		writes(await state(request), "/api/pi-config/discover-models").map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual(
		[503, 200].map((status) => ({
			body: { provider: "local-model-server" },
			status,
		}))
	);
});
test("individual model refusal leaves enabled state then exact retry and reload show disabled", async ({
	page,
	request,
}) => {
	await control(
		request,
		"refuse",
		"POST",
		"/api/pi-config/providers/model-enabled",
		503
	);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "OpenRouter");
	const toggle = page.getByRole("switch", {
		name: "Enable OpenRouter model remote-model",
		exact: true,
	});
	await expect(toggle).toBeChecked();
	await toggle.click();
	await expect(
		page.getByText("Could not update model", { exact: true })
	).toBeVisible();
	await expect(toggle).toBeChecked();
	expect(
		(await state(request)).catalog.providers.find((p) => p.id === "openrouter")
			?.modelOverrides
	).toBeUndefined();
	await control(
		request,
		"allow",
		"POST",
		"/api/pi-config/providers/model-enabled"
	);
	await toggle.click();
	await expect(toggle).not.toBeChecked();
	expect(
		writes(await state(request), "/api/pi-config/providers/model-enabled").map(
			(c) => ({ body: c.body, status: c.status })
		)
	).toEqual(
		[503, 200].map((status) => ({
			body: { provider: "openrouter", model: "remote-model", enabled: false },
			status,
		}))
	);
	await page.reload();
	await open(page, "OpenRouter");
	await expect(toggle).not.toBeChecked();
});
test("physical OAuth routing priority refusal retries whole policy and fresh GET after reload", async ({
	page,
	request,
}) => {
	const path = "/api/pi-config/providers/chatgpt/account-pool";
	await control(request, "refuse", "PUT", path, 503);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "ChatGPT");
	await page.getByLabel("Strategy").click();
	await page.getByRole("option", { name: "Round robin", exact: true }).click();
	await page.locator("#oauth-priority-chatgpt-b").fill("2");
	await page.getByRole("button", { name: "Save routing", exact: true }).click();
	await expect(
		page.getByText("Could not save account routing", { exact: true })
	).toBeVisible();
	expect((await state(request)).policy).toMatchObject({ strategy: "manual" });
	await control(request, "allow", "PUT", path);
	await page.getByRole("button", { name: "Save routing", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Save routing", exact: true })
	).toBeDisabled();
	const expected = {
		strategy: "round_robin",
		drainThresholdPercent: 80,
		accounts: {
			"chatgpt-a": { enabled: true, priority: 0 },
			"chatgpt-b": { enabled: true, priority: 2 },
		},
	};
	expect((await state(request)).policy).toEqual(expected);
	expect(
		writes(await state(request), path).map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual([503, 200].map((status) => ({ body: expected, status })));
	await page.reload();
	await open(page, "ChatGPT");
	await expect(page.getByLabel("Strategy")).toContainText("Round robin");
	await expect(page.locator("#oauth-priority-chatgpt-b")).toHaveValue("2");
});
