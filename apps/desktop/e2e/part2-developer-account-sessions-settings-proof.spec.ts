// Continues developer-account-sessions-settings-proof.spec.ts (split under the file token limit); helpers live in developer-account-sessions-settings-proof.helpers.ts.

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

test("two-factor enrollment and management exercise every dialog action and error state", async ({
	page,
}, testInfo) => {
	await openProof(page);
	const account = page.getByTestId("account-tab");
	const enable = account.getByRole("button", { name: "Enable 2FA" });
	await enable.click();
	const dialog = page.getByRole("dialog", {
		name: "Enable Two-Factor Authentication",
	});
	const continueButton = dialog.getByRole("button", { name: "Continue" });
	await expect(continueButton).toBeDisabled();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);

	await account.getByRole("button", { name: "Enable 2FA" }).click();
	const setupDialog = page.getByRole("dialog", {
		name: "Enable Two-Factor Authentication",
	});
	await setupDialog.getByLabel("Password").fill("coverage-password");
	await failAuth(page, "enable");
	await setupDialog.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByText("Fixture enable failure")).toBeVisible();
	await expect(setupDialog).toBeVisible();
	await setupDialog.getByRole("button", { name: "Continue" }).click();

	let qrDialog = page.getByRole("dialog", { name: "Scan QR Code" });
	const expandQr = qrDialog.getByRole("button", { name: "Expand QR code" });
	await expect(expandQr).toBeVisible();
	await expandQr.evaluate((button) => {
		if (!(button instanceof HTMLButtonElement)) {
			throw new Error("Expected proof element to be an HTMLButtonElement.");
		}
		return button.click();
	});
	const expandedQr = page.getByRole("dialog", { name: "Expanded QR code" });
	await expect(expandedQr).toBeVisible();
	await expandedQr.locator("[data-slot='dialog-close']").evaluate((button) => {
		if (!(button instanceof HTMLButtonElement)) {
			throw new Error("Expected proof element to be an HTMLButtonElement.");
		}

		button.click();
	});
	await expect(expandedQr).toHaveCount(0);
	await expect(qrDialog).toBeVisible();
	await qrDialog
		.getByRole("button", { name: "Can’t scan? Enter setup key manually" })
		.click();
	const setupKey = qrDialog.getByRole("textbox", {
		name: "Authenticator setup key",
	});
	await expect(setupKey).toHaveValue("JBSWY3DPEHPK3PXP");
	await setClipboardFailure(page, true);
	await qrDialog
		.getByRole("button", { name: "Copy authenticator setup key" })
		.click();
	await expect(page.getByText("Couldn't copy setup key")).toBeVisible();
	await expect.poll(() => clipboardText(page)).toBe("");
	await setClipboardFailure(page, false);
	await qrDialog
		.getByRole("button", { name: "Copy authenticator setup key" })
		.click();
	await expect.poll(() => clipboardText(page)).toBe("JBSWY3DPEHPK3PXP");
	await expect(page.getByText("Setup key copied")).toBeVisible();
	await qrDialog.getByText("Show setup URL").click();
	await expect(qrDialog.locator("code")).toContainText("otpauth://totp/Ryu:");
	await qrDialog.getByRole("button", { name: "Hide manual setup" }).click();
	await expect(qrDialog.getByLabel("Authenticator setup key")).toHaveCount(0);
	await qrDialog.getByRole("button", { name: "Back", exact: true }).click();
	await expect(setupDialog).toBeVisible();
	await setupDialog.getByLabel("Password").fill("coverage-password");
	await setupDialog.getByRole("button", { name: "Continue" }).click();
	qrDialog = page.getByRole("dialog", { name: "Scan QR Code" });
	await qrDialog.getByRole("button", { name: "I've scanned it" }).click();

	let verifyDialog = page.getByRole("dialog", { name: "Verify Code" });
	await verifyDialog
		.getByRole("button", { name: "Back", exact: true })
		.last()
		.click();
	await expect(qrDialog).toBeVisible();
	await qrDialog.getByRole("button", { name: "I've scanned it" }).click();
	verifyDialog = page.getByRole("dialog", { name: "Verify Code" });
	const otp = verifyDialog.getByRole("textbox", {
		name: "Authenticator app code",
	});
	const verify = verifyDialog.getByRole("button", { name: "Verify" });
	await expect(verify).toBeDisabled();
	await otp.fill("000000");
	await verify.click();
	await expect(
		verifyDialog.getByText("Invalid code. Try again.")
	).toBeVisible();
	await verifyDialog
		.getByRole("button", { name: "Back", exact: true })
		.last()
		.click();
	qrDialog = page.getByRole("dialog", { name: "Scan QR Code" });
	await expect(qrDialog).toBeVisible();
	await qrDialog.getByRole("button", { name: "I've scanned it" }).click();
	verifyDialog = page.getByRole("dialog", { name: "Verify Code" });
	await otp.fill("123456");
	await verify.click();

	const backupDialog = page.getByRole("dialog", { name: "Save Backup Codes" });
	await expect(backupDialog.getByText("A1B2C-D3E4F")).toBeVisible();
	await expect(verifyDialog).toHaveCount(0);
	await expect(page.getByText("Verify Code", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Verifying…", { exact: true })).toHaveCount(0);
	await page.evaluate(() =>
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofClearToasts before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofClearToasts()
	);
	await backupDialog.screenshot({
		path: path.join(EVIDENCE_DIR, "desktop-two-factor-controls.png"),
	});
	await setClipboardFailure(page, true);
	await backupDialog.getByRole("button", { name: "Copy all codes" }).click();
	await expect(page.getByText("Couldn't copy backup codes")).toBeVisible();
	await expect(
		backupDialog.getByRole("button", { name: "Copy all codes" })
	).toBeVisible();
	await setClipboardFailure(page, false);
	await backupDialog.getByRole("button", { name: "Copy all codes" }).click();
	await expect.poll(() => clipboardText(page)).toContain("A1B2C-D3E4F");
	await expect(
		backupDialog.getByRole("button", { name: "Copied" })
	).toBeVisible();
	await backupDialog.getByRole("button", { name: "I've saved them" }).click();
	const confirmDialog = page.getByRole("dialog", {
		name: "Confirm Your Backup Codes",
	});
	await expect(
		confirmDialog.getByRole("button", { name: "Confirm" })
	).toBeDisabled();
	await confirmDialog.getByLabel("Backup code").fill("not-a-code");
	await confirmDialog.getByRole("button", { name: "Confirm" }).click();
	const saveReminderDialog = page.getByRole("dialog", {
		name: "Save Backup Codes",
	});
	await expect(
		saveReminderDialog.getByText("These codes are critical")
	).toBeVisible();
	await expect(page.getByText("That code didn't match")).toBeVisible();
	await page
		.getByRole("dialog", { name: "Save Backup Codes" })
		.getByRole("button", { name: "I've saved them" })
		.click();
	await page
		.getByRole("dialog", { name: "Confirm Your Backup Codes" })
		.getByRole("button", { name: "Back", exact: true })
		.click();
	await page
		.getByRole("dialog", { name: "Save Backup Codes" })
		.getByRole("button", { name: "I've saved them" })
		.click();
	const confirmedCode = "a1b2cd3e4f";
	await page
		.getByRole("dialog", { name: "Confirm Your Backup Codes" })
		.getByLabel("Backup code")
		.fill(confirmedCode);
	await page
		.getByRole("dialog", { name: "Confirm Your Backup Codes" })
		.getByRole("button", { name: "Confirm" })
		.click();
	await expect(
		page.getByRole("dialog", { name: "Confirm Your Backup Codes" })
	).toHaveCount(0);
	const manage = account.getByRole("button", { name: "Manage 2FA" });
	await expect(manage).toBeVisible();

	await manage.click();
	let manageDialog = page.getByRole("dialog", {
		name: "Manage Two-Factor Authentication",
	});
	const regenerate = manageDialog.getByRole("button", {
		name: "Regenerate Backup Codes",
	});
	const disable = manageDialog.getByRole("button", { name: "Disable 2FA" });
	await expect(regenerate).toBeDisabled();
	await expect(disable).toBeDisabled();
	await manageDialog.getByRole("button", { name: "Close" }).first().click();
	await expect(manageDialog).toHaveCount(0);
	await account.getByRole("button", { name: "Manage 2FA" }).click();
	manageDialog = page.getByRole("dialog", {
		name: "Manage Two-Factor Authentication",
	});
	await manageDialog.locator("[data-slot='dialog-close']").click();
	await expect(manageDialog).toHaveCount(0);

	await account.getByRole("button", { name: "Manage 2FA" }).click();
	manageDialog = page.getByRole("dialog", {
		name: "Manage Two-Factor Authentication",
	});
	await manageDialog
		.getByLabel("Password required for all actions")
		.fill("coverage-password");
	await failAuth(page, "generateBackupCodes");
	await manageDialog
		.getByRole("button", { name: "Regenerate Backup Codes" })
		.click();
	await expect(
		page.getByText("Fixture generateBackupCodes failure")
	).toBeVisible();
	await expect(manageDialog).toBeVisible();
	await manageDialog
		.getByRole("button", { name: "Regenerate Backup Codes" })
		.click();
	const regenerated = page.getByRole("dialog", { name: "Save Backup Codes" });
	await expect(regenerated.getByText("T3U4V-W5X6Y")).toBeVisible();
	await regenerated.getByRole("button", { name: "Copy all codes" }).click();
	await expect.poll(() => clipboardText(page)).toContain("T3U4V-W5X6Y");
	await regenerated.getByRole("button", { name: "I've saved them" }).click();
	const regeneratedConfirm = page.getByRole("dialog", {
		name: "Confirm Your Backup Codes",
	});
	await regeneratedConfirm.getByLabel("Backup code").fill("t3u4vw5x6y");
	await regeneratedConfirm.getByRole("button", { name: "Confirm" }).click();
	await expect(regeneratedConfirm).toHaveCount(0);

	await account.getByRole("button", { name: "Manage 2FA" }).click();
	manageDialog = page.getByRole("dialog", {
		name: "Manage Two-Factor Authentication",
	});
	await manageDialog
		.getByLabel("Password required for all actions")
		.fill("coverage-password");
	await failAuth(page, "disable");
	await manageDialog.getByRole("button", { name: "Disable 2FA" }).click();
	await expect(page.getByText("Fixture disable failure")).toBeVisible();
	await expect(manageDialog).toBeVisible();
	await manageDialog.getByRole("button", { name: "Disable 2FA" }).click();
	await expect(manageDialog).toHaveCount(0);
	await expect(
		account.getByRole("button", { name: "Enable 2FA" })
	).toBeVisible();

	expect(testInfo.status).toBe("passed");
});

