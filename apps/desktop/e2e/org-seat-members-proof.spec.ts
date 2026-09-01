import path from "node:path";
import { expect, test } from "@playwright/test";

test("shows active and allocated capacity and blocks an over-cap invite", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});

	await page.goto("/org-seat-members-proof.html");
	await expect(page.getByTestId("proof-status")).toHaveText("VERIFIED");
	await expect(page.getByTestId("organization-seat-count")).toHaveText(
		"4/5 seats"
	);
	await expect(page.getByTestId("organization-seat-allocation")).toHaveText(
		"5/5 allocated"
	);
	await expect(
		page.getByRole("button", { name: "Send invite" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Buy more seats" })
	).toBeVisible();
	await expect(
		page.getByText("1 pending invitation reserved", { exact: false })
	).toBeVisible();
	await expect(page.getByText("finance@northstar.example")).toBeVisible();

	if (errors.length > 0) {
		throw new Error(
			`Organization seat proof logged errors: ${errors.join(" | ")}`
		);
	}

	await page.screenshot({
		fullPage: true,
		path: path.resolve(
			test.info().project.testDir,
			"proof",
			"org-seat-members-capacity-proof.png"
		),
	});
});
