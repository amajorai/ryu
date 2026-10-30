import { Copy01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type TwoFactorStep,
	totpSetupKey,
	useTwoFactorDialog,
} from "@ryu/settings/hooks/useTwoFactorDialog";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { MorphIconSwap } from "@ryu/ui/components/morph-icon.tsx";
import { OTPInput } from "@ryu/ui/components/motion/otp-input.tsx";
import { ExpandableQRCode } from "@ryu/ui/components/qr-code.tsx";
import { Separator } from "@ryu/ui/components/separator.tsx";
import { TextSwap } from "@ryu/ui/components/text-swap.tsx";
import { SPRING_PANEL } from "@ryu/ui/lib/ease.ts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { sileo } from "sileo";
import { twoFactorActions } from "./two-factor-actions.ts";

const STEP_DIALOG_LABEL = {
	password: "Enable Two-Factor Authentication",
	qr: "Scan QR Code",
	verify: "Verify Code",
	backup: "Save Backup Codes",
	confirm: "Confirm Your Backup Codes",
	manage: "Manage Two-Factor Authentication",
} satisfies Record<TwoFactorStep, string>;

// Wallet-app morph: the panel springs to its new height as the active step
// swaps, per beui.dev/components/motion/morphing-modal. This used to redeclare
// `stiffness: 420, damping: 40` locally under the same name as the shared token
// — a shadowing copy that could not track fixes to the real one. It now IS the
// shared token, which is also critically damped rather than overshoot-free by
// accident.

interface TwoFactorDialogProps {
	isEnabled: boolean;
	onStatusChange: () => void;
}

