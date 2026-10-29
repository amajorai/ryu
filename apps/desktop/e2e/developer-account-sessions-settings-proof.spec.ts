declare const window: Window;

import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const STORY_URL = "/developer-account-sessions-settings-proof.html";
// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const EVIDENCE_DIR =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);

interface NativeProofClipboard {
	fail: boolean;
	text: string;
}

declare global {
	interface Window {
		__settingsProofClipboard: NativeProofClipboard;
	}
}

interface ProofWindow extends Window {
	__settingsProofAuthCalls: Array<{ body?: unknown; method: string }>;
	__settingsProofCalls: Array<{ body?: unknown; method: string; path: string }>;
	__settingsProofClearToasts: () => void;
	__settingsProofClipboard: NativeProofClipboard;
	__settingsProofDelayRequest: (path: string, durationMs: number) => void;
	__settingsProofFailAuth: (method: string) => void;
	__settingsProofFailCommand: (command: string) => void;
	__settingsProofFailRequest: (path: string) => void;
	__settingsProofReadMetrics: () => {
		devMode: string | null;
		enabled: boolean;
		text: string;
	};
	__settingsProofRecordMetrics: () => void;
}

async function openProof(page: Page, query = "") {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.addInitScript(() => {
		const clipboard = { fail: false, text: "" };
		Object.defineProperty(window, "__settingsProofClipboard", {
			configurable: true,
			value: clipboard,
		});
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				readText: async () => clipboard.text,
				writeText: async (text: string) => {
					if (clipboard.fail) {
						throw new Error("Fixture clipboard failure");
					}
					clipboard.text = text;
				},
			},
		});
	});
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(`${STORY_URL}${query}`);
	await expect(page.getByTestId("developer-tab")).toBeVisible();
	await expect(page.getByTestId("account-tab")).toBeVisible();
	await expect(page.getByTestId("sessions-tab")).toBeVisible();
}

async function clipboardText(page: Page): Promise<string> {
	return page.evaluate(() => window.__settingsProofClipboard.text);
}

async function setClipboardFailure(page: Page, fail: boolean) {
	await page.evaluate((shouldFail) => {
		window.__settingsProofClipboard.fail = shouldFail;
	}, fail);
}

async function failRequest(page: Page, requestPath: string) {
	await page.evaluate((value) => {
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofFailRequest before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofFailRequest(value);
	}, requestPath);
}

async function failAuth(page: Page, method: string) {
	await page.evaluate((value) => {
		/* SAFETY: proof-auth-client.ts installs __settingsProofFailAuth before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofFailAuth(value);
	}, method);
}

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
