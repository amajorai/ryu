import { Copy01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import { IconSwap } from "@ryu/ui/components/icon-swap";
import { Input } from "@ryu/ui/components/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
} from "@ryu/ui/components/input-otp";
import { Label } from "@ryu/ui/components/label";
import { Separator } from "@ryu/ui/components/separator";
import { TextSwap } from "@ryu/ui/components/text-swap";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import QRCode from "react-qr-code";
import { sileo } from "sileo";
import { authClient } from "@/lib/auth-client.ts";

type Step = "password" | "qr" | "verify" | "backup" | "manage";

// Wallet-app morph: the panel springs to its new height as the active step
// swaps, per beui.dev/components/motion/morphing-modal (stiffness 420, damping 40).
const SPRING_PANEL = { type: "spring", stiffness: 420, damping: 40 } as const;

// Pulls the base32 secret out of the otpauth:// URI for manual entry.
const TOTP_SECRET_RE = /secret=([^&]+)/;

interface TwoFactorDialogProps {
	isEnabled: boolean;
	onStatusChange: () => void;
}

export function TwoFactorDialog({
	isEnabled,
	onStatusChange,
}: TwoFactorDialogProps) {
	const [open, setOpen] = useState(false);
	const reduce = useReducedMotion();
	const [step, setStep] = useState<Step>(isEnabled ? "manage" : "password");
	const [password, setPassword] = useState("");
	const [totpUri, setTotpUri] = useState("");
	const [backupCodes, setBackupCodes] = useState<string[]>([]);
	const [otp, setOtp] = useState("");
	const [isBusy, setIsBusy] = useState(false);
	const [copiedAll, setCopiedAll] = useState(false);

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		if (!next) {
			setStep(isEnabled ? "manage" : "password");
			setPassword("");
			setTotpUri("");
			setBackupCodes([]);
			setOtp("");
		}
	};

	const handleEnable = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsBusy(true);
		try {
			const result = await authClient.twoFactor.enable({ password });
			if (result.error) {
				throw new Error(result.error.message);
			}
			setTotpUri(result.data?.totpURI ?? "");
			setStep("qr");
		} catch (error) {
			sileo.error({
				title: error instanceof Error ? error.message : "Failed to enable 2FA",
			});
		} finally {
			setIsBusy(false);
		}
	};

	const handleVerify = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsBusy(true);
		try {
			const result = await authClient.twoFactor.verifyTotp({ code: otp });
			if (result.error) {
				throw new Error(result.error.message);
			}
			const codes =
				(result.data as { backupCodes?: string[] })?.backupCodes ?? [];
			setBackupCodes(codes);
			setStep("backup");
			onStatusChange();
		} catch (error) {
			sileo.error({
				title: error instanceof Error ? error.message : "Invalid code",
			});
		} finally {
			setIsBusy(false);
		}
	};

	const handleDisable = async () => {
		setIsBusy(true);
		try {
			const result = await authClient.twoFactor.disable({ password });
			if (result.error) {
				throw new Error(result.error.message);
			}
			sileo.success({ title: "Two-factor authentication disabled" });
			onStatusChange();
			handleOpenChange(false);
		} catch (error) {
			sileo.error({
				title: error instanceof Error ? error.message : "Failed to disable 2FA",
			});
		} finally {
			setIsBusy(false);
		}
	};

	const handleRegenerateBackupCodes = async () => {
		setIsBusy(true);
		try {
			const result = await authClient.twoFactor.generateBackupCodes({
				password,
			});
			if (result.error) {
				throw new Error(result.error.message);
			}
			const codes =
				(result.data as { backupCodes?: string[] })?.backupCodes ?? [];
			setBackupCodes(codes);
			setStep("backup");
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error
						? error.message
						: "Failed to regenerate backup codes",
			});
		} finally {
			setIsBusy(false);
		}
	};

	const copyAllBackupCodes = () => {
		navigator.clipboard.writeText(backupCodes.join("\n"));
		setCopiedAll(true);
		setTimeout(() => setCopiedAll(false), 2000);
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
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={<Button size="sm" variant="ghost" />}>
				{isEnabled ? "Manage 2FA" : "Enable 2FA"}
			</DialogTrigger>

			<DialogContent className="overflow-hidden sm:max-w-[420px]">
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
							key={step}
							transition={anim.view}
						>
							{step === "password" && (
								<>
									<DialogHeader>
										<DialogTitle>Enable Two-Factor Authentication</DialogTitle>
										<DialogDescription>
											Enter your password to begin setting up 2FA.
										</DialogDescription>
									</DialogHeader>
									<form className="space-y-4" onSubmit={handleEnable}>
										<div className="space-y-2">
											<Label htmlFor="2fa-password">Password</Label>
											<Input
												autoComplete="current-password"
												id="2fa-password"
												onChange={(e) => setPassword(e.target.value)}
												required
												type="password"
												value={password}
											/>
										</div>
										<DialogFooter>
											<Button
												onClick={() => handleOpenChange(false)}
												type="button"
												variant="ghost"
											>
												Cancel
											</Button>
											<Button disabled={isBusy || !password} type="submit">
												{isBusy ? "Verifying…" : "Continue"}
											</Button>
										</DialogFooter>
									</form>
								</>
							)}

							{step === "qr" && (
								<>
									<DialogHeader>
										<DialogTitle>Scan QR Code</DialogTitle>
										<DialogDescription>
											Scan this with your authenticator app (Google
											Authenticator, Authy, etc.), then enter the 6-digit code.
										</DialogDescription>
									</DialogHeader>
									<div className="flex flex-col items-center gap-4 py-2">
										{totpUri && (
											<div className="rounded-lg border bg-white p-4">
												<QRCode size={180} value={totpUri} />
											</div>
										)}
										<div className="w-full">
											<p className="mb-1 text-muted-foreground text-xs">
												Or enter the key manually:
											</p>
											<div className="flex items-center gap-2">
												<Input
													className="bg-muted font-mono text-xs"
													readOnly
													value={totpUri.match(TOTP_SECRET_RE)?.[1] ?? ""}
												/>
												<Button
													aria-label="Copy secret key"
													className="shrink-0"
													onClick={() => {
														const secret =
															totpUri.match(TOTP_SECRET_RE)?.[1] ?? "";
														navigator.clipboard.writeText(secret);
														sileo.success({ title: "Copied" });
													}}
													size="icon"
													variant="ghost"
												>
													<HugeiconsIcon className="size-4" icon={Copy01Icon} />
												</Button>
											</div>
										</div>
									</div>
									<DialogFooter>
										<Button onClick={() => setStep("password")} variant="ghost">
											Back
										</Button>
										<Button onClick={() => setStep("verify")}>
											I've scanned it
										</Button>
									</DialogFooter>
								</>
							)}

							{step === "verify" && (
								<>
									<DialogHeader>
										<DialogTitle>Verify Code</DialogTitle>
										<DialogDescription>
											Enter the 6-digit code from your authenticator app to
											confirm setup.
										</DialogDescription>
									</DialogHeader>
									<form className="space-y-4" onSubmit={handleVerify}>
										<div className="flex justify-center py-2">
											<InputOTP maxLength={6} onChange={setOtp} value={otp}>
												<InputOTPGroup>
													<InputOTPSlot index={0} />
													<InputOTPSlot index={1} />
													<InputOTPSlot index={2} />
													<InputOTPSlot index={3} />
													<InputOTPSlot index={4} />
													<InputOTPSlot index={5} />
												</InputOTPGroup>
											</InputOTP>
										</div>
										<DialogFooter>
											<Button
												onClick={() => setStep("qr")}
												type="button"
												variant="ghost"
											>
												Back
											</Button>
											<Button
												disabled={isBusy || otp.length !== 6}
												type="submit"
											>
												{isBusy ? "Verifying…" : "Verify"}
											</Button>
										</DialogFooter>
									</form>
								</>
							)}

							{step === "backup" && (
								<>
									<DialogHeader>
										<DialogTitle>Save Backup Codes</DialogTitle>
										<DialogDescription>
											Store these codes somewhere safe. Each can be used once if
											you lose access to your authenticator app.
										</DialogDescription>
									</DialogHeader>
									<div className="space-y-3">
										<div className="grid grid-cols-2 gap-1.5 rounded-lg bg-muted/50 p-4">
											{backupCodes.map((code) => (
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
											<IconSwap
												a={
													<HugeiconsIcon className="size-4" icon={Copy01Icon} />
												}
												b={
													<HugeiconsIcon className="size-4" icon={Tick01Icon} />
												}
												className="mr-2 size-4"
												state={copiedAll ? "b" : "a"}
											/>
											<TextSwap>
												{copiedAll ? "Copied" : "Copy all codes"}
											</TextSwap>
										</Button>
									</div>
									<DialogFooter>
										<Button onClick={() => handleOpenChange(false)}>
											Done
										</Button>
									</DialogFooter>
								</>
							)}

							{step === "manage" && (
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
												onChange={(e) => setPassword(e.target.value)}
												placeholder="Enter your password"
												type="password"
												value={password}
											/>
										</div>
										<Separator />
										<div className="flex flex-col gap-2">
											<Button
												disabled={isBusy || !password}
												onClick={handleRegenerateBackupCodes}
												variant="ghost"
											>
												Regenerate Backup Codes
											</Button>
											<Button
												disabled={isBusy || !password}
												onClick={handleDisable}
												variant="destructive"
											>
												{isBusy ? "Disabling…" : "Disable 2FA"}
											</Button>
										</div>
									</div>
									<DialogFooter>
										<Button
											onClick={() => handleOpenChange(false)}
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