export function TwoFactorDialog({
	isEnabled,
	onStatusChange,
}: TwoFactorDialogProps) {
	const flow = useTwoFactorDialog({
		actions: twoFactorActions,
		isEnabled,
		onStatusChange,
	});
	const reduce = useReducedMotion();
	const [copiedAll, setCopiedAll] = useState(false);

	const copyAllBackupCodes = async () => {
		try {
			await navigator.clipboard.writeText(flow.backupCodes.join("\n"));
			setCopiedAll(true);
			setTimeout(() => setCopiedAll(false), 2000);
		} catch {
			sileo.error({ title: "Couldn't copy backup codes" });
		}
	};

	const copyAuthenticatorSetupKey = async () => {
		try {
			await navigator.clipboard.writeText(totpSetupKey(flow.totpUri));
			sileo.success({ title: "Setup key copied" });
		} catch {
			sileo.error({ title: "Couldn't copy setup key" });
		}
	};

	// Precomputed once per render so the JSX below stays declarative and the
	// reduced-motion branch lives in one place. Reduced motion drops the blur
	// and the height spring, keeping a plain fade.
	const anim = reduce
		? {
				layout: false as const,
				panel: { duration: 0 },
				view: { duration: 0.12 },
				fade: { initial: { opacity: 0 }, exit: { opacity: 0 } },
			}
		: {
				layout: "size" as const,
				panel: SPRING_PANEL,
				view: { duration: 0.2 },
				fade: {
					initial: { opacity: 0, filter: "blur(4px)" },
					exit: { opacity: 0, filter: "blur(4px)" },
				},
			};

	return (
		<Dialog onOpenChange={flow.handleOpenChange} open={flow.open}>
			<DialogTrigger render={<Button size="sm" variant="ghost" />}>
				{isEnabled ? "Manage 2FA" : "Enable 2FA"}
			</DialogTrigger>

			<DialogContent
				aria-label={STEP_DIALOG_LABEL[flow.step]}
				className="overflow-hidden sm:max-w-[420px]"
			>
				<motion.div
					className="grid"
					layout={anim.layout}
					transition={anim.panel}
				>
					<AnimatePresence initial={false} mode="popLayout">
						{/* Keyed on `step` so each view mounts fresh and cross-fades with a
						    blur while the parent springs to the new height. */}
						<motion.div
							animate={{ opacity: 1, filter: "blur(0px)" }}
							className="grid gap-4"
							exit={anim.fade.exit}
							initial={anim.fade.initial}
							key={flow.step}
							transition={anim.view}
						>
							{flow.step === "password" && (
								<>
									<DialogHeader>
										<DialogTitle>Enable Two-Factor Authentication</DialogTitle>
										<DialogDescription>
											Enter your password to begin setting up 2FA.
										</DialogDescription>
									</DialogHeader>
									<form className="space-y-4" onSubmit={flow.handleEnable}>
										<div className="space-y-2">
											<Label htmlFor="2fa-password">Password</Label>
											<Input
												autoComplete="current-password"
												id="2fa-password"
												onChange={(e) => flow.setPassword(e.target.value)}
												required
												type="password"
												value={flow.password}
											/>
										</div>
										<DialogFooter>
											<Button
												onClick={() => flow.handleOpenChange(false)}
												type="button"
												variant="ghost"
											>
												Cancel
											</Button>
											<Button
												disabled={flow.isBusy || !flow.password}
												type="submit"
											>
												{flow.isBusy ? "Verifying…" : "Continue"}
											</Button>
										</DialogFooter>
									</form>
								</>
							)}

							{flow.step === "qr" && (
								<>
									<DialogHeader>
										<DialogTitle>Scan QR Code</DialogTitle>
										<DialogDescription>
											Scan this with your authenticator app (Google
											Authenticator, Authy, etc.), then enter the 6-digit code.
										</DialogDescription>
									</DialogHeader>
									<div className="flex flex-col items-center gap-4 py-2">
										{flow.totpUri && (
											<div className="rounded-lg border p-1">
												<ExpandableQRCode size={180} value={flow.totpUri} />
											</div>
										)}
										<div className="w-full">
											<Button
												className="h-auto"
												onClick={() =>
													flow.setShowManualSetup((shown) => !shown)
												}
												spacing="body-preview"
												variant="link"
											>
												{flow.showManualSetup
													? "Hide manual setup"
													: "Can’t scan? Enter setup key manually"}
											</Button>
											{flow.showManualSetup && (
												<div className="space-y-3 rounded-lg border border-border p-3">
													<p className="text-muted-foreground text-xs">
														In your authenticator app, choose{" "}
														<strong>Enter setup key</strong> and paste this key.
													</p>
													<div className="flex items-center gap-2">
														<Input
															aria-label="Authenticator setup key"
															readOnly
															tone="background"
															value={totpSetupKey(flow.totpUri)}
															variant="code-caption"
														/>
														<Button
															aria-label="Copy authenticator setup key"
															onClick={copyAuthenticatorSetupKey}
															size="icon"
															variant="ghost"
														>
															<HugeiconsIcon
																className="size-4"
																icon={Copy01Icon}
															/>
														</Button>
													</div>
													<details className="text-xs">
														<summary className="cursor-pointer text-muted-foreground">
															Show setup URL
														</summary>
														<code className="mt-2 block break-all rounded-lg bg-muted p-2">
															{flow.totpUri}
														</code>
													</details>
												</div>
											)}
										</div>
									</div>
									<DialogFooter>
										<Button
											onClick={() => flow.setStep("password")}
											variant="ghost"
										>
											Back
										</Button>
										<Button onClick={() => flow.setStep("verify")}>
											I've scanned it
										</Button>
									</DialogFooter>
								</>
							)}

							{flow.step === "verify" && (
								<>
									<DialogHeader>
										<DialogTitle>Verify Code</DialogTitle>
										<DialogDescription>
											Enter the 6-digit code from your authenticator app to
											confirm setup.
										</DialogDescription>
									</DialogHeader>
									<form className="space-y-4" onSubmit={flow.handleVerify}>
										<div className="flex justify-center py-2">
											<OTPInput
												aria-label="Authenticator app code"
												autoFocus
												disabled={flow.isBusy}
												errorMessage="Invalid code. Try again."
												onChange={flow.changeOtp}
												status={flow.otpStatus}
												value={flow.otp}
											/>
										</div>
										<DialogFooter>
											<Button
												onClick={() => flow.setStep("qr")}
												type="button"
												variant="ghost"
											>
												Back
											</Button>
											<Button
												disabled={flow.isBusy || flow.otp.length !== 6}
												type="submit"
											>
												{flow.isBusy ? "Verifying…" : "Verify"}
											</Button>
										</DialogFooter>
									</form>
								</>
							)}

							{flow.step === "backup" && (
								<>
									<DialogHeader>
										<DialogTitle>Save Backup Codes</DialogTitle>
										<DialogDescription>
											Store these codes somewhere safe. Each can be used once if
											you lose access to your authenticator app.
										</DialogDescription>
									</DialogHeader>
									<div className="space-y-3">
										{flow.saveReminder && (
											<Alert variant="warning">
												<AlertTitle>These codes are critical</AlertTitle>
												<AlertDescription>
													They&apos;re the only way back into your account if
													you lose your authenticator app. Save them somewhere
													safe now — they won&apos;t be shown again.
												</AlertDescription>
											</Alert>
										)}
										<div className="grid grid-cols-2 gap-1.5 rounded-lg bg-muted/50 p-4">
											{flow.backupCodes.map((code) => (
												<code
													className="text-center font-mono text-sm tracking-wider"
													key={code}
												>
													{code}
												</code>
											))}
										</div>
										<Button
											className="w-full"
											onClick={copyAllBackupCodes}
											variant="ghost"
										>
											<MorphIconSwap
												a={Copy01Icon}
												b={Tick01Icon}
												className="mr-2 size-4"
												state={copiedAll ? "b" : "a"}
											/>
											<TextSwap>
												{copiedAll ? "Copied" : "Copy all codes"}
											</TextSwap>
										</Button>
									</div>
									<DialogFooter>
										<Button onClick={flow.startConfirm}>
											I&apos;ve saved them
										</Button>
									</DialogFooter>
								</>
							)}

							{flow.step === "confirm" && (
								<>
									<DialogHeader>
										<DialogTitle>Confirm Your Backup Codes</DialogTitle>
										<DialogDescription>
											Enter one of the codes above to prove you saved them. If
											they don&apos;t match, we&apos;ll show them again —
											it&apos;s that important.
										</DialogDescription>
									</DialogHeader>
									<form
										className="space-y-4"
										onSubmit={flow.handleConfirmBackup}
									>
										<div className="space-y-2">
											<Label htmlFor="2fa-confirm-code">Backup code</Label>
											<Input
												aria-invalid={flow.confirmStatus === "error"}
												autoComplete="off"
												autoFocus
												disabled={flow.isBusy}
												id="2fa-confirm-code"
												onChange={(e) => flow.changeConfirmCode(e.target.value)}
												placeholder="XXXXX-XXXXX"
												spellCheck={false}
												value={flow.confirmCode}
												variant="code"
											/>
											{flow.confirmStatus === "error" && (
												<p className="text-sm text-status-destructive">
													That code doesn&apos;t match. Save the codes above —
													without them you can be locked out of your account.
												</p>
											)}
										</div>
										<DialogFooter>
											<Button
												onClick={() => flow.setStep("backup")}
												type="button"
												variant="ghost"
											>
												Back
											</Button>
											<Button
												disabled={flow.isBusy || !flow.confirmCode.trim()}
												type="submit"
											>
												Confirm
											</Button>
										</DialogFooter>
									</form>
								</>
							)}

							{flow.step === "manage" && (
								<>
									<DialogHeader>
										<DialogTitle>Manage Two-Factor Authentication</DialogTitle>
										<DialogDescription>
											2FA is currently enabled on your account.
										</DialogDescription>
									</DialogHeader>
									<div className="space-y-4">
										<div className="space-y-2">
											<Label htmlFor="2fa-manage-password">
												Password required for all actions
											</Label>
											<Input
												autoComplete="current-password"
												id="2fa-manage-password"
												onChange={(e) => flow.setPassword(e.target.value)}
												placeholder="Enter your password"
												type="password"
												value={flow.password}
											/>
										</div>
										<Separator />
										<div className="flex flex-col gap-2">
											<Button
												disabled={flow.isBusy || !flow.password}
												onClick={flow.handleRegenerateBackupCodes}
												variant="ghost"
											>
												Regenerate Backup Codes
											</Button>
											<Button
												disabled={flow.isBusy || !flow.password}
												onClick={flow.handleDisable}
												variant="destructive"
											>
												{flow.isBusy ? "Disabling…" : "Disable 2FA"}
											</Button>
										</div>
									</div>
									<DialogFooter>
										<Button
											onClick={() => flow.handleOpenChange(false)}
											variant="ghost"
										>
											Close
										</Button>
									</DialogFooter>
								</>
							)}
						</motion.div>
					</AnimatePresence>
				</motion.div>
			</DialogContent>
		</Dialog>
	);
}
