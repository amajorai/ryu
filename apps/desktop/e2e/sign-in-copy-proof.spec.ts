import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const proofDirectory = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/sign-in-copy"
);

function watchForBrowserErrors(page: Page) {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return () => expect(errors).toEqual([]);
}

test("desktop sign-in copies the link while displaying the device code", async ({
	page,
}) => {
	const assertNoBrowserErrors = watchForBrowserErrors(page);
	await page.goto("/sign-in-copy-proof.html?surface=desktop");
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

	const deviceCode = page.getByLabel("Device sign-in code");
	await expect(deviceCode).toHaveValue("ABCD1234");
	await expect(
		page.getByRole("button", { name: "Copy sign-in link", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Copy device code", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Cancel", exact: true })
	).toHaveAttribute("class", /hover:bg-muted hover:text-foreground/);
	await expect(
		page.getByRole("button", { name: "Cancel", exact: true })
	).not.toHaveAttribute("class", /bg-background/);

	await page.getByRole("button", { name: "Copy sign-in link" }).click();
	await expect(
		page.getByRole("button", { name: "Sign-in link copied", exact: false })
	).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("https://example.test/device?user_code=ABCD1234");

	await mkdir(proofDirectory, { recursive: true });
	await page.screenshot({
		path: path.join(proofDirectory, "desktop-sign-in.png"),
		fullPage: true,
		animations: "disabled",
	});
	assertNoBrowserErrors();
});

test("web activation accepts the same code through the grouped OTP input", async ({
	page,
}) => {
	const assertNoBrowserErrors = watchForBrowserErrors(page);
	await page.goto("/sign-in-copy-proof.html?surface=web");
	await expect(
		page.getByRole("heading", { name: "Activate device" })
	).toBeVisible();

	const codeInput = page.getByLabel("Device activation code");
	await codeInput.pressSequentially("abcd1234");
	await expect(page.getByTestId("completed-code")).toHaveText("ABCD1234");
	await expect(page.locator('[data-filled="true"]')).toHaveCount(8);
	const continueButton = page.getByRole("button", { name: "Continue" });
	await expect(continueButton).toBeEnabled();
	const [lastOtpCellBox, continueButtonBox] = await Promise.all([
		page.locator("[data-otp-index]").last().boundingBox(),
		continueButton.boundingBox(),
	]);
	if (!(lastOtpCellBox && continueButtonBox)) {
		throw new Error("OTP field or Continue button is not visible");
	}
	expect(
		continueButtonBox.y - (lastOtpCellBox.y + lastOtpCellBox.height)
	).toBeGreaterThanOrEqual(22);

	await mkdir(proofDirectory, { recursive: true });
	await page.screenshot({
		path: path.join(proofDirectory, "web-device-code.png"),
		fullPage: true,
		animations: "disabled",
	});
	assertNoBrowserErrors();
});

test("web activation follows a shorter linked device-code length", async ({
	page,
}) => {
	const assertNoBrowserErrors = watchForBrowserErrors(page);
	await page.goto("/sign-in-copy-proof.html?surface=web-short");

	const codeInput = page.getByLabel("Device activation code");
	await codeInput.pressSequentially("ab123c");
	await expect(page.getByTestId("completed-code")).toHaveText("AB123C");
	await expect(page.locator("[data-otp-index]")).toHaveCount(6);
	await expect(page.locator('[data-filled="true"]')).toHaveCount(6);
	await expect(page.locator("[data-otp-separator]")).toHaveCount(1);
	assertNoBrowserErrors();
});
