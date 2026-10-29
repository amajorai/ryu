import path from "node:path";
import { expect, test } from "@playwright/test";

const proofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/feature-integrity-sweep-2026-09-22"
);

test("disabled reporting explains why no report was queued", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/preflight-actions-proof.html?mode=disabled", {
		waitUntil: "domcontentloaded",
	});
	await page.getByRole("button", { name: "Report issue", exact: true }).click();
	await expect(
		page.getByText("Report issue failed", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Crash reporting is off.", { exact: false })
	).toBeVisible();
	await expect(page.locator("body")).not.toHaveAttribute(
		"data-report-queued",
		"true"
	);
	await expect(
		page.getByRole("button", { name: "Report issue", exact: true })
	).toBeEnabled();
	await page.waitForTimeout(750);
	await page.screenshot({
		path: path.join(proofDir, "preflight-report-disabled.png"),
	});
	expect(errors).toEqual([]);
});

test("clipboard rejection is visible and the action can be retried", async ({
	page,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async () => {
					throw new Error("Clipboard permission denied");
				},
			},
		});
	});
	await page.goto("/preflight-actions-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await page
		.getByRole("button", { name: "Copy diagnostics", exact: true })
		.click();
	await expect(
		page.getByText("Copy diagnostics failed", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Clipboard permission denied", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Diagnostics copied to clipboard", { exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Copy diagnostics", exact: true })
	).toBeEnabled();
	await page.waitForTimeout(750);
	await page.screenshot({
		path: path.join(proofDir, "preflight-copy-denied.png"),
	});
});

test("capture failure is never shown as a queued report", async ({ page }) => {
	await page.goto("/preflight-actions-proof.html?mode=failed", {
		waitUntil: "domcontentloaded",
	});
	await page.getByRole("button", { name: "Report issue", exact: true }).click();
	await expect(
		page.getByText("The issue report could not be queued.", { exact: false })
	).toBeVisible();
	await expect(
		page.getByText("Issue report queued", { exact: true })
	).toHaveCount(0);
});

test("a captured report says queued without claiming delivery", async ({
	page,
}) => {
	await page.goto("/preflight-actions-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await page.getByRole("button", { name: "Report issue", exact: true }).click();
	await expect(
		page.getByText("Issue report queued", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText(
			"Delivery to the reporting service has not been confirmed.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(page.locator("body")).toHaveAttribute(
		"data-report-queued",
		"true"
	);
	await page.waitForTimeout(750);
	await page.screenshot({
		path: path.join(proofDir, "preflight-report-queued.png"),
	});
});

test("successful clipboard write receives the collected diagnostics", async ({
	page,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					document.body.dataset.copiedDiagnostics = text;
				},
			},
		});
	});
	await page.goto("/preflight-actions-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await page
		.getByRole("button", { name: "Copy diagnostics", exact: true })
		.click();
	await expect(
		page.getByText("Diagnostics copied to clipboard", { exact: true })
	).toBeVisible();
	await expect(page.locator("body")).toHaveAttribute(
		"data-copied-diagnostics",
		/# Ryu diagnostics/
	);
});
