// Continues marketplace-publish-dialog-proof.spec.ts (split under the file token limit); helpers live in marketplace-publish-dialog-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	openPublisher,
	publishRequests,
	readProof,
	screenshotPath,
	selectOffer,
} from "./marketplace-publish-dialog-proof.helpers.ts";

test.describe.configure({ timeout: 60_000 });

test("sign-in is required before publishing and the dialog close button resets the draft", async ({
	page,
}) => {
	await openPublisher(page);
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/unsigned-app");
	await selectOffer(page, "One-time purchase");
	await dialog.getByLabel("Price").fill("4.25");
	await page.evaluate(() => localStorage.removeItem("ryu_session_token"));
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.getByTestId("dialog-open-state")).toHaveText("closed");
	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();

	const reopened = page.getByRole("dialog");
	await expect(
		reopened.getByText(
			"Sign in to your Ryu account to publish to the marketplace."
		)
	).toBeVisible();
	await expect(
		reopened.getByRole("button", { name: "Submit GitHub package" })
	).toBeDisabled();
	await expect(
		reopened.getByLabel("GitHub repository or package URL")
	).toHaveValue("");
	await expect(reopened.getByLabel("Offer")).toContainText("Free");
	expect(publishRequests(await readProof(page))).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("marketplace-publish-sign-in-required.png"),
	});
});

test("Escape closes and resets the dialog without a publish request", async ({
	page,
}) => {
	await openPublisher(page);
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/escape-cancelled-app");
	await selectOffer(page, "Subscription");
	await dialog.getByLabel("Price").fill("8.25");
	await dialog.getByLabel("Currency").fill("JPY");
	await dialog.getByLabel("Billing interval").click();
	await page.getByRole("option", { name: "Yearly", exact: true }).click();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("dialog-open-state")).toHaveText("closed");
	expect(publishRequests(await readProof(page))).toEqual([]);

	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	const reopened = page.getByRole("dialog");
	await expect(
		reopened.getByLabel("GitHub repository or package URL")
	).toHaveValue("");
	await expect(reopened.getByLabel("Offer")).toContainText("Free");
	await selectOffer(page, "Subscription");
	await expect(reopened.getByLabel("Price")).toHaveValue("");
	await expect(reopened.getByLabel("Currency")).toHaveValue("USD");
	await expect(reopened.getByLabel("Billing interval")).toContainText(
		"Monthly"
	);
	await selectOffer(page, "Bounded updates");
	await expect(reopened.getByLabel("Included updates")).toHaveValue("3");
	expect(publishRequests(await readProof(page))).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("marketplace-publish-escape-reset.png"),
	});
});

test("Cancel and Done close the dialog and reset repository and offer drafts", async ({
	page,
}) => {
	await openPublisher(page);
	let dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/cancelled-app");
	await selectOffer(page, "Subscription");
	await dialog.getByLabel("Price").fill("7.50");
	await dialog.getByLabel("Currency").fill("CAD");
	await dialog.getByLabel("Billing interval").click();
	await page.getByRole("option", { name: "Yearly", exact: true }).click();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByTestId("dialog-open-state")).toHaveText("closed");
	expect(publishRequests(await readProof(page))).toEqual([]);

	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	dialog = page.getByRole("dialog");
	await expect(
		dialog.getByLabel("GitHub repository or package URL")
	).toHaveValue("");
	await expect(dialog.getByLabel("Offer")).toContainText("Free");
	await expect(
		dialog.getByText("Free packages need no seller payout setup.")
	).toBeVisible();
	await selectOffer(page, "Subscription");
	await expect(dialog.getByLabel("Price")).toHaveValue("");
	await expect(dialog.getByLabel("Currency")).toHaveValue("USD");
	await expect(dialog.getByLabel("Billing interval")).toContainText("Monthly");
	await selectOffer(page, "Bounded updates");
	await expect(dialog.getByLabel("Included updates")).toHaveValue("3");
	await selectOffer(page, "Free");
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/done-reset-app");
	await dialog.getByRole("button", { name: "Submit GitHub package" }).click();
	await expect(page.getByText("Submitted for review")).toBeVisible();
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await expect(page.getByTestId("dialog-open-state")).toHaveText("closed");
	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	dialog = page.getByRole("dialog");
	await expect(
		dialog.getByLabel("GitHub repository or package URL")
	).toHaveValue("");
	await expect(dialog.getByLabel("Offer")).toContainText("Free");
	await expect(page.getByText("Submitted for review")).toHaveCount(0);
	await selectOffer(page, "Subscription");
	await expect(dialog.getByLabel("Price")).toHaveValue("");
	await expect(dialog.getByLabel("Currency")).toHaveValue("USD");
	await expect(dialog.getByLabel("Billing interval")).toContainText("Monthly");
	await selectOffer(page, "Bounded updates");
	await expect(dialog.getByLabel("Included updates")).toHaveValue("3");
});
