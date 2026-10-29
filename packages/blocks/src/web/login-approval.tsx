"use client";

import {
	LOGIN_APPROVAL_SURFACE_LABELS,
	type LoginApprovalRequest,
} from "@ryu/auth/lib/login-approval-contract";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { OTPCodeDisplay } from "@ryu/ui/components/motion/otp-input";
import { QRCode } from "@ryu/ui/components/qr-code.tsx";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	LaptopMinimalCheck,
	QrCode as QrCodeIcon,
	ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";

export interface LoginApprovalPromptProps {
	approving?: boolean;
	error?: string | null;
	onApprove: () => void | Promise<void>;
	onDeny: () => void | Promise<void>;
	onOpenChange?: (open: boolean) => void;
	open: boolean;
	request: LoginApprovalRequest | null;
}

/** Shared approval dialog used by the website, desktop, and extension hosts. */
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
	if (!request) {
		return null;
	}
	const surfaceLabel = LOGIN_APPROVAL_SURFACE_LABELS[request.surface];
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
							<p className="font-medium">{request.deviceLabel}</p>
							{request.userAgent ? (
								<p className="mt-1 break-words text-muted-foreground text-xs">
									{request.userAgent}
								</p>
							) : null}
						</div>
					</div>
					<div className="border-border/60 border-t pt-3 text-center">
						<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Matching code
						</p>
						<div className="mt-2 flex justify-center">
							<OTPCodeDisplay
								aria-label="Matching sign-in code"
								code={request.userCode}
								size="compact"
							/>
						</div>
						<p className="mt-1 text-muted-foreground text-xs">
							Make sure it matches the code shown on the device.
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
					<Button disabled={approving} onClick={() => onApprove()}>
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
								Open Ryu Mobile, choose <strong>Scan sign-in QR</strong>, then
								review and approve this request.
							</p>
						</div>
					) : null}
					{userCode ? (
						<div>
							<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
								Fallback sign-in code
							</p>
							<div className="mt-2 flex justify-center">
								<OTPCodeDisplay
									aria-label="Fallback sign-in code"
									code={userCode}
									size="compact"
								/>
							</div>
							<p className="mt-1 text-muted-foreground text-xs">
								Make sure it matches the code shown on the device.
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
