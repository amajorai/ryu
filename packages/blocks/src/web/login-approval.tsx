"use client";

import {
	LOGIN_APPROVAL_SURFACE_LABELS,
	type LoginApprovalRequest,
} from "@ryu/auth/lib/login-approval-contract";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Spinner } from "@ryu/ui/components/spinner";
import { LaptopMinimalCheck, ShieldCheck } from "lucide-react";
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
						{surfaceLabel} is asking to sign in to your Ryu account. Approve
						only if you started this request.
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
						<p className="text-muted-foreground text-xs uppercase tracking-[0.16em]">
							Matching code
						</p>
						<p className="mt-1 font-bold font-mono text-2xl tracking-[0.18em]">
							{request.userCode}
						</p>
						<p className="mt-1 text-muted-foreground text-xs">
							Make sure it matches the code shown on the device.
						</p>
					</div>
				</div>

				{error ? (
					<p className="text-destructive text-sm" role="alert">
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
						Open Ryu on a device where you are already signed in and approve
						this request.
					</DialogDescription>
				</DialogHeader>

				<div className="rounded-2xl border border-border/60 bg-muted/25 p-5 text-center">
					<p className="text-muted-foreground text-xs uppercase tracking-[0.16em]">
						Sign-in code
					</p>
					<p className="mt-2 font-bold font-mono text-3xl tracking-[0.2em]">
						{userCode ?? "••••••••"}
					</p>
					<div className="mt-4 flex items-center justify-center gap-2 text-muted-foreground text-sm">
						{status ?? (
							<>
								<Spinner className="size-4" /> Waiting for approval…
							</>
						)}
					</div>
				</div>

				{error ? (
					<p className="text-destructive text-sm" role="alert">
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
