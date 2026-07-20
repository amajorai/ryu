"use client";

// Presentational layer of the desktop Login / device-auth screen. The live app
// (`apps/desktop/src/pages/LoginPage.tsx`) is a thin container that owns the
// device-auth flow (start → poll → store token) and renders this view with the
// resolved state; the storyboard renders the same component with mock data and
// no-op handlers. One source of truth, so editing this block changes the real
// desktop too.
//
// Note: the real page's bespoke framer-motion mount transitions (orb spring,
// content fade-up) are intentionally dropped here — `motion` is not resolvable
// at the shared block boundary (it lives only in the storyboard tree, while the
// desktop has framer-motion). The whole column instead reveals through the
// shared `StaggerReveal` (a Tailwind "texts reveal"), so the title, code panel,
// and actions rise in sequence on mount.

import { CheckmarkCircle02Icon, Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Logo as GhostOrb } from "@ryu/ui/components/logo";
import { PageHeader } from "@ryu/ui/components/page-header";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import { cn } from "@ryu/ui/lib/utils";
import { useState } from "react";

export interface LoginViewProps {
	/** True once Ryu Core is reachable; gates the Get Started button. */
	coreReady?: boolean;
	/** True while Ryu is still starting up; shows a spinner inside the button. */
	coreStarting?: boolean;
	/** Plain-language copy shown under the disabled button when startup failed. */
	coreStatusLabel?: string | null;
	/** Whether the verification URI is known (shows the "Open" button). */
	hasVerificationUri?: boolean;
	onCancel?: () => void;
	onOpenVerification?: () => void;
	/** Retry startup after it failed; renders a "Try again" button in that state. */
	onRetry?: () => void;
	onSignIn?: () => void;
	/** True while silently polling for approval (adds a waiting hint; the manual
	 *  "Open" button stays reachable throughout). */
	polling?: boolean;
	/** The user code to enter on the verification page. */
	userCode?: string | null;
	/** When set, the device-auth flow is in progress (shows the code panel). */
	waiting?: boolean;
}

/** The device code, click-to-copy. The code is deliberately not selectable text:
 *  one click copies it, the trailing icon morphs from copy to check, and a toast
 *  confirms. */
function DeviceCode({ userCode }: { userCode: string }) {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(userCode);
			setCopied(true);
			toast.success("Copied to clipboard");
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard unavailable; the code stays visible for manual entry.
		}
	};

	return (
		<button
			aria-label="Copy device code"
			className="group flex items-center gap-3 rounded-xl bg-muted/40 px-8 py-4 transition-colors hover:bg-muted/60"
			onClick={copy}
			type="button"
		>
			<span className="font-bold font-mono text-3xl tracking-[0.2em]">
				{userCode}
			</span>
			<span className="relative inline-flex size-5 shrink-0 items-center justify-center">
				<HugeiconsIcon
					className={cn(
						"absolute text-muted-foreground transition-[transform,opacity,color] duration-200 group-hover:text-foreground",
						copied ? "scale-50 opacity-0" : "scale-100 opacity-100"
					)}
					icon={Copy01Icon}
					size={18}
				/>
				<HugeiconsIcon
					className={cn(
						"absolute text-green-500 transition-[transform,opacity] duration-200",
						copied ? "scale-100 opacity-100" : "scale-50 opacity-0"
					)}
					icon={CheckmarkCircle02Icon}
					size={18}
				/>
			</span>
		</button>
	);
}

/** The manual "Open" button shown under the device code, kept reachable
 *  throughout since the browser may need re-opening. Full-width; the caller wraps
 *  it in a `max-w-xs` group so it matches the start screen's button width. */
function DeviceAuthAction({
	hasVerificationUri,
	onOpenVerification,
}: Pick<LoginViewProps, "hasVerificationUri" | "onOpenVerification">) {
	if (!hasVerificationUri) {
		return null;
	}
	return (
		<Button
			className="w-full"
			onClick={onOpenVerification}
			size="lg"
			variant="mono"
		>
			Open
		</Button>
	);
}

export function LoginView({
	coreReady = true,
	coreStarting,
	coreStatusLabel,
	waiting,
	userCode,
	hasVerificationUri,
	polling,
	onSignIn,
	onOpenVerification,
	onCancel,
	onRetry,
}: LoginViewProps) {
	return (
		// The empty area around the centered column is the start page's window
		// drag handle on macOS — the interactive children (buttons) override it,
		// so only the background drags the window.
		<div
			className="flex h-full w-full flex-col items-center justify-center gap-8 p-8"
			data-tauri-drag-region="true"
		>
			<StaggerReveal>
				<div className="shrink-0">
					<GhostOrb size="50px" variant="outline" />
				</div>

				{waiting ? (
					<>
						<PageHeader
							subtitle={
								userCode
									? "Enter the code below on the verification page"
									: "Hang tight while we get things ready"
							}
							title="Activate your device"
						/>

						<div className="flex flex-col items-center gap-3">
							{userCode ? (
								<>
									<DeviceCode userCode={userCode} />

									{polling ? (
										<p className="flex items-center gap-2 text-muted-foreground text-sm">
											<Spinner className="size-4" /> Waiting for you to approve
											in the browser…
										</p>
									) : null}
								</>
							) : (
								// Pre-code gap: the request is still in flight and there is no
								// code to show yet. Read this as loading — distinct from the
								// "waiting for approval" hint that only applies once the code
								// (and its verification page) exist.
								<p className="flex items-center gap-2 text-muted-foreground text-sm">
									<Spinner className="size-4" /> Getting your sign-in code…
								</p>
							)}
						</div>

						<div className="flex w-full max-w-xs flex-col items-center gap-3">
							<DeviceAuthAction
								hasVerificationUri={hasVerificationUri}
								onOpenVerification={onOpenVerification}
							/>

							<button
								className="text-xs underline underline-offset-2"
								onClick={onCancel}
								type="button"
							>
								Cancel
							</button>
						</div>
					</>
				) : (
					<>
						<PageHeader
							subtitle="Your friendly ghost that lives on your desktop"
							title="Hey, I'm Ryu"
						/>

						<div className="flex w-full max-w-xs flex-col items-center gap-3">
							{/* Sign-in runs directly against Better Auth (device flow), so it
							    no longer waits on Core — the button is always enabled. Core
							    status is surfaced below as non-blocking info only. */}
							<Button
								className="w-full"
								onClick={onSignIn}
								size="lg"
								variant="mono"
							>
								Get Started
							</Button>
							{coreReady || coreStarting ? null : (
								<div className="flex flex-col items-center gap-2">
									<p className="text-muted-foreground text-xs">
										{coreStatusLabel}
									</p>
									{onRetry ? (
										<Button
											onClick={onRetry}
											size="sm"
											type="button"
											variant="outline"
										>
											Try again
										</Button>
									) : null}
								</div>
							)}
						</div>
					</>
				)}
			</StaggerReveal>
		</div>
	);
}
