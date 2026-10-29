import type { OTPStatus } from "@ryu/ui/components/motion/otp-input.tsx";
import { type FormEvent, useState } from "react";
import { sileo } from "sileo";

export type TwoFactorStep =
	| "password"
	| "qr"
	| "verify"
	| "backup"
	| "confirm"
	| "manage";

/**
 * The account's two-factor calls, bound by each surface to its own auth client
 * and bearer store. Each one rejects with a user-facing message on failure.
 */
export interface TwoFactorActions {
	disable: (password: string) => Promise<void>;
	/** Starts enrollment: the authenticator URI and the backup codes it minted. */
	enable: (
		password: string
	) => Promise<{ backupCodes: string[]; totpUri: string }>;
	regenerateBackupCodes: (password: string) => Promise<string[]>;
	/** Confirms the authenticator, with any backup codes the server returned. */
	verify: (code: string) => Promise<string[] | undefined>;
}

interface TwoFactorDialogOptions {
	actions: TwoFactorActions;
	isEnabled: boolean;
	onStatusChange: () => void;
}

// Pulls the base32 secret out of the otpauth:// URI for manual entry.
const TOTP_SECRET_RE = /secret=([^&]+)/;

export const totpSetupKey = (totpUri: string) =>
	totpUri.match(TOTP_SECRET_RE)?.[1] ?? "";

// Backup codes are shown as "XXXXX-XXXXX" but accepted case-insensitively and
// with or without the hyphen, so both what is displayed and what the user types
// are compared in a normalized form.
const normalizeBackupCode = (code: string) =>
	code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

/**
 * The two-factor dialog's flow (enroll, verify, save and confirm the backup
 * codes, manage), shared by the desktop and extension dialogs, which each
 * render it with their own presentation.
 */
export function useTwoFactorDialog({
	actions,
	isEnabled,
	onStatusChange,
}: TwoFactorDialogOptions) {
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<TwoFactorStep>(
		isEnabled ? "manage" : "password"
	);
	const [password, setPassword] = useState("");
	const [totpUri, setTotpUri] = useState("");
	const [backupCodes, setBackupCodes] = useState<string[]>([]);
	const [otp, setOtp] = useState("");
	const [otpStatus, setOtpStatus] = useState<OTPStatus>("idle");
	const [confirmCode, setConfirmCode] = useState("");
	const [confirmStatus, setConfirmStatus] = useState<OTPStatus>("idle");
	// Set once a confirm attempt failed, so the backup view can show a "these
	// codes are critical" banner the second time the codes are shown.
	const [saveReminder, setSaveReminder] = useState(false);
	const [isBusy, setIsBusy] = useState(false);
	const [showManualSetup, setShowManualSetup] = useState(false);

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		// 2FA can be turned on or off after this dialog mounted (the session
		// finishes loading, this dialog just changed it, or another device did),
		// so each open starts from the account's current state.
		setStep(isEnabled ? "manage" : "password");
		if (next) {
			return;
		}
		setPassword("");
		setTotpUri("");
		setBackupCodes([]);
		setOtp("");
		setOtpStatus("idle");
		setConfirmCode("");
		setConfirmStatus("idle");
		setSaveReminder(false);
		setShowManualSetup(false);
	};

	// Every auth call holds the busy flag and toasts its failure, preferring the
	// server's message; `onError` marks the step's own field first.
	const runBusy = async (
		failureTitle: string,
		call: () => Promise<void>,
		onError?: () => void
	) => {
		setIsBusy(true);
		try {
			await call();
		} catch (error) {
			onError?.();
			sileo.error({
				title: error instanceof Error ? error.message : failureTitle,
			});
		} finally {
			setIsBusy(false);
		}
	};

	const handleEnable = async (e: FormEvent) => {
		e.preventDefault();
		await runBusy("Failed to enable 2FA", async () => {
			const setup = await actions.enable(password);
			setTotpUri(setup.totpUri);
			setBackupCodes(setup.backupCodes);
			setStep("qr");
		});
	};

	const handleVerify = async (e: FormEvent) => {
		e.preventDefault();
		await runBusy(
			"Invalid code",
			async () => {
				const codes = await actions.verify(otp);
				if (codes?.length) {
					setBackupCodes(codes);
				}
				setConfirmCode("");
				setConfirmStatus("idle");
				setSaveReminder(false);
				setStep("backup");
				onStatusChange();
			},
			() => setOtpStatus("error")
		);
	};

	const handleDisable = () =>
		runBusy("Failed to disable 2FA", async () => {
			await actions.disable(password);
			sileo.success({ title: "Two-factor authentication disabled" });
			onStatusChange();
			handleOpenChange(false);
		});

	const handleRegenerateBackupCodes = () =>
		runBusy("Failed to regenerate backup codes", async () => {
			setBackupCodes(await actions.regenerateBackupCodes(password));
			setConfirmCode("");
			setConfirmStatus("idle");
			setSaveReminder(false);
			setStep("backup");
		});

	// Prove the user actually stored the codes before the dialog closes. Every
	// entered code must match one of the freshly generated ones (hyphens and
	// casing ignored). A miss bounces back to the codes with a save reminder.
	const handleConfirmBackup = (e: FormEvent) => {
		e.preventDefault();
		const entered = normalizeBackupCode(confirmCode);
		if (!entered) {
			setConfirmStatus("error");
			return;
		}
		const saved = new Set(backupCodes.map(normalizeBackupCode));
		if (saved.has(entered)) {
			sileo.success({ title: "Backup codes confirmed" });
			handleOpenChange(false);
			return;
		}
		setConfirmStatus("error");
		setConfirmCode("");
		setSaveReminder(true);
		setStep("backup");
		sileo.error({
			title: "That code didn't match",
			description:
				"Save these backup codes somewhere safe — without them you can be locked out of your account if you lose your authenticator app.",
		});
	};

	// Typing again clears the previous attempt's error.
	const changeOtp = (next: string) => {
		setOtp(next);
		if (otpStatus !== "idle") {
			setOtpStatus("idle");
		}
	};

	const changeConfirmCode = (next: string) => {
		setConfirmCode(next);
		if (confirmStatus !== "idle") {
			setConfirmStatus("idle");
		}
	};

	const startConfirm = () => {
		setConfirmCode("");
		setConfirmStatus("idle");
		setStep("confirm");
	};

	return {
		backupCodes,
		changeConfirmCode,
		changeOtp,
		confirmCode,
		confirmStatus,
		handleConfirmBackup,
		handleDisable,
		handleEnable,
		handleOpenChange,
		handleRegenerateBackupCodes,
		handleVerify,
		isBusy,
		open,
		otp,
		otpStatus,
		password,
		saveReminder,
		setPassword,
		setShowManualSetup,
		setStep,
		showManualSetup,
		startConfirm,
		step,
		totpUri,
	};
}
