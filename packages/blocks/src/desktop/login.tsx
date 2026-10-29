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
import type { MessageValuesInput } from "@ryu/i18n/core";
import { useOptionalI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Logo as GhostOrb } from "@ryu/ui/components/logo";
import { OTPCodeDisplay } from "@ryu/ui/components/motion/otp-input";
import { PageHeader } from "@ryu/ui/components/page-header";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useState } from "react";
import { WorkspacePreview } from "./workspace-preview.tsx";

export type LocalCoreSetupState =
	| { phase: "downloading" }
	| { fileName: string; phase: "waiting" }
	| { message: string; phase: "error" };

export interface LoginViewProps {
	/** True once Ryu Core is reachable; gates the Get Started button. */
	coreReady?: boolean;
	/** True while Ryu is still starting up; shows a spinner inside the button. */
	coreStarting?: boolean;
	/** Plain-language copy shown under the disabled button when startup failed. */
	coreStatusLabel?: string | null;
	/** True while the anonymous guest request is in flight. */
	guestLoading?: boolean;
	/** Whether the verification URI is known (shows the "Open" button). */
	hasVerificationUri?: boolean;
	/** Browser-only Core setup shown after the local runtime probe misses. */
	localCoreSetup?: LocalCoreSetupState | null;
	onCancel?: () => void;
	/** Browser-only guest session action; omitted from native desktop login. */
	onContinueAsGuest?: () => void | Promise<void>;
	/** Re-run the browser download when it was blocked or dismissed. */
	onDownloadCoreAgain?: () => void | Promise<void>;
	/** Open the full download page when automatic resolution fails. */
	onOpenCoreDownloads?: () => void | Promise<void>;
	onOpenVerification?: () => void;
	/** Retry startup after it failed; renders a "Try again" button in that state. */
	onRetry?: () => void;
	onSignIn?: () => void;
	/** Finish the pending guest session against Ryu Cloud instead. */
	onUseCloud?: () => void | Promise<void>;
	/** True while silently polling for approval (adds a waiting hint; the manual
	 *  "Open" button stays reachable throughout). */
	polling?: boolean;
	/** The user code to enter on the verification page. */
	userCode?: string | null;
	/** Full verification URL, including the prefilled device code. */
	verificationUri?: string | null;
	/** When set, the device-auth flow is in progress (shows the code panel). */
	waiting?: boolean;
}

function useLoginText() {
	const i18n = useOptionalI18n();
	return (id: string, fallback: string, values?: MessageValuesInput): string =>
		i18n?.t(id, values, fallback) ?? fallback;
}

function SetupStatus({
	children,
	complete = false,
	muted = false,
}: {
	children: React.ReactNode;
	complete?: boolean;
	muted?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-3 rounded-xl border border-border/50 bg-muted/30 px-3 py-2.5",
				muted && "text-muted-foreground"
			)}
		>
			{complete ? (
				<HugeiconsIcon
					className="size-4 shrink-0 text-status-success"
					icon={CheckmarkCircle02Icon}
				/>
			) : (
				<Spinner className="size-4 shrink-0" />
			)}
			<span>{children}</span>
		</div>
	);
}

