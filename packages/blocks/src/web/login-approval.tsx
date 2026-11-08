"use client";

import {
	LOGIN_APPROVAL_SURFACE_LABELS,
	LOGIN_APPROVAL_USER_CODE_LENGTH,
	type LoginApprovalRequest,
} from "@ryu/auth/lib/login-approval-contract";
import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { OTPCodeDisplay, OTPInput } from "@ryu/ui/components/motion/otp-input";
import { QRCode } from "@ryu/ui/components/qr-code.tsx";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	LaptopMinimalCheck,
	QrCode as QrCodeIcon,
	ShieldCheck,
} from "lucide-react";
import { type ReactNode, useState } from "react";

export interface LoginApprovalPromptProps {
	approving?: boolean;
	error?: string | null;
	/** Called with the matching code the approver typed from the requesting device. */
	onApprove: (code: string) => void | Promise<void>;
	onDeny: () => void | Promise<void>;
	onOpenChange?: (open: boolean) => void;
	open: boolean;
	request: LoginApprovalRequest | null;
}

/**
 * Shared approval dialog used by the website, desktop, and extension hosts.
 *
 * The approver types the code shown on the requesting device (number matching),
 * so a request started by someone who only knows the email cannot be approved
 * with one click. The surface and network address come from the server; the
 * device name and browser are reported by the requesting device and shown as
 * such.
 */
export function LoginApprovalPrompt({
	approving = false,
	error = null,
	onApprove,
	onDeny,
	onOpenChange,
	open,
	request,
}: LoginApprovalPromptProps) {
	const tl = useLiteralMessages();
	// Keyed by request so a newly shown request always starts with an empty code.
	const [entry, setEntry] = useState({ code: "", requestId: "" });
	if (!request) {
		return null;
	}
	const code = entry.requestId === request.id ? entry.code : "";
	const codeComplete = code.length === LOGIN_APPROVAL_USER_CODE_LENGTH;
	const surfaceLabel = tl(LOGIN_APPROVAL_SURFACE_LABELS[request.surface]);
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent
				className="sm:max-w-md"
				data-testid="login-approval-dialog"
				showCloseButton={false}
			>
				<DialogHeader>
					<div className="mb-1 flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
						<ShieldCheck className="size-6" />
					</div>
					<DialogTitle>Approve sign-in</DialogTitle>
					<DialogDescription>
						{tl(
							"{surfaceLabel} is asking to sign in to your Ryu account. Approve only if you started this request.",
							{ surfaceLabel }
						)}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3 rounded-2xl border border-border/60 bg-muted/25 p-4">
					<div className="flex items-start gap-3">
						<LaptopMinimalCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
						<div className="min-w-0">
							<p className="font-medium">{surfaceLabel}</p>
							{request.ipAddress ? (
								<p className="mt-1 text-muted-foreground text-xs">
									{tl("Requested from {ipAddress}", {
										ipAddress: request.ipAddress,
									})}
								</p>
							) : null}
							<p className="mt-2 break-words text-muted-foreground text-xs">
								{tl("Reported by the requesting device: {deviceLabel}", {
									deviceLabel: request.userAgent
										? `${request.deviceLabel} · ${request.userAgent}`
										: request.deviceLabel,
								})}
							</p>
						</div>
					</div>
					<div className="border-border/60 border-t pt-3 text-center">
						<div className="flex justify-center">
							<OTPInput
								aria-label="Code shown on the requesting device"
								autoFocus
								charset="alphanumeric"
								disabled={approving}
								label="Enter the code shown on the device"
								length={LOGIN_APPROVAL_USER_CODE_LENGTH}
								onChange={(value) =>
									setEntry({ code: value, requestId: request.id })
								}
								size="compact"
								value={code}
							/>
						</div>
						<p className="mt-1 text-muted-foreground text-xs">
							Only the device asking to sign in shows this code. If you cannot
							see it, choose Not now.
						</p>
					</div>
				</div>

				{error ? (
					<p className="text-sm text-status-destructive" role="alert">
						{error}
					</p>
				) : null}

				<DialogFooter className="sm:flex-row sm:justify-between">
					<Button disabled={approving} onClick={() => onDeny()} variant="ghost">
						Not now
					</Button>
					<Button
						disabled={approving || !codeComplete}
						onClick={() => onApprove(code)}
					>
						{approving ? <Spinner className="size-4" /> : null}
						{approving ? "Approving…" : "Approve sign-in"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export interface LoginApprovalWaitProps {
	error?: string | null;
	onCancel: () => void;
	onOpenVerification?: () => void | Promise<void>;
	open: boolean;
	status?: ReactNode;
	userCode: string | null;
	verificationUriComplete: string | null;
}

/** Shared requester state for a passwordless sign-in waiting on approval. */
export function LoginApprovalWait({
	error = null,
	onCancel,
	onOpenVerification,
	open,
	status,
	userCode,
	verificationUriComplete,
}: LoginApprovalWaitProps) {
	const tlRich = useRichLiteralMessages();
	return (
		<Dialog onOpenChange={(nextOpen) => !nextOpen && onCancel()} open={open}>
			<DialogContent
				className="sm:max-w-md"
				data-testid="login-approval-wait"
				showCloseButton={false}
			>
				<DialogHeader>
					<div className="mb-1 flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
						<ShieldCheck className="size-6" />
					</div>
					<DialogTitle>Approve on another device</DialogTitle>
					<DialogDescription>
						Scan the QR with Ryu Mobile, or open Ryu on a device where you are
						already signed in and approve this request.
					</DialogDescription>
				</DialogHeader>

				<div className="rounded-2xl border border-border/60 bg-muted/25 p-5 text-center">
					{verificationUriComplete ? (
						<div
							className="mb-5 flex flex-col items-center gap-3 border-border/60 border-b pb-5"
							data-testid="login-approval-qr"
						>
							<div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
								<QrCodeIcon className="size-4" />
								Scan with Ryu Mobile
							</div>
							<div className="rounded-xl bg-white p-3">
								<QRCode
									aria-label="Scan this sign-in QR code with Ryu Mobile"
									bgColor="#ffffff"
									fgColor="#000000"
									size={196}
									value={verificationUriComplete}
								/>
							</div>
							<p className="max-w-xs text-muted-foreground text-xs">
								{tlRich(
									"Open Ryu Mobile, choose <strong>Scan sign-in QR</strong>, then review and approve this request.",
									{},
									{ strong: (children) => <strong>{children}</strong> }
								)}
							</p>
						</div>
					) : null}
					{userCode ? (
						<div>
							<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
								Sign-in code
							</p>
							<div className="mt-2 flex justify-center">
								<OTPCodeDisplay
									aria-label="Sign-in code"
									code={userCode}
									size="compact"
								/>
							</div>
							<p className="mt-1 text-muted-foreground text-xs">
								Enter this code on the device where you approve the sign-in.
							</p>
						</div>
					) : null}
					<div className="mt-4 flex items-center justify-center gap-2 text-muted-foreground text-sm">
						{status ?? (
							<>
								<Spinner className="size-4" /> Waiting for approval…
							</>
						)}
					</div>
				</div>

				{error ? (
					<p className="text-sm text-status-destructive" role="alert">
						{error}
					</p>
				) : null}

				<DialogFooter className="sm:flex-row sm:justify-between">
					<Button onClick={onCancel} variant="ghost">
						Cancel
					</Button>
					{verificationUriComplete && onOpenVerification ? (
						<Button onClick={() => onOpenVerification()} variant="outline">
							Open approval page
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
