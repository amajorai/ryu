"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
	isStepUpBlocking,
	STEP_UP_METHOD_LABEL,
	type StepUpMethod,
	type StepUpScope,
	stepUpPromptLine,
} from "@ryu/step-up";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogDescription,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import PageHeader from "@ryu/ui/components/page-header";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import { ArrowLeft } from "lucide-react";
import type { ReactNode, SyntheticEvent } from "react";
import StepUpVerify from "./step-up-verify.tsx";

export interface StepUpPagePending {
	action: string;
	enrolmentRequired: boolean;
	method: StepUpMethod;
	methods: StepUpMethod[];
	scope: StepUpScope;
}

interface StepUpPageProps {
	code: string;
	error: string | null;
	isSubmitting: boolean;
	onClose: () => void;
	onCodeChange: (value: string) => void;
	onCodeComplete: (value: string) => void;
	onEnrol2fa: () => void;
	onMethodChange: (method: StepUpMethod) => void;
	onResend: () => void;
	onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
	pageHeader?: ReactNode;
	pending: StepUpPagePending;
}

export default function StepUpPage({
	code,
	error,
	isSubmitting,
	pageHeader,
	onClose,
	onCodeChange,
	onCodeComplete,
	onEnrol2fa,
	onMethodChange,
	onResend,
	onSubmit,
	pending,
}: StepUpPageProps) {
	const magicLink = pending.method === "magic-link";
	const blocking = isStepUpBlocking(pending.scope);
	const otherMethods = pending.methods.filter(
		(method) => method !== pending.method
	);

	return (
		<Dialog
			disablePointerDismissal={blocking}
			onOpenChange={(open) => {
				if (!(open || blocking)) {
					onClose();
				}
			}}
			open
		>
			<StepUpDialogContent>
				<DialogTitle className="sr-only" render={<span />}>
					Verify your identity to continue
				</DialogTitle>
				<DialogDescription className="sr-only">
					{stepUpPromptLine(pending)}
				</DialogDescription>
				<div className="flex min-h-dvh w-full flex-col overflow-y-auto bg-background">
					{pageHeader}
					<main className="flex flex-1 items-center justify-center px-4 py-8">
						<div className="mx-auto flex w-full max-w-md flex-col gap-6">
							<StaggerReveal>
								<PageHeader
									stagger={false}
									subtitle={stepUpPromptLine(pending)}
									title="Verify your identity to continue"
								/>
								{pending.scope === "account.security" ? (
									<p className="text-muted-foreground text-sm">
										This one-use check protects account changes. It does not
										remember your device for future sign-ins.
									</p>
								) : null}
								{pending.enrolmentRequired ? (
									<div className="w-full space-y-4">
										<p className="text-muted-foreground text-sm">
											Staff actions need two-factor authentication on your
											account.
										</p>
										<Button
											className="w-full"
											onClick={onEnrol2fa}
											size="lg"
											type="button"
										>
											Turn on two-factor
										</Button>
									</div>
								) : null}
								{!pending.enrolmentRequired && magicLink ? (
									<div
										className="w-full space-y-4"
										data-testid="step-up-verification-controls"
									>
										<p className="text-muted-foreground text-sm">
											We sent a one-click verification link to your account
											email. Open it in this browser; this page will continue
											automatically.
										</p>
										{error ? (
											<p className="text-sm text-status-destructive">{error}</p>
										) : null}
										<Button
											className="w-full"
											disabled={isSubmitting}
											onClick={onResend}
											size="lg"
											type="button"
											variant="secondary"
										>
											Send the link again
										</Button>
										{otherMethods.map((method) => (
											<Button
												className="w-full"
												disabled={isSubmitting}
												key={method}
												onClick={() => onMethodChange(method)}
												size="lg"
												type="button"
												variant="secondary"
											>
												{STEP_UP_METHOD_LABEL[method]}
											</Button>
										))}
										{blocking ? null : (
											<CancelVerificationButton onClick={onClose} />
										)}
									</div>
								) : null}
								{pending.enrolmentRequired || magicLink ? null : (
									<div
										className="w-full space-y-4"
										data-testid="step-up-verification-controls"
									>
										<StepUpVerify
											code={code}
											error={error}
											isSubmitting={isSubmitting}
											method={pending.method}
											methodSwitchStyle="stacked"
											onCodeChange={onCodeChange}
											onCodeComplete={onCodeComplete}
											onMethodChange={onMethodChange}
											onResend={pending.method === "otp" ? onResend : undefined}
											onSubmit={onSubmit}
											otherMethods={otherMethods}
										/>
										{blocking ? null : (
											<CancelVerificationButton onClick={onClose} />
										)}
									</div>
								)}
							</StaggerReveal>
						</div>
					</main>
				</div>
			</StepUpDialogContent>
		</Dialog>
	);
}

function CancelVerificationButton({ onClick }: { onClick: () => void }) {
	return (
		<Button
			className="w-full"
			onClick={onClick}
			size="lg"
			spacing="comfortable"
			type="button"
			variant="secondary"
		>
			<ArrowLeft aria-hidden="true" className="size-5" />
			Cancel
		</Button>
	);
}

/** This full-page verification surface owns its viewport geometry and paper treatment.
 * Keep Base UI's popup, portal and backdrop so focus trapping, dismissal and dialog
 * title/description associations continue through the shared Dialog root.
 */
function StepUpDialogContent({ children }: { children: ReactNode }) {
	const direction = useDirection();
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Popup
				className="data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 fixed inset-0 top-0 left-0 z-50 grid h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border border-border bg-background p-0 text-popover-foreground text-sm shadow-none outline-none backdrop-blur-xl duration-(--modal-open-dur) ease-(--modal-ease) data-closed:animate-out data-open:animate-in data-closed:duration-(--modal-close-dur)"
				data-slot="dialog-content"
				dir={direction}
			>
				{children}
			</DialogPrimitive.Popup>
		</DialogPortal>
	);
}