function LocalCoreSetupDialog({
	state,
	onDownloadCoreAgain,
	onOpenCoreDownloads,
	onUseCloud,
}: {
	state: LocalCoreSetupState | null;
	onDownloadCoreAgain?: () => void | Promise<void>;
	onOpenCoreDownloads?: () => void | Promise<void>;
	onUseCloud?: () => void | Promise<void>;
}) {
	const t = useLoginText();

	return (
		<Dialog open={state !== null}>
			<DialogContent showCloseButton={false}>
				{state ? (
					<>
						<DialogHeader>
							<DialogTitle>
								{state.phase === "downloading"
									? t("login.core-downloading-title", "Downloading Ryu Core")
									: state.phase === "waiting"
										? t("login.core-setup-title", "Set up Ryu Core")
										: t("login.core-error-title", "Core download needs a hand")}
							</DialogTitle>
							<DialogDescription>
								{state.phase === "downloading"
									? t(
											"login.core-build-description",
											"Ryu is getting the right Core build for this computer."
										)
									: state.phase === "waiting"
										? t(
												"login.core-start-description",
												"Open the download to start Core, then leave this window open. Ryu connects as soon as Core is ready."
											)
										: state.message}
							</DialogDescription>
						</DialogHeader>

						<div className="space-y-2">
							{state.phase === "downloading" ? (
								<SetupStatus>
									{t("login.core-downloading", "Downloading Ryu Core…")}
								</SetupStatus>
							) : null}
							{state.phase === "waiting" ? (
								<>
									<SetupStatus complete>
										{t(
											"login.core-download-started",
											"Download started: {fileName}",
											{
												fileName: state.fileName,
											}
										)}
									</SetupStatus>
									<SetupStatus muted>
										{t("login.core-waiting", "Waiting for Ryu Core…")}
									</SetupStatus>
								</>
							) : null}
						</div>

						<DialogFooter className="sm:justify-between">
							<Button onClick={onUseCloud} type="button" variant="ghost">
								{t("login.use-cloud", "Use Ryu Cloud instead")}
							</Button>
							{state.phase === "waiting" ? (
								<Button
									onClick={onDownloadCoreAgain}
									type="button"
									variant="outline"
								>
									{t("login.download-again", "Download again")}
								</Button>
							) : null}
							{state.phase === "error" ? (
								<Button onClick={onOpenCoreDownloads} type="button">
									{t("login.open-core-downloads", "Open Core downloads")}
								</Button>
							) : null}
						</DialogFooter>
					</>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/** The device code in the shared read-only OTP treatment. */
function DeviceCode({ userCode }: { userCode: string }) {
	const t = useLoginText();

	return (
		<OTPCodeDisplay
			aria-label={t("login.device-sign-in-code", "Device sign-in code")}
			code={userCode}
		/>
	);
}

/** The manual "Open" button shown under the device code, kept reachable
 *  throughout since the browser may need re-opening. Full-width; the caller wraps
 *  it in a `max-w-xs` group so it matches the start screen's button width. */
function DeviceAuthAction({
	hasVerificationUri,
	verificationUri,
	onOpenVerification,
}: Pick<
	LoginViewProps,
	"hasVerificationUri" | "verificationUri" | "onOpenVerification"
>) {
	const t = useLoginText();
	const [copiedUri, setCopiedUri] = useState<string | null>(null);

	if (!(hasVerificationUri || verificationUri)) {
		return null;
	}

	const copyVerificationLink = async () => {
		if (!verificationUri) {
			return;
		}
		try {
			await navigator.clipboard.writeText(verificationUri);
			setCopiedUri(verificationUri);
			toast.success(t("login.sign-in-link-copied", "Sign-in link copied"));
		} catch {
			toast.error(
				t("login.copy-sign-in-link-failed", "Couldn't copy the sign-in link")
			);
		}
	};

	return (
		<div className="flex w-full flex-col gap-2">
			{hasVerificationUri ? (
				<Button
					className="w-full"
					onClick={onOpenVerification}
					size="lg"
					variant="mono"
				>
					{t("login.open", "Open")}
				</Button>
			) : null}
			{verificationUri ? (
				<Button
					className="w-full"
					onClick={copyVerificationLink}
					size="lg"
					variant="outline"
				>
					<HugeiconsIcon
						icon={
							copiedUri === verificationUri ? CheckmarkCircle02Icon : Copy01Icon
						}
						size={18}
					/>
					{copiedUri === verificationUri
						? t("login.sign-in-link-copied", "Sign-in link copied")
						: t("login.copy-sign-in-link", "Copy sign-in link")}
				</Button>
			) : null}
		</div>
	);
}

function DeviceAuthCancel({ onCancel }: Pick<LoginViewProps, "onCancel">) {
	const t = useLoginText();
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		const timer = setTimeout(() => setVisible(true), 3000);
		return () => clearTimeout(timer);
	}, []);

	return visible ? (
		<Button onClick={onCancel} size="sm" type="button" variant="ghost">
			{t("common.cancel", "Cancel")}
		</Button>
	) : null;
}

export function LoginView({
	coreReady = true,
	coreStarting,
	coreStatusLabel,
	waiting,
	userCode,
	hasVerificationUri,
	verificationUri,
	polling,
	onSignIn,
	onOpenVerification,
	onCancel,
	onRetry,
	onContinueAsGuest,
	guestLoading = false,
	localCoreSetup = null,
	onDownloadCoreAgain,
	onOpenCoreDownloads,
	onUseCloud,
}: LoginViewProps) {
	const t = useLoginText();
	const [previewOpen, setPreviewOpen] = useState(true);

	return (
		// The empty area around the centered column is the start page's window
		// drag handle on macOS — the interactive children (buttons) override it,
		// so only the background drags the window.
		<div
			className="flex h-full w-full flex-col items-center justify-center gap-8 overflow-y-auto p-8"
			data-tauri-drag-region="true"
		>
			<LocalCoreSetupDialog
				onDownloadCoreAgain={onDownloadCoreAgain}
				onOpenCoreDownloads={onOpenCoreDownloads}
				onUseCloud={onUseCloud}
				state={localCoreSetup}
			/>
			<StaggerReveal>
				<div className="shrink-0">
					<GhostOrb size="50px" variant="outline" />
				</div>

				{waiting ? (
					<>
						<PageHeader
							stagger={false}
							subtitle={
								userCode
									? t(
											"login.enter-code",
											"Enter the code below on the verification page"
										)
									: t(
											"login.hang-tight",
											"Hang tight while we get things ready"
										)
							}
							title={t("login.activate-device", "Activate your device")}
						/>

						<div className="flex flex-col items-center gap-3">
							{userCode ? (
								<>
									<DeviceCode userCode={userCode} />

									{polling ? (
										<p className="flex items-center gap-2 text-muted-foreground text-sm">
											<Spinner className="size-4" />
											{t(
												"login.waiting-approval",
												"Waiting for you to approve in the browser…"
											)}
										</p>
									) : null}
								</>
							) : (
								// Pre-code gap: the request is still in flight and there is no
								// code to show yet. Read this as loading — distinct from the
								// "waiting for approval" hint that only applies once the code
								// (and its verification page) exist.
								<p className="flex items-center gap-2 text-muted-foreground text-sm">
									<Spinner className="size-4" />
									{t("login.getting-signin-code", "Getting your sign-in code…")}
								</p>
							)}
						</div>

						<div className="flex w-full max-w-xs flex-col items-center gap-3">
							<DeviceAuthAction
								hasVerificationUri={hasVerificationUri}
								onOpenVerification={onOpenVerification}
								verificationUri={verificationUri}
							/>

							<DeviceAuthCancel onCancel={onCancel} />
						</div>
					</>
				) : (
					<>
						<PageHeader
							stagger={false}
							subtitle={t(
								"login.subtitle",
								"Your friendly ghost that lives on your desktop"
							)}
							title={t("login.title", "Hey, I'm Ryu")}
						/>

						{previewOpen ? (
							<WorkspacePreview onContinue={() => setPreviewOpen(false)} />
						) : null}
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
								{t("login.get-started", "Get Started")}
							</Button>
							{onContinueAsGuest ? (
								<Button
									className="w-full"
									disabled={guestLoading}
									onClick={onContinueAsGuest}
									size="lg"
									variant="outline"
								>
									{guestLoading ? (
										<span className="flex items-center justify-center gap-2">
											<Spinner className="size-4" />
											{t(
												"login.starting-guest-session",
												"Starting guest session…"
											)}
										</span>
									) : (
										t("login.try-without-account", "Try Ryu without an account")
									)}
								</Button>
							) : null}
							{/* Browser-extension CTA intentionally stays dormant until the
							    public extension release. At that point, use the browser family
							    detector to show the matching Chrome, Edge, Firefox, or Safari
							    store link here. */}
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
											{t("common.try-again", "Try again")}
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
