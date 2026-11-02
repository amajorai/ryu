import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	clipboardText,
	EVIDENCE_DIR,
	failAuth,
	failRequest,
	openProof,
	type ProofWindow,
	setClipboardFailure,
} from "./developer-account-sessions-settings-proof.helpers.ts";

declare const window: Window;

test("developer settings gate opt-in capture, performance actions, and diagnostic copy feedback", async ({
	page,
}, testInfo) => {
	await openProof(page);
	const developer = page.getByTestId("developer-tab");
	const devMode = developer.getByRole("switch").first();
	await expect(devMode).toHaveAttribute("aria-checked", "false");
	await expect(
		developer.getByRole("button", { name: "Copy diagnostics" })
	).toHaveCount(0);
	await devMode.click();
	await expect(devMode).toHaveAttribute("aria-checked", "true");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_developer_mode")))
		.toBe("true");
	await expect(developer.getByRole("switch").nth(1)).toBeChecked();
	await expect(developer.getByRole("switch").nth(1)).toBeDisabled();
	await expect(developer.getByRole("switch").nth(2)).toBeChecked();
	await expect(developer.getByRole("switch").nth(2)).toBeDisabled();
	await expect(
		developer.getByRole("heading", { name: "Performance" })
	).toBeVisible();
	await expect(
		developer.getByRole("button", { name: "Copy diagnostics" })
	).toBeVisible();
	await developer
		.getByRole("button", { name: "Copy console", exact: true })
		.click();
	await expect(page.getByText("Console buffer is empty")).toBeVisible();

	await page.evaluate(() => {
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofRecordMetrics before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofRecordMetrics();
	});
	const metrics = await page.evaluate(() =>
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofReadMetrics before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofReadMetrics()
	);
	if (!metrics.text) {
		throw new Error(
			`Performance sample was not captured: ${JSON.stringify(metrics)}`
		);
	}
	await expect(
		developer.getByText("/api/sessions", { exact: true })
	).toBeVisible();
	await developer.getByRole("button", { name: "Copy", exact: true }).click();
	await expect.poll(() => clipboardText(page)).toContain("/api/sessions");
	await expect(
		page.getByText("Performance metrics copied to clipboard")
	).toBeVisible();
	await developer.getByRole("button", { name: "Clear", exact: true }).click();
	await expect(developer.getByText("Nothing recorded yet.")).toBeVisible();
	await developer.getByRole("button", { name: "Copy", exact: true }).click();
	await expect(page.getByText("No metrics recorded yet")).toBeVisible();
	await page.evaluate(() => {
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofRecordMetrics before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofRecordMetrics();
	});
	await setClipboardFailure(page, true);
	await developer.getByRole("button", { name: "Copy", exact: true }).click();
	await expect(page.getByText("Couldn't copy to clipboard")).toBeVisible();
	await setClipboardFailure(page, false);

	await page.evaluate(() => console.info("developer opt-in marker"));
	await setClipboardFailure(page, true);
	await developer
		.getByRole("button", { name: "Copy console", exact: true })
		.click();
	await expect(page.getByText("Couldn't copy to clipboard")).toBeVisible();
	await setClipboardFailure(page, false);
	await developer
		.getByRole("button", { name: "Copy console", exact: true })
		.click();
	await expect
		.poll(() => clipboardText(page))
		.toContain("developer opt-in marker");
	await devMode.click();
	await expect(devMode).toHaveAttribute("aria-checked", "false");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_developer_mode")))
		.toBe("false");
	await expect(
		developer.getByRole("button", { name: "Copy console" })
	).toHaveCount(0);
	await page.evaluate(() => console.info("developer opt-out marker"));
	await devMode.click();
	await expect(devMode).toHaveAttribute("aria-checked", "true");
	await page.evaluate(() => {
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofRecordMetrics before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofRecordMetrics();
	});
	await expect(
		developer.getByText("turns", { exact: true }).locator("..").getByText("2", {
			exact: true,
		})
	).toBeVisible();
	await developer
		.getByRole("button", { name: "Copy console", exact: true })
		.click();
	await expect
		.poll(() => clipboardText(page))
		.not.toContain("developer opt-out marker");

	await developer
		.getByRole("button", { name: "Copy diagnostics", exact: true })
		.click();
	await expect.poll(() => clipboardText(page)).toContain("# Ryu diagnostics");
	await expect
		.poll(() => clipboardText(page))
		.toContain("## Health (/api/health)");
	await expect(page.getByText("Diagnostics copied to clipboard")).toBeVisible();
	await setClipboardFailure(page, true);
	await developer
		.getByRole("button", { name: "Copy diagnostics", exact: true })
		.click();
	await expect(page.getByText("Couldn't copy diagnostics")).toBeVisible();
	await setClipboardFailure(page, false);

	await page.evaluate(() =>
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofClearToasts before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofClearToasts()
	);
	await developer.screenshot({
		path: path.join(EVIDENCE_DIR, "desktop-developer-settings-controls.png"),
	});
	await devMode.click();
	await expect(devMode).toHaveAttribute("aria-checked", "false");
	await page.reload();
	const reloadedDeveloper = page.getByTestId("developer-tab");
	await expect(reloadedDeveloper.getByRole("switch").first()).not.toBeChecked();
	await expect(
		reloadedDeveloper.getByRole("button", { name: "Copy diagnostics" })
	).toHaveCount(0);
	expect(testInfo.status).toBe("passed");
});

