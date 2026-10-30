import path from "node:path";
import { expect, test } from "@playwright/test";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidenceOverride = process.env.RYU_PROOF_EVIDENCE_DIR;
const evidence = (name: string) =>
	evidenceOverride
		? path.join(evidenceOverride, name)
		: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence",
				name
			);

const providers = [
	{
		key: "sk-openai-test",
		label: "OpenAI",
		placeholder: "sk-…",
		slug: "openai",
	},
	{
		key: "sk-ant-test",
		label: "Anthropic",
		placeholder: "sk-ant-…",
		slug: "anthropic",
	},
	{
		key: "sk-or-test",
		label: "OpenRouter",
		placeholder: "sk-or-…",
		slug: "openrouter",
	},
	{ key: "AIza-test", label: "Gemini", placeholder: "AIza…", slug: "gemini" },
] as const;

test.beforeEach(async ({ page }) => {
	const diagnostics: string[] = [];
	page.on("pageerror", (error) => diagnostics.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			diagnostics.push(message.text());
		}
	});
	page.on("requestfailed", (request) => {
		diagnostics.push(
			`${request.method()} ${request.url()} ${request.failure()?.errorText}`
		);
	});
	await page.goto("/gateway-byok-row-proof.html");
	await expect(page.locator("body")).toContainText("Provider keys (BYOK)", {
		timeout: 20_000,
	});
	expect(diagnostics).toEqual([]);
});

/** Clear lives in each row's "<label> key actions" menu. */
async function clearKey(
	page: import("@playwright/test").Page,
	row: import("@playwright/test").Locator,
	label: string
) {
	await row.getByRole("button", { name: `${label} key actions` }).click();
	await page.getByRole("menuitem", { name: "Clear", exact: true }).click();
}

test("saves all provider keys from each row with trimmed values and updates badges", async ({
	page,
}) => {
	for (const { key, label, slug } of providers) {
		const row = page.getByTestId(slug);
		const input = row.getByRole("textbox", { name: `${label} API key` });
		const save = row.getByRole("button", { name: "Save" });
		await expect(save).toBeDisabled();
		await input.fill(`  ${key}  `);
		await expect(save).toBeEnabled();
		await input.press("Enter");
		await expect(row.getByText("Key set", { exact: true })).toBeVisible();
		await expect(input).toHaveValue("");
		await expect(save).toBeDisabled();
		await expect(page.getByRole("status")).toHaveText(`${label} key saved`);
	}
	const calls = await page.evaluate(() => window.__gatewayByokProof.saveCalls);
	expect(calls).toEqual(providers.map(({ key, slug }) => ({ key, slug })));
	await page.screenshot({
		path: evidence("gateway-byok-provider-keys.png"),
		fullPage: true,
	});
});

test("reveals and hides only the typed key in every provider row", async ({
	page,
}) => {
	for (const { label, slug } of providers) {
		const row = page.getByTestId(slug);
		const input = row.getByRole("textbox", { name: `${label} API key` });
		await input.fill(`${slug}-secret`);
		await expect(input).toHaveAttribute("type", "password");
		await row.getByRole("button", { name: "Show key" }).click();
		await expect(input).toHaveAttribute("type", "text");
		await row.getByRole("button", { name: "Hide key" }).click();
		await expect(input).toHaveAttribute("type", "password");
	}
	await expect(page.getByRole("status")).toHaveText("");
});

test("clears each configured provider and updates its stored-state badge", async ({
	page,
}) => {
	await page.goto("/gateway-byok-row-proof.html?isSet=true");
	for (const { label, placeholder, slug } of providers) {
		const row = page.getByTestId(slug);
		await expect(row.getByText("Key set", { exact: true })).toBeVisible();
		await clearKey(page, row, label);
		await expect(row.getByText("No key", { exact: true })).toBeVisible();
		await expect(
			row.getByRole("textbox", { name: `${label} API key` })
		).toHaveAttribute("placeholder", placeholder);
		await expect(page.getByRole("status")).toHaveText(`${label} key cleared`);
	}
	const calls = await page.evaluate(() => window.__gatewayByokProof.clearCalls);
	expect(calls).toEqual(providers.map(({ slug }) => slug));
});

test("keeps the key usable after save and clear failures and supports retry", async ({
	page,
}) => {
	await page.goto("/gateway-byok-row-proof.html?failSave=true&isSet=false");
	const row = page.getByTestId("openai");
	const input = row.getByRole("textbox", { name: "OpenAI API key" });
	const save = row.getByRole("button", { name: "Save" });
	await input.fill("sk-retry-after-error");
	await save.click();
	await expect(row.getByText("Credential store unavailable")).toBeVisible();
	await expect(row.getByText("No key", { exact: true })).toBeVisible();
	await expect(input).toHaveValue("sk-retry-after-error");
	await expect(save).toBeEnabled();

	await page.evaluate(() => {
		window.__gatewayByokProof.failSave = false;
		window.__gatewayByokProof.failClear = true;
	});
	await save.click();
	await expect(row.getByText("Key set", { exact: true })).toBeVisible();
	await clearKey(page, row, "OpenAI");
	await expect(
		row.getByText("Credential store refused deletion")
	).toBeVisible();
	await expect(row.getByText("Key set", { exact: true })).toBeVisible();
	await expect(
		row.getByRole("button", { name: "OpenAI key actions" })
	).toBeEnabled();
	await page.screenshot({
		path: evidence("gateway-byok-errors.png"),
		fullPage: true,
	});

	await page.evaluate(() => {
		window.__gatewayByokProof.failClear = false;
	});
	await clearKey(page, row, "OpenAI");
	await expect(row.getByText("No key", { exact: true })).toBeVisible();
});

test("hides edits on managed nodes and blocks writers without gateway configure access", async ({
	page,
}) => {
	await page.goto("/gateway-byok-row-proof.html?managed=true&isSet=true");
	const managedRow = page.getByTestId("openai");
	await expect(
		managedRow.getByText("Ryu Cloud", { exact: true })
	).toBeVisible();
	await expect(
		managedRow.getByText("Provided by Ryu Cloud. Keys held server-side.")
	).toBeVisible();
	await expect(managedRow.getByRole("textbox")).toHaveCount(0);
	await expect(managedRow.getByRole("button", { name: "Save" })).toHaveCount(0);
	await expect(
		managedRow.getByRole("button", { name: "OpenAI key actions" })
	).toHaveCount(0);

	await page.goto("/gateway-byok-row-proof.html?canConfigure=false&isSet=true");
	const restrictedRow = page.getByTestId("openai");
	await expect(
		restrictedRow.getByRole("button", { name: "Save" })
	).toBeDisabled();
	await expect(
		restrictedRow.getByRole("button", { name: "OpenAI key actions" })
	).toHaveCount(0);
	const calls = await page.evaluate(() => ({
		clears: window.__gatewayByokProof.clearCalls,
		saves: window.__gatewayByokProof.saveCalls,
	}));
	expect(calls).toEqual({ clears: [], saves: [] });
	await page.screenshot({
		path: evidence("gateway-byok-read-only.png"),
		fullPage: true,
	});
});
