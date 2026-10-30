import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const evidence = (name: string) =>
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence",
		name
	);

const providers = [
	{ key: "sk-openai-test", label: "OpenAI", slug: "openai" },
	{ key: "sk-ant-test", label: "Anthropic", slug: "anthropic" },
	{ key: "sk-or-test", label: "OpenRouter", slug: "openrouter" },
	{ key: "AIza-test", label: "Gemini", slug: "gemini" },
] as const;

/**
 * ByokCard lists 26 BYOK providers. Modal joins only once the Gateway reports
 * a Modal config, which this fixture never serves, so 25 key rows render.
 */
const BYOK_ROW_COUNT = 25;

/** The card lists every BYOK provider; scope each assertion to one row. */
/** Clear lives in each row's "<label> key actions" menu. */
async function clearKey(page: Page, label: string) {
	await providerRow(page, label)
		.getByRole("button", { name: `${label} key actions`, exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Clear", exact: true }).click();
}

function providerRow(page: Page, label: string) {
	return page.locator('[data-slot="item"]').filter({
		has: page.getByRole("textbox", { name: `${label} API key`, exact: true }),
	});
}

test("writes each provider key to the Gateway config, then mirrors it into the OS credential store", async ({
	page,
}) => {
	await page.goto("/gateway-byok-integration-proof.html");
	for (const { key, label } of providers) {
		const row = providerRow(page, label);
		const input = row.getByRole("textbox", { name: `${label} API key` });
		await input.fill(key);
		await row.getByRole("button", { name: "Save", exact: true }).click();
		await expect(row.getByText("Key set", { exact: true })).toBeVisible();
		await expect(
			row.getByRole("button", { name: "Replace first key", exact: true })
		).toBeVisible();
		await expect(input).toHaveValue("");
	}
	const effects = await page.evaluate(() => ({
		gatewayWrites: window.__gatewayByokIntegrationProof.gatewayWrites,
		secretCalls: window.__gatewayByokIntegrationProof.secretCalls,
		secrets: window.__gatewayByokIntegrationProof.credentials,
		writeOrder: window.__gatewayByokIntegrationProof.writeOrder,
	}));
	expect(effects.writeOrder).toEqual(
		providers.flatMap(({ slug }) => [
			`gateway:set:${slug}`,
			`keychain:set:${slug}`,
		])
	);
	expect(effects.gatewayWrites).toEqual(
		providers.map(({ key, slug }) => ({ api_key: key, provider: slug }))
	);
	expect(effects.secretCalls).toEqual(
		providers.map(({ key, slug }) => ({
			key,
			operation: "set",
			provider: slug,
		}))
	);
	for (const { key, slug } of providers) {
		expect(effects.secrets[slug]).toBe(key);
	}
	await page.screenshot({
		path: evidence("gateway-byok-integration-saved.png"),
		fullPage: true,
	});
});

test("retains the credential when Gateway clear fails and removes both stores on retry", async ({
	page,
}) => {
	await page.goto(
		"/gateway-byok-integration-proof.html?configured=true&failGateway=true"
	);
	const openaiRow = providerRow(page, "OpenAI");
	await clearKey(page, "OpenAI");
	await expect(
		openaiRow.getByText("Gateway config write denied", { exact: true })
	).toBeVisible();
	await expect(openaiRow.getByText("Key set", { exact: true })).toBeVisible();
	const failedEffects = await page.evaluate(() => ({
		gatewayWrites: window.__gatewayByokIntegrationProof.gatewayWrites,
		secretCalls: window.__gatewayByokIntegrationProof.secretCalls,
		secrets: window.__gatewayByokIntegrationProof.credentials,
		writeOrder: window.__gatewayByokIntegrationProof.writeOrder,
	}));
	expect(failedEffects.writeOrder).toEqual(["gateway:delete:openai"]);
	expect(failedEffects.gatewayWrites).toEqual([
		{ api_key: null, provider: "openai" },
	]);
	expect(failedEffects.secretCalls).toEqual([]);
	expect(failedEffects.secrets.openai).toBe("openai-existing-key");
	await page.screenshot({
		animations: "disabled",
		path: evidence("gateway-byok-integration-clear-error.png"),
		fullPage: true,
	});

	await page.evaluate(() => {
		window.__gatewayByokIntegrationProof.failGatewayWrite = false;
	});
	await clearKey(page, "OpenAI");
	await expect(openaiRow.getByText("No key", { exact: true })).toBeVisible();
	await expect(
		openaiRow.getByRole("button", { name: "OpenAI key actions", exact: true })
	).toHaveCount(0);
	const clearedEffects = await page.evaluate(() => ({
		gatewayWrites: window.__gatewayByokIntegrationProof.gatewayWrites,
		secretCalls: window.__gatewayByokIntegrationProof.secretCalls,
		secrets: window.__gatewayByokIntegrationProof.credentials,
		writeOrder: window.__gatewayByokIntegrationProof.writeOrder,
	}));
	expect(clearedEffects.writeOrder).toEqual([
		"gateway:delete:openai",
		"gateway:delete:openai",
		"keychain:delete:openai",
	]);
	expect(clearedEffects.gatewayWrites).toEqual([
		{ api_key: null, provider: "openai" },
		{ api_key: null, provider: "openai" },
	]);
	expect(clearedEffects.secretCalls).toEqual([
		{ operation: "delete", provider: "openai" },
	]);
	expect(clearedEffects.secrets.openai).toBeUndefined();
});

test("shows the Gateway-held key and the credential-store error after a failed mirror, then retries both stores in order", async ({
	page,
}) => {
	await page.goto("/gateway-byok-integration-proof.html?failSecretWrite=true");
	const anthropicRow = providerRow(page, "Anthropic");
	const input = anthropicRow.getByRole("textbox", {
		name: "Anthropic API key",
	});
	await input.fill("sk-ant-retry-test");
	await anthropicRow.getByRole("button", { name: "Save", exact: true }).click();
	// The Gateway persisted the key, so the card refreshes and shows it even
	// though the OS credential store mirror refused the write.
	await expect(
		anthropicRow.getByText(
			"Key saved to the Gateway, but the OS credential store could not be updated: OS credential store is unavailable",
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		anthropicRow.getByText("Key set", { exact: true })
	).toBeVisible();
	await expect(anthropicRow.getByText("No key", { exact: true })).toHaveCount(
		0
	);
	await expect(input).toHaveValue("sk-ant-retry-test");
	const replace = anthropicRow.getByRole("button", {
		name: "Replace first key",
		exact: true,
	});
	await expect(replace).toBeEnabled();
	await expect
		.poll(() =>
			page.evaluate(() => window.__gatewayByokIntegrationProof.writeOrder)
		)
		.toEqual(["gateway:set:anthropic", "keychain:set:anthropic"]);
	const refusedEffects = await page.evaluate(() => ({
		configReads: window.__gatewayByokIntegrationProof.configReads,
		gatewayWrites: window.__gatewayByokIntegrationProof.gatewayWrites,
		secretCalls: window.__gatewayByokIntegrationProof.secretCalls,
	}));
	expect(refusedEffects).toEqual({
		configReads: 1,
		gatewayWrites: [{ api_key: "sk-ant-retry-test", provider: "anthropic" }],
		secretCalls: [
			{ key: "sk-ant-retry-test", operation: "set", provider: "anthropic" },
		],
	});

	await page.evaluate(() => {
		window.__gatewayByokIntegrationProof.failSecretWrite = false;
	});
	await replace.click();
	await expect(
		anthropicRow.getByText("Key set", { exact: true })
	).toBeVisible();
	await expect(input).toHaveValue("");
	await expect(
		anthropicRow.getByText("OS credential store could not be updated")
	).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(() => window.__gatewayByokIntegrationProof.writeOrder)
		)
		.toEqual([
			"gateway:set:anthropic",
			"keychain:set:anthropic",
			"gateway:set:anthropic",
			"keychain:set:anthropic",
		]);
	const retriedEffects = await page.evaluate(() => ({
		gatewayWrites: window.__gatewayByokIntegrationProof.gatewayWrites,
		secretCalls: window.__gatewayByokIntegrationProof.secretCalls,
		secrets: window.__gatewayByokIntegrationProof.credentials,
	}));
	expect(retriedEffects.gatewayWrites).toEqual([
		{ api_key: "sk-ant-retry-test", provider: "anthropic" },
		{ api_key: "sk-ant-retry-test", provider: "anthropic" },
	]);
	expect(retriedEffects.secretCalls).toEqual([
		{ key: "sk-ant-retry-test", operation: "set", provider: "anthropic" },
		{ key: "sk-ant-retry-test", operation: "set", provider: "anthropic" },
	]);
	expect(retriedEffects.secrets.anthropic).toBe("sk-ant-retry-test");
});

test("managed and permission-limited Gateway cards make no credential writes", async ({
	page,
}) => {
	await page.goto(
		"/gateway-byok-integration-proof.html?managed=true&configured=true"
	);
	await expect(
		page.getByText("Managed", { exact: true }).first()
	).toBeVisible();
	await expect(
		page
			.getByText("Provided by Ryu Cloud. Keys held server-side.", {
				exact: true,
			})
			.first()
	).toBeVisible();
	await expect(page.getByRole("textbox")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: / key actions$/u })
	).toHaveCount(0);

	await page.goto(
		"/gateway-byok-integration-proof.html?canConfigure=false&configured=true"
	);
	for (const { label } of providers) {
		const row = providerRow(page, label);
		await expect(row.getByText("Key set", { exact: true })).toBeVisible();
		await expect(
			row.getByRole("button", { name: "Replace first key", exact: true })
		).toBeDisabled();
		await expect(
			row.getByRole("button", { name: `${label} key actions`, exact: true })
		).toBeDisabled();
	}
	const geminiRow = providerRow(page, "Gemini");
	await expect(
		geminiRow.getByRole("button", { name: "Add account", exact: true })
	).toBeDisabled();
	await expect(
		geminiRow.getByRole("button", {
			name: "Remove Gemini account 1",
			exact: true,
		})
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: / key actions$/u })
	).toHaveCount(providers.length);
	await expect(
		page.getByRole("button", { name: "Replace first key", exact: true })
	).toHaveCount(providers.length);
	await expect(page.getByRole("textbox", { name: / API key$/u })).toHaveCount(
		BYOK_ROW_COUNT
	);
	const saveButtons = page.getByRole("button", { name: "Save", exact: true });
	const saveCount = BYOK_ROW_COUNT - providers.length;
	await expect(saveButtons).toHaveCount(saveCount);
	for (let index = 0; index < saveCount; index++) {
		await expect(saveButtons.nth(index)).toBeDisabled();
	}
	const effects = await page.evaluate(() => ({
		gatewayWrites: window.__gatewayByokIntegrationProof.gatewayWrites,
		secretCalls: window.__gatewayByokIntegrationProof.secretCalls,
		writeOrder: window.__gatewayByokIntegrationProof.writeOrder,
	}));
	expect(effects).toEqual({
		gatewayWrites: [],
		secretCalls: [],
		writeOrder: [],
	});
	await page.screenshot({
		path: evidence("gateway-byok-integration-readonly.png"),
		fullPage: true,
	});
});