test("daily data reset persists, reports failed writes, and stays hidden on unsupported profiles", async ({
	page,
}) => {
	await openProof(page);
	const developer = page.getByTestId("developer-tab");
	const reset = developer.getByRole("switch").nth(1);
	await expect(reset).toBeVisible();
	await expect(reset).toHaveAttribute("aria-checked", "false");
	await reset.click();
	await expect(reset).toHaveAttribute("aria-checked", "true");
	await expect(
		page.getByText(/Daily reset on\. This build's data folder clears/)
	).toBeVisible();
	await page.reload();
	await expect(developer.getByRole("switch").nth(1)).toBeChecked();
	await developer.getByRole("switch").nth(1).click();
	await expect(developer.getByRole("switch").nth(1)).not.toBeChecked();
	await page.evaluate(() => {
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofFailCommand before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofFailCommand("set_midnight_wipe");
	});
	await developer.getByRole("switch").nth(1).click();
	await expect(developer.getByRole("switch").nth(1)).not.toBeChecked();
	await expect(
		page.getByText("Couldn't save that setting").last()
	).toBeVisible();

	await page.addInitScript(() => {
		localStorage.removeItem("settings-proof-midnight-wipe");
	});
	await openProof(page, "?unsupported=true");
	await expect(
		page.getByTestId("developer-tab").getByText("Daily data reset")
	).toHaveCount(0);
});

test("account email, password, and copied user ID controls support cancel, failures, and success", async ({
	page,
}, testInfo) => {
	await openProof(page);
	const account = page.getByTestId("account-tab");
	await expect(account.getByText("security@example.test")).toBeVisible();

	await account.getByRole("button", { name: "Change Email" }).click();
	const emailDialog = page.getByRole("dialog", {
		name: "Change Email Address",
	});
	await expect(emailDialog.getByLabel("Current Email")).toHaveValue(
		"security@example.test"
	);
	await expect(emailDialog.getByLabel("Current Email")).toBeDisabled();
	await expect(
		emailDialog.getByRole("button", { name: "Send Verification" })
	).toBeDisabled();
	await emailDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(emailDialog).toHaveCount(0);

	await account.getByRole("button", { name: "Change Email" }).click();
	await emailDialog.getByLabel("New Email").fill("next@example.test");
	await failRequest(page, "/api/user/initiate-email-change");
	await emailDialog.getByRole("button", { name: "Send Verification" }).click();
	const emailFailureDebug = await page.evaluate(() => ({
		calls:
			/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofCalls before this proof page is evaluated. */ (
				window as ProofWindow
			).__settingsProofCalls,
		text: document.body.innerText,
	}));
	const failedEmailMutation = emailFailureDebug.calls.find(
		(call) => call.path === "/api/user/initiate-email-change"
	);
	if (
		failedEmailMutation?.method !== "POST" ||
		JSON.stringify(failedEmailMutation.body) !==
			JSON.stringify({ newEmail: "next@example.test" })
	) {
		throw new Error(
			`Email mutation payload was incorrect: ${JSON.stringify(emailFailureDebug)}`
		);
	}
	await expect(
		page.getByText("Fixture rejected /api/user/initiate-email-change")
	).toBeVisible();
	await expect(emailDialog).toBeVisible();
	await emailDialog.getByRole("button", { name: "Send Verification" }).click();
	await expect(emailDialog).toHaveCount(0);
	await expect(page.getByText("Email change pending")).toBeVisible();
	const emailMutations = await page.evaluate(() =>
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofCalls before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofCalls.filter(
			(call) => call.path === "/api/user/initiate-email-change"
		)
	);
	expect(emailMutations).toEqual([
		{
			body: { newEmail: "next@example.test" },
			method: "POST",
			path: "/api/user/initiate-email-change",
		},
		{
			body: { newEmail: "next@example.test" },
			method: "POST",
			path: "/api/user/initiate-email-change",
		},
	]);
	await expect(
		page.getByText("Verification emails sent to both addresses.")
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Cancel change" })
	).toBeVisible();
	await failRequest(page, "/api/user/cancel-email-change");
	await page.getByRole("button", { name: "Cancel change" }).click();
	await expect(page.getByText("Failed to cancel email change")).toBeVisible();
	await expect(page.getByText("Email change pending")).toBeVisible();
	await page.getByRole("button", { name: "Cancel change" }).click();
	await expect(page.getByText("Email change pending")).toHaveCount(0);

	await account.getByRole("button", { name: "Change Password" }).click();
	const passwordDialog = page.getByRole("dialog", { name: "Change Password" });
	await expect(
		passwordDialog.getByRole("button", { name: "Update Password" })
	).toBeDisabled();
	await passwordDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(passwordDialog).toHaveCount(0);
	await account.getByRole("button", { name: "Change Password" }).click();
	await passwordDialog
		.getByLabel("New Password", { exact: true })
		.fill("short");
	await passwordDialog.getByLabel("Confirm New Password").fill("short");
	await passwordDialog.getByRole("button", { name: "Update Password" }).click();
	await expect(passwordDialog).toBeVisible();
	// Eight characters are not enough: the sign-up rules also ask for an
	// uppercase letter, a number and a symbol, and the dialog says which is missing.
	await passwordDialog
		.getByLabel("New Password", { exact: true })
		.fill("abcdefgh-123");
	await passwordDialog.getByLabel("Confirm New Password").fill("abcdefgh-123");
	await passwordDialog.getByRole("button", { name: "Update Password" }).click();
	await expect(
		page.getByText("Password needs one uppercase letter")
	).toBeVisible();
	await expect(passwordDialog).toBeVisible();
	await passwordDialog
		.getByLabel("New Password", { exact: true })
		.fill("Abcdefgh-123");
	await passwordDialog.getByLabel("Confirm New Password").fill("Abcdefgh-456");
	await passwordDialog.getByRole("button", { name: "Update Password" }).click();
	await expect(page.getByText("Passwords do not match")).toBeVisible();
	await passwordDialog.getByLabel("Confirm New Password").fill("Abcdefgh-123");
	await failRequest(page, "/api/user/set-password");
	await passwordDialog.getByRole("button", { name: "Update Password" }).click();
	await expect(
		page.getByText("Fixture rejected /api/user/set-password")
	).toBeVisible();
	await expect(passwordDialog).toBeVisible();
	await passwordDialog.getByRole("button", { name: "Update Password" }).click();
	await expect(passwordDialog).toHaveCount(0);
	await expect(page.getByText("Password updated")).toBeVisible();
	const passwordMutations = await page.evaluate(() =>
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofCalls before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofCalls.filter(
			(call) => call.path === "/api/user/set-password"
		)
	);
	expect(passwordMutations).toEqual([
		{
			body: { newPassword: "Abcdefgh-123" },
			method: "POST",
			path: "/api/user/set-password",
		},
		{
			body: { newPassword: "Abcdefgh-123" },
			method: "POST",
			path: "/api/user/set-password",
		},
	]);
	await expect(account.getByText("Password is set")).toBeVisible();

	await setClipboardFailure(page, true);
	await account.getByRole("button", { name: "Copy user ID" }).click();
	await expect(page.getByText("Copy failed")).toBeVisible();
	await setClipboardFailure(page, false);
	await account.getByRole("button", { name: "Copy user ID" }).click();
	await expect.poll(() => clipboardText(page)).toBe("coverage-user");
	await expect(page.getByText("Copied user ID")).toBeVisible();

	await page.evaluate(() =>
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofClearToasts before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofClearToasts()
	);
	await account.screenshot({
		path: path.join(EVIDENCE_DIR, "desktop-account-security-controls.png"),
	});
	expect(testInfo.status).toBe("passed");
});

test("passwordless users can set a password and the account row changes state", async ({
	page,
}) => {
	await openProof(page, "?passwordless=true");
	const account = page.getByTestId("account-tab");
	await expect(
		account.getByRole("button", { name: "Set Password" })
	).toBeVisible();
	await account.getByRole("button", { name: "Set Password" }).click();
	const dialog = page.getByRole("dialog", { name: "Set Password" });
	await expect(dialog).toBeVisible({ timeout: 5000 });
	await dialog
		.getByLabel("New Password", { exact: true })
		.fill("Coverage-pass-123!");
	await dialog.getByLabel("Confirm New Password").fill("Coverage-pass-123!");
	await dialog.getByRole("button", { name: "Set Password" }).click();
	const passwordCalls = await page.evaluate(() =>
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofCalls before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofCalls.map((call) => call.path)
	);
	if (!passwordCalls.includes("/api/user/set-password")) {
		throw new Error(
			`Password mutation was not requested: ${JSON.stringify(passwordCalls)}`
		);
	}
	await expect(dialog).toHaveCount(0);
	await expect(
		account.getByRole("button", { name: "Change Password" })
	).toBeVisible();
});

test("unverified email resend reports failures and enforces its cooldown", async ({
	page,
}) => {
	await openProof(page, "?email-unverified=true");
	const account = page.getByTestId("account-tab");
	const resend = account.getByRole("button", { name: "Resend", exact: true });
	await expect(resend).toBeVisible();
	await failAuth(page, "sendVerificationEmail");
	await resend.click();
	await expect(
		page.getByText("Failed to send verification email. Please try again.")
	).toBeVisible();
	await expect(resend).toBeEnabled();
	await resend.click();
	await expect(
		page.getByText("Verification email sent. Check your inbox.")
	).toBeVisible();
	const cooldown = account.getByRole("button", { name: /Resend in \d+s/ });
	await expect(cooldown).toBeDisabled();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofAuthCalls before this proof page is evaluated. */ (
						window as ProofWindow
					).__settingsProofAuthCalls.length
			)
		)
		.toBe(2);
});
