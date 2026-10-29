import path from "node:path";
import { expect, test } from "@playwright/test";

test("coordinator worktree isolation defaults off and persists its setting", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	await page.addInitScript(() => {
		const initializedKey =
			"proof-coordinator-worktree-isolation-default-initialized";
		if (sessionStorage.getItem(initializedKey) === "true") {
			return;
		}
		sessionStorage.removeItem("proof-coordinator-worktree-isolation-default");
		sessionStorage.setItem(initializedKey, "true");
	});
	await page.goto("/coordinator-worktree-default-proof.html");

	const isolationSwitch = page.getByRole("switch", {
		name: "Use a worktree by default for coordinator workers",
	});
	await expect(
		page.getByRole("heading", { name: "Coordinator workers" })
	).toBeVisible();
	await expect(isolationSwitch).toBeEnabled();
	await expect(isolationSwitch).toHaveAttribute("aria-checked", "false");

	await isolationSwitch.click();
	await expect(isolationSwitch).toHaveAttribute("aria-checked", "true");
	await page.reload();
	await expect(isolationSwitch).toHaveAttribute("aria-checked", "true");

	await isolationSwitch.click();
	await expect(isolationSwitch).toHaveAttribute("aria-checked", "false");
	await page.reload();
	await expect(isolationSwitch).toHaveAttribute("aria-checked", "false");

	await page.screenshot({
		fullPage: true,
		path: path.resolve(
			test.info().project.testDir,
			"..",
			"artifacts",
			"coordinator-worktree-default-proof.png"
		),
	});
	expect(errors).toEqual([]);
});
