import path from "node:path";
import { expect, test } from "@playwright/test";

const STORY_URL = "/mesh-auto-install-proof.html";

test.describe.configure({ timeout: 120_000 });

test("shows the Tailcat no-setup default and managed install copy", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));

	await page.goto(STORY_URL);
	await expect(page.locator("body")).toHaveAttribute(
		"data-harness-ready",
		"true"
	);

	const networkHeading = page.getByRole("heading", {
		name: "Network (Tailscale / Headscale / Tailcat)",
	});
	await expect(networkHeading).toBeVisible();
	await expect(
		page.getByText(
			"Ryu installs the selected network client automatically; Headscale still needs the URL of its control server.",
			{ exact: false }
		)
	).toBeVisible();
	await expect(page.getByText("Enable private network")).toBeVisible();
	await expect(
		page.getByText(
			"Ryu installs Tailcat automatically. Tailcat has no account, control server, or tailnet; it creates a short-lived address for this node.",
			{ exact: true }
		)
	).toBeVisible();

	await page.screenshot({
		fullPage: true,
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/mesh-auto-install-proof-2026-08-31.png"
		),
	});

	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});
