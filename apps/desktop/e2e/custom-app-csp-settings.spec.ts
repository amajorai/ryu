import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const preferenceRequestSchema = z.object({ value: z.string() });

test("the actual security setting saves, reloads, and reverts a failed save", async ({
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	let storedValue = "true";
	let rejectSave = false;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route(
		"**/api/preferences/enforce-custom-app-csp",
		async (route) => {
			if (route.request().method() === "PUT") {
				if (rejectSave) {
					await route.fulfill({ status: 503, body: "unavailable" });
					return;
				}
				const parsedBody = preferenceRequestSchema.safeParse(
					route.request().postDataJSON()
				);
				if (!parsedBody.success) {
					throw new Error("Expected a preference value string");
				}
				const body = parsedBody.data;
				storedValue = body.value;
			}
			await route.fulfill({
				json: { key: "enforce-custom-app-csp", value: storedValue },
			});
		}
	);
	await page.goto("/custom-app-csp-settings-proof.html", {
		waitUntil: "domcontentloaded",
	});
	const control = page.getByRole("switch", {
		name: "Enforce CSP for custom apps",
	});
	await expect(control).toBeEnabled({ timeout: 90_000 });
	await expect(control).toBeChecked();
	await control.focus();
	await page.keyboard.press("Space");
	await expect.poll(() => storedValue).toBe("false");
	await page.reload();
	await expect(control).not.toBeChecked();
	rejectSave = true;
	await control.click();
	await expect(control).not.toBeChecked();
	rejectSave = false;
	await control.click();
	await expect.poll(() => storedValue).toBe("true");
	await expect(control).toBeChecked();
	await page.screenshot({
		path: testInfo.outputPath("enforce-custom-app-csp-proof.png"),
		fullPage: true,
	});
	expect(errors).toEqual([]);
	await writeFile(
		testInfo.outputPath("verification.json"),
		JSON.stringify(
			{
				api: "Core preferences contract fixture",
				checks: [
					"keyboard toggle",
					"reload persistence",
					"failed-save rollback",
				],
				storedValue,
				browserErrors: errors,
			},
			null,
			2
		)
	);
});
