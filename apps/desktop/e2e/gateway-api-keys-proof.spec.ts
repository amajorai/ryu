import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

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

/** A client key's row title in the key list. The CLI setup panel above the
 * list names the same tools (Claude Code, Gemini CLI), so match the list. */
function keyEntry(page: Page, name: string) {
	return page
		.locator('[data-slot="item-title"]')
		.getByText(name, { exact: true });
}

test.beforeEach(async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/gateway-api-keys-proof.html");
	await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
	await expect(page.getByText("Cursor", { exact: true })).toBeVisible();
});

test("copies all three compatible endpoint URLs", async ({ page }) => {
	for (const [label, value] of [
		["OpenAI compatible", "http://gateway.test:7980/v1/chat/completions"],
		["Anthropic Messages", "http://gateway.test:7980/v1/messages"],
		["Google Gemini", "http://gateway.test:7980/v1beta/models"],
	] as const) {
		await page.getByRole("button", { name: `Copy ${label}` }).click();
		await expect(
			page.getByRole("button", { name: `Copy ${label}` })
		).toContainText("Copied");
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toBe(value);
	}
});

test("creates a named key, exposes it once, and copies its plaintext", async ({
	page,
}) => {
	const create = page.getByRole("button", { name: "Create key" });
	await expect(create).toBeDisabled();
	await page.getByLabel("Key name").fill("  Claude Code  ");
	await expect(create).toBeEnabled();
	await create.click();
	await expect(page.getByText("Copy your key now")).toBeVisible();
	// The one-time key starts masked; it is in the page only once revealed.
	const key = page.getByText(/^sk-ryu-/u);
	await expect(key).toHaveCount(0);
	// The seeded key rows are masked too, so look for the mask in the banner.
	const banner = page
		.getByText("Copy your key now")
		.locator("xpath=ancestor::div[1]");
	await expect(banner.getByText("••••••••", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Reveal API key" }).click();
	await expect(key).toBeVisible();
	const plaintext = await key.innerText();
	expect(plaintext).toMatch(/^sk-ryu-[0-9a-f]{64}$/u);
	const registeredKey = await page.evaluate(() => {
		// SAFETY: These controlled create/revoke actions publish registerByoaKey/removeByoaKey auth.api_keys patches; the native ApiSection creates string name/key entries, the fixture seeds string entries, and its capture retains that exact JSON body.
		const patch = window.__gatewayApiKeyProof.lastWrite as {
			auth?: { api_keys?: Array<{ key: string; name: string }> };
		};
		return patch.auth?.api_keys?.find((entry) => entry.name === "Claude Code")
			?.key;
	});
	expect(registeredKey).toBe(plaintext);
	await expect(keyEntry(page, "Claude Code")).toBeVisible();
	await page.getByRole("button", { name: "Copy", exact: true }).last().click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(plaintext);
	await expect(page.getByText("It won't be shown again.")).toBeVisible();
	await page.screenshot({
		path: evidence("gateway-api-key-created.png"),
		fullPage: true,
	});
});

test("creates a key from Enter and trims the submitted name", async ({
	page,
}) => {
	const nameInput = page.getByLabel("Key name");
	await nameInput.fill("  Gemini CLI  ");
	await nameInput.press("Enter");
	await expect(page.getByText("Copy your key now")).toBeVisible();
	await expect(keyEntry(page, "Gemini CLI")).toBeVisible();
	const writtenKey = await page.evaluate(() => {
		// SAFETY: These controlled create/revoke actions publish registerByoaKey/removeByoaKey auth.api_keys patches; the native ApiSection creates string name/key entries, the fixture seeds string entries, and its capture retains that exact JSON body.
		const patch = window.__gatewayApiKeyProof.lastWrite as {
			auth?: { api_keys?: Array<{ key: string; name: string }> };
		};
		return patch.auth?.api_keys?.find((entry) => entry.name === "Gemini CLI")
			?.key;
	});
	expect(writtenKey).toMatch(/^sk-ryu-[0-9a-f]{64}$/u);
});

test("revokes a key and refreshes the visible key list", async ({ page }) => {
	await page.getByRole("button", { name: "Revoke" }).click();
	await expect(page.getByText("No keys", { exact: true })).toBeVisible();
	await expect(page.getByText("Cursor", { exact: true })).toHaveCount(0);
	const revokedKeys = await page.evaluate(() => {
		// SAFETY: These controlled create/revoke actions publish registerByoaKey/removeByoaKey auth.api_keys patches; the native ApiSection creates string name/key entries, the fixture seeds string entries, and its capture retains that exact JSON body.
		const patch = window.__gatewayApiKeyProof.lastWrite as {
			auth?: { api_keys?: Array<{ name: string }> };
		};
		return patch.auth?.api_keys?.map((entry) => entry.name) ?? null;
	});
	expect(revokedKeys).toEqual([]);
	await page.screenshot({
		path: evidence("gateway-api-key-revoked.png"),
		fullPage: true,
	});
});

test("shows create and revoke failures while retaining the existing key", async ({
	page,
}) => {
	await page.evaluate(() => {
		window.__gatewayApiKeyProof.createFailure = true;
		window.__gatewayApiKeyProof.revokeFailure = true;
	});
	await page.getByLabel("Key name").fill("Failed key");
	await page.getByRole("button", { name: "Create key" }).click();
	await expect(
		page.getByText(/api\/gateway\/config failed: 500/u)
	).toBeVisible();
	await expect(page.getByText("Cursor", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Revoke" }).click();
	await expect(
		page.getByText(/api\/gateway\/config failed: 500/u)
	).toBeVisible();
	await expect(page.getByText("Cursor", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Create key" })).toBeEnabled();
	await page.screenshot({
		path: evidence("gateway-api-key-errors.png"),
		fullPage: true,
	});
});

test("shows managed-node keys as read-only", async ({ page }) => {
	await page.goto("/gateway-api-keys-proof.html?managed");
	await expect(
		page.getByText("Keys are issued and revoked in Console on the web.")
	).toBeVisible();
	await expect(page.getByLabel("Key name")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Create key" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
	await expect(page.getByText("Cursor", { exact: true })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.__gatewayApiKeyProof.lastWrite))
		.toBeNull();
	await page.screenshot({
		path: evidence("gateway-api-key-managed-readonly.png"),
		fullPage: true,
	});
});
