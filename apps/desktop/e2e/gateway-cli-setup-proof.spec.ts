import path from "node:path";
import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

// Each CLI is a settings row; scope lookups to the whole row, since the title's
// parent now holds only the title.
const CLI_ROW = 'xpath=ancestor::*[@data-slot="item"][1]';

test("creates a Gateway client key and applies and resets local CLI setup", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/gateway-cli-setup-proof.html");
	await expect(
		page.getByText("http://127.0.0.1:7981/v1/chat/completions")
	).toBeVisible();
	await expect(page.getByText("Authentication required")).toBeVisible();
	await expect(
		page.getByText("local-inference", { exact: true })
	).toBeVisible();
	await expect(page.getByText("System relay", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
	await page.getByLabel("Key name").fill("coding-cli");
	await page.getByRole("button", { name: "Create key" }).click();
	await expect(page.getByText("Copy your key now")).toBeVisible();
	await page.getByLabel("Gateway model ID").fill("openrouter/auto");

	const claude = page
		.getByText("Claude Code", { exact: true })
		.locator(CLI_ROW);
	await claude.getByRole("button", { name: "Apply" }).click();
	await expect(claude.getByText("Applied")).toBeVisible();
	await claude.getByRole("button", { name: "Reset" }).click();
	await expect(claude.getByText("Not applied")).toBeVisible();

	const codex = page.getByText("Codex CLI", { exact: true }).locator(CLI_ROW);
	await codex.getByRole("button", { name: "Apply" }).click();
	await expect(codex.getByText("Applied")).toBeVisible();

	const opencode = page.getByText("OpenCode", { exact: true }).locator(CLI_ROW);
	await opencode.getByRole("button", { name: "Apply" }).click();
	await expect(opencode.getByText("Applied")).toBeVisible();
	const gemini = page.getByText("Gemini CLI", { exact: true }).locator(CLI_ROW);
	await gemini.getByRole("button", { name: "Apply" }).click();
	await expect(gemini.getByText("Applied")).toBeVisible();
	await gemini.getByRole("button", { name: "Reset" }).click();
	await expect(gemini.getByText("Not applied")).toBeVisible();
	await gemini.getByRole("button", { name: "Apply" }).click();
	await expect(gemini.getByText("Applied")).toBeVisible();
	const pi = page.getByText("Pi", { exact: true }).locator(CLI_ROW);
	await pi.getByRole("button", { name: "Apply" }).click();
	await expect(pi.getByText("Applied")).toBeVisible();
	const droid = page
		.getByText("Factory Droid", { exact: true })
		.locator(CLI_ROW);
	await droid.getByRole("button", { name: "Apply" }).click();
	await expect(droid.getByText("Applied")).toBeVisible();
	await droid.getByRole("button", { name: "Reset" }).click();
	await expect(droid.getByText("Not applied")).toBeVisible();
	await pi.getByRole("button", { name: "Reset" }).click();
	await expect(pi.getByText("Not applied")).toBeVisible();
	await pi.getByRole("button", { name: "Apply" }).click();
	await expect(pi.getByText("Applied")).toBeVisible();
	await opencode.getByRole("button", { name: "Reset" }).click();
	await expect(opencode.getByText("Not applied")).toBeVisible();
	await opencode.getByRole("button", { name: "Apply" }).click();
	await expect(opencode.getByText("Applied")).toBeVisible();
	expect(errors).toEqual([]);

	await page.screenshot({
		// RYU_PROOF_EVIDENCE_DIR keeps a revalidation run's screenshot out of the
		// tracked proof ledger; without it the committed evidence is refreshed.
		path: process.env.RYU_PROOF_EVIDENCE_DIR
			? path.join(process.env.RYU_PROOF_EVIDENCE_DIR, "gateway-cli-setup.png")
			: path.resolve(
					import.meta.dirname,
					"../../../docs/proof/gateway-cli-setup/gateway-cli-setup.png"
				),
		fullPage: true,
	});
});
