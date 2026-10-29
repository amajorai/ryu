import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

test("tool-access demo toggles each tool and model and announces the active count", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1440 });
	await page.goto("/web-product-demo-previews-proof.html");
	const preview = page.getByTestId("tool-access-preview");
	const available = preview.locator('[aria-live="polite"]');
	await expect(available).toHaveText("2 tools available to Claude");

	await page.getByRole("tab", { name: "ChatGPT", exact: true }).click();
	await expect(
		page.getByRole("tab", { name: "ChatGPT", exact: true })
	).toHaveAttribute("aria-selected", "true");
	await page.getByRole("switch", { name: "GitHub", exact: true }).click();
	await expect(available).toHaveText("3 tools available to ChatGPT");
	await page.getByRole("switch", { name: "Slack", exact: true }).click();
	await expect(available).toHaveText("4 tools available to ChatGPT");
	await page.getByRole("switch", { name: "Gmail", exact: true }).click();
	await expect(available).toHaveText("3 tools available to ChatGPT");
	await page.getByRole("switch", { name: "Notion", exact: true }).click();
	await expect(available).toHaveText("2 tools available to ChatGPT");
	await expect(
		page.getByRole("switch", { name: "Gmail", exact: true })
	).toHaveAttribute("aria-checked", "false");
	await expect(
		page.getByRole("switch", { name: "GitHub", exact: true })
	).toHaveAttribute("aria-checked", "true");

	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(
			EVIDENCE_DIR,
			"web-product-demo-tool-access-interactions.png"
		),
	});
});

test("deployment demo shows the selected hosting model in its visual summary", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1440 });
	await page.goto("/web-product-demo-previews-proof.html");
	const preview = page.getByTestId("deployment-preview");
	await expect(
		preview.getByText("Ryu Cloud", { exact: true }).first()
	).toBeVisible();
	await expect(
		preview.getByText("Managed by Ryu", { exact: true })
	).toBeVisible();

	await page.getByRole("tab", { name: "Self-hosted", exact: true }).click();
	await expect(
		page.getByRole("tab", { name: "Self-hosted", exact: true })
	).toHaveAttribute("aria-selected", "true");
	await expect(preview.getByText("Your server", { exact: true })).toBeVisible();
	await expect(
		preview.getByText("Managed by your team", { exact: true })
	).toBeVisible();
	await expect(preview.getByText("Ryu Cloud", { exact: true })).toHaveCount(1);

	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(
			EVIDENCE_DIR,
			"web-product-demo-deployment-self-hosted.png"
		),
	});
});

test("compact previews keep their own selected model and remain interactive", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 430 });
	await page.goto("/web-product-demo-previews-proof.html?compact=1");

	const toolPreview = page.getByTestId("tool-access-preview");
	await expect(toolPreview.locator('[aria-live="polite"]')).toHaveText(
		"2 tools available to Claude"
	);
	await page.getByRole("tab", { name: "Local", exact: true }).click();
	await page.getByRole("switch", { name: "GitHub", exact: true }).click();
	await expect(toolPreview.locator('[aria-live="polite"]')).toHaveText(
		"3 tools available to Local"
	);

	const deploymentPreview = page.getByTestId("deployment-preview");
	await expect(
		deploymentPreview.getByRole("tab", { name: "Cloud", exact: true })
	).toHaveAttribute("aria-selected", "true");
	await expect(
		deploymentPreview.getByText("Ryu Cloud", { exact: true })
	).toBeVisible();
	await page.getByRole("tab", { name: "Self-hosted", exact: true }).click();
	await expect(
		deploymentPreview.getByText("Your server", { exact: true })
	).toBeVisible();
	await expect(
		deploymentPreview.getByText("Managed by your team", { exact: true })
	).toHaveCount(0);
	await expect(
		deploymentPreview.getByText("Self-hosted", { exact: true })
	).toBeVisible();

	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "web-product-demo-compact-previews.png"),
	});
});
