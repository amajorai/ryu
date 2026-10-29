import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

test("shows usage for ACP and Ryu subscription providers in one dialog", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1100 });
	await page.addInitScript(() => {
		localStorage.setItem(
			"ryu:usage-bar-prefs",
			JSON.stringify({
				barStyle: "ring",
				mode: "remaining",
				showBar: true,
				showPercent: false,
				sidebar: true,
				visible: true,
			})
		);
	});
	await page.goto("/ryu-provider-usage-proof.html");
	await page.getByTestId("usage-proof-trigger").click();

	await expect(page.getByTestId("usage-proof-acp")).toBeVisible();
	await expect(page.getByTestId("usage-proof-ryu-claude")).toBeVisible();
	await expect(page.getByTestId("usage-proof-ryu-codex")).toBeVisible();
	await expect(page.getByTestId("usage-proof-ryu-copilot")).toBeVisible();
	await expect(page.getByTestId("usage-proof-devin")).toBeVisible();
	await expect(page.getByTestId("usage-proof-opencode")).toBeVisible();
	await expect(page.getByTestId("usage-proof-ollama")).toBeVisible();
	await expect(page.getByTestId("usage-proof-cursor")).toBeVisible();
	await expect(page.getByTestId("usage-proof-antigravity")).toBeVisible();
	await expect(page.getByLabel("Session: 72% left")).toBeVisible();
	await expect(page.getByLabel("Weekly: 38% left")).toBeVisible();
	await expect(page.getByLabel("Session: 66% left")).toBeVisible();
	await expect(page.getByLabel("Weekly: 42% left")).toBeVisible();
	await expect(page.getByLabel("Rate limit resets: 3/10")).toBeVisible();
	await expect(page.getByLabel("Session: 59% left")).toBeVisible();
	await expect(page.getByLabel("Weekly: 27% left")).toBeVisible();
	await expect(page.getByLabel("Credits: 81% left")).toBeVisible();
	await expect(page.getByLabel("Daily quota: 72% left")).toBeVisible();
	await expect(page.getByLabel("Weekly quota: 48% left")).toBeVisible();
	await expect(page.getByLabel("Session: 83% left")).toBeVisible();
	await expect(page.getByLabel("Weekly: 93% left")).toBeVisible();
	await expect(page.getByLabel("Total usage: 90% left")).toBeVisible();
	await expect(page.getByLabel("Cursor Models: 85% left")).toBeVisible();
	await expect(page.getByLabel("Session: 68% left")).toBeVisible();
	await expect(page.getByLabel("Weekly: 51% left")).toBeVisible();
	await expect(page.getByLabel("Session: 65% left")).toBeVisible();
	await expect(page.getByLabel("Weekly: 88% left")).toBeVisible();
	const proofPath = path.resolve(
		process.cwd(),
		"../../docs/proof/openusage-usage-meters-2026-09-24.png"
	);
	const cursorProofPath = path.resolve(
		process.cwd(),
		"../../docs/proof/openusage-cursor-meters-2026-09-24.png"
	);
	const bottomProofPath = path.resolve(
		process.cwd(),
		"../../docs/proof/openusage-usage-meters-bottom-2026-09-24.png"
	);
	mkdirSync(path.dirname(proofPath), { recursive: true });
	await page.getByRole("dialog").screenshot({ path: proofPath });
	await expect(
		page
			.getByTestId("usage-proof-ryu-claude")
			.locator('svg[viewBox="0 0 16 16"]')
	).toHaveCount(2);
	await expect(
		page
			.getByTestId("usage-proof-ryu-codex")
			.locator('svg[viewBox="0 0 16 16"]')
	).toHaveCount(2);
	await page
		.getByTestId("usage-proof-opencode")
		.getByLabel("1 more usage meters")
		.hover();
	await expect(page.getByText("Monthly: 97% left")).toBeVisible();
	await expect(page.getByLabel("Last 4 weeks: $2.75")).toBeVisible();
	await page
		.getByTestId("usage-proof-cursor")
		.getByLabel(/more usage meters/)
		.hover();
	await expect(page.getByText("Other Models: 65% left")).toBeVisible();
	await expect(
		page.getByText("Grok Bot usage: 58% left", { exact: false })
	).toBeVisible();
	await expect(page.getByText("Credits: $63.00")).toBeVisible();
	await expect(page.getByText("Requests: 39/500")).toBeVisible();
	await page
		.getByTestId("usage-proof-antigravity")
		.getByLabel("1 more usage meters")
		.hover();
	const antigravityOverflow = page.getByText("Claude: 80% left");
	await expect(antigravityOverflow).toBeVisible();
	await page.mouse.move(0, 0);
	await expect(antigravityOverflow).toBeHidden();
	await page
		.getByTestId("usage-proof-cursor")
		.getByLabel(/more usage meters/)
		.hover();
	await expect(
		page.getByText("Grok Bot usage: 58% left", { exact: false })
	).toBeVisible();
	await page.screenshot({ path: cursorProofPath });
	await page.mouse.move(0, 0);
	await page
		.getByTestId("usage-proof-ollama")
		.getByLabel("Last 4 weeks: $2.75")
		.hover();
	await expect(
		page.getByText("Last 4 weeks: $2.75", { exact: true })
	).toBeVisible();
	await page.getByRole("dialog").screenshot({ path: bottomProofPath });
});
