import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const STORY_URL = "/ryu-personalization-proof.html";
const PROOF_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/ryu-personalization"
);

test("personalizes Ryu before opening Add your agents", async ({ page }) => {
	const response = await page.goto(STORY_URL, {
		waitUntil: "domcontentloaded",
	});
	expect(response?.status()).toBe(200);

	const name = page.getByRole("textbox", { name: "Agent name" });
	await expect(name).toHaveValue("Ryu");
	await expect(name).toHaveCSS("font-size", "20px");

	await page.getByRole("button", { name: "Set icon" }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.getByRole("tab", { name: "Expressive" }).click();
	await page.getByRole("button", { name: "Use ghost avatar" }).click();
	await expect(page.getByRole("dialog")).toBeHidden();

	mkdirSync(PROOF_DIR, { recursive: true });
	await page.screenshot({
		fullPage: true,
		path: path.join(PROOF_DIR, "ryu-personalization-step.png"),
	});

	await name.fill("Nova");
	await page.getByRole("button", { name: "Save and continue" }).click();
	await expect(
		page.getByRole("heading", { name: "Add your agents" })
	).toBeVisible();
	const saved = page.getByTestId("personalization-saved");
	await expect(saved).toHaveAttribute("data-agent-name", "Nova");
	await expect(saved).toHaveAttribute("data-avatar-kind", "expressive");
	await expect(
		page.getByRole("img", { name: "Your agent avatar" })
	).toBeVisible();
});

test("skips personalization with the default Ryu setup", async ({ page }) => {
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("textbox", { name: "Agent name" })).toHaveValue(
		"Ryu"
	);
	await page.getByRole("button", { name: "Skip" }).click();
	await expect(
		page.getByRole("heading", { name: "Add your agents" })
	).toBeVisible();
	expect(
		await page.evaluate(() => window.__ryuPersonalizationProof.agentWrite)
	).toBeNull();
});
