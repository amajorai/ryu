import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const PRO_ORG_ID = "507f1f77bcf86cd799439011";
const ENTERPRISE_ORG_ID = "507f1f77bcf86cd799439012";
const proofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/node-billing"
);

test.setTimeout(120_000);

test("renders the plan gate and Enterprise included-server upgrade path", async ({
	context,
	page,
}) => {
	await mkdir(proofDir, { recursive: true });
	await context.addCookies([
		{
			domain: "localhost",
			name: "better-auth.session_token",
			path: "/",
			value: "proof-session",
		},
	]);

	await page.goto(`/organizations/${PRO_ORG_ID}/servers/new`, {
		waitUntil: "networkidle",
	});
	const planGate = page.locator('[data-node-plan-gate="true"]');
	await expect(planGate).toBeVisible();
	await expect(
		page.getByText("Business, Teams, or Enterprise", {
			exact: false,
		})
	).toBeVisible();
	await page
		.getByRole("button", { name: /Advanced selection Browse all/ })
		.click();
	await expect(
		page.locator("button[disabled]").filter({ hasText: "cx53" })
	).toBeVisible();
	await planGate.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		path: path.join(proofDir, "pro-plan-gate.png"),
	});

	await page.goto(`/organizations/${ENTERPRISE_ORG_ID}/servers/server-proof`, {
		waitUntil: "networkidle",
	});
	await expect(
		page.getByText("Change instance", { exact: true })
	).toBeVisible();
	const target = page.getByRole("combobox", { name: "Target instance" });
	await expect(target).toBeVisible();
	await target.selectOption("cx53");
	await expect(
		page.getByRole("button", { name: "Upgrade included server", exact: true })
	).toBeVisible();
	await expect(
		page.getByText(
			/This included server will be converted to the selected paid size/
		)
	).toBeVisible();
	await page
		.getByRole("button", { name: "Upgrade included server", exact: true })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		path: path.join(proofDir, "enterprise-included-upgrade.png"),
	});
});