test("active sessions protect the current session and cover retry, cancel, errors, disabled state, and bulk revocation", async ({
	page,
}, testInfo) => {
	await openProof(page);
	const activeSessions = page.getByTestId("sessions-tab");
	await expect(
		activeSessions.getByText("Chrome", { exact: true })
	).toBeVisible();
	await expect(activeSessions.getByText("This device")).toBeVisible();
	await expect(
		activeSessions.getByText("This device").locator("..")
	).toContainText("Chrome");
	const revokeButtons = activeSessions.getByRole("button", {
		name: "Revoke session",
	});
	await expect(revokeButtons).toHaveCount(2);
	await page.evaluate(() =>
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofClearToasts before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofClearToasts()
	);
	await activeSessions.screenshot({
		path: path.join(EVIDENCE_DIR, "desktop-active-sessions-controls.png"),
	});

	await page.evaluate(() => {
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofDelayRequest before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofDelayRequest("/api/sessions/session-firefox", 400);
	});
	const confirmRevoke = page.getByRole("alertdialog", {
		name: "Revoke this session?",
	});
	await revokeButtons.first().click();
	await expect(confirmRevoke).toBeVisible();
	await confirmRevoke.getByRole("button", { name: "Cancel" }).click();
	await expect(confirmRevoke).toBeHidden();
	await expect(revokeButtons).toHaveCount(2);
	await revokeButtons.first().click();
	await confirmRevoke.getByRole("button", { name: "Revoke session" }).click();
	await expect(revokeButtons.first()).toBeDisabled();
	await expect(revokeButtons.last()).toBeDisabled();
	await expect(
		activeSessions.getByText("Firefox", { exact: true })
	).toHaveCount(0);
	await expect(revokeButtons).toHaveCount(1);

	await failRequest(page, "/api/sessions/session-edge");
	await revokeButtons.first().click();
	await confirmRevoke.getByRole("button", { name: "Revoke session" }).click();
	await expect(page.getByText("Failed to revoke session")).toBeVisible();
	await expect(activeSessions.getByText("Edge", { exact: true })).toBeVisible();

	const revokeAll = activeSessions.getByRole("button", {
		name: "Revoke all others",
	});
	await revokeAll.click();
	await expect(
		activeSessions.getByText("Revoke all other sessions?")
	).toBeVisible();
	await activeSessions
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(activeSessions.getByText("Edge", { exact: true })).toBeVisible();
	await revokeAll.click();
	await failRequest(page, "/api/sessions");
	await activeSessions
		.getByRole("button", { name: "Confirm", exact: true })
		.click();
	await expect(page.getByText("Failed to revoke sessions")).toBeVisible();
	await expect(activeSessions.getByText("Edge", { exact: true })).toBeVisible();
	await activeSessions
		.getByRole("button", { name: "Revoke all others" })
		.click();
	await activeSessions
		.getByRole("button", { name: "Confirm", exact: true })
		.click();
	await expect(page.getByText("All other sessions revoked")).toBeVisible();
	await expect(activeSessions.getByText("Edge", { exact: true })).toHaveCount(
		0
	);
	await expect(
		activeSessions.getByText("Chrome", { exact: true })
	).toBeVisible();
	await expect(
		activeSessions.getByRole("button", { name: "Revoke session" })
	).toHaveCount(0);

	expect(testInfo.status).toBe("passed");
});

test("session list retries a failed load and renders the empty state without revoke actions", async ({
	page,
}) => {
	await openProof(page, "?sessions-error=true");
	const activeSessions = page.getByTestId("sessions-tab");
	await expect(
		activeSessions.getByText(/couldn't load your sessions/i)
	).toBeVisible();
	await expect(
		activeSessions.getByRole("button", { name: "Retry" })
	).toBeVisible();
	await activeSessions.getByRole("button", { name: "Retry" }).click();
	await expect(
		activeSessions.getByText("Chrome", { exact: true })
	).toBeVisible();

	await openProof(page, "?sessions-empty=true");
	await expect(
		activeSessions.getByText(/You're signed in on this device/)
	).toBeVisible();
	await expect(
		activeSessions.getByRole("button", { name: "Revoke all others" })
	).toHaveCount(0);
	await expect(
		activeSessions.getByRole("button", { name: "Revoke session" })
	).toHaveCount(0);
});
