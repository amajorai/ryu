import { GUEST_MODE_ENABLED } from "@ryu/auth/lib/guest-mode";
import { type LocalCoreSetupState, LoginView } from "@ryu/blocks/desktop/login";
import { toast } from "@ryu/ui/components/sileo";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { WEB_URL } from "@/lib/app-urls.ts";
import {
	authClient,
	BACKEND_URL,
	storeSessionToken,
} from "@/lib/auth-client.ts";
import {
	loadBrowserCoreDownload,
	startBrowserCoreDownload,
} from "@/lib/browser-core-setup.ts";
import { detectBrowserDevice } from "@/lib/browser-device.ts";
import {
	markLocalNudgeShown,
	preferLocalCoreIfReachable,
	preferLocalOrCloud,
	shouldNudgeLocalMissing,
} from "@/lib/prefer-local-node.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { reportError } from "@/src/lib/crash.ts";
// Keep device auth on the shared desktop implementation; the extension
// supplies its own auth-client module through the host adapter.
import { pollAuthStatus, startDeviceAuth } from "../../lib/oauth.ts";
import { useAppStore } from "../store/useAppStore.ts";

const IS_WEBAPP = import.meta.env.VITE_RYU_SURFACE === "webapp";

export default function LoginPage() {
	const [waiting, setWaiting] = useState(false);
	const [userCode, setUserCode] = useState<string | null>(null);
	const [verificationUri, setVerificationUri] = useState<string | null>(null);
	const [polling, setPolling] = useState(false);
	const [guestLoading, setGuestLoading] = useState(false);
	const [localCoreSetup, setLocalCoreSetup] =
		useState<LocalCoreSetupState | null>(null);
	const cancelPoll = useRef<(() => void) | null>(null);
	const pendingGuestToken = useRef<string | null>(null);
	const coreDownloadAttempt = useRef(0);
	const coreStatus = useAppStore((s) => s.coreStatus);
	// Signing in is device auth against the web backend — it never touches Core.
	// On the webapp `coreStatus` tracks the HOSTED core, so not reaching it is a
	// genuine blocker and the gate stays. On the desktop it tracks a LOCAL Core,
	// which is optional now: onboarding's first step offers Ryu Cloud and
	// "connect to an existing node" as well as running locally, so blocking
	// sign-in on a local Core locked coreless users out of the very screen that
	// tells them they don't need one.
	const coreReady = IS_WEBAPP ? coreStatus === "running" : true;
	const browserDevice = detectBrowserDevice();
	// Guest sessions bypass durable-account waitlist admission. Keep the browser
	// action behind the same shared policy as the server endpoint.
	const canUseGuestMode = IS_WEBAPP && GUEST_MODE_ENABLED;

	useEffect(() => {
		return () => {
			cancelPoll.current?.();
			coreDownloadAttempt.current += 1;
		};
	}, []);

	useEffect(() => {
		if (localCoreSetup?.phase !== "waiting") {
			return;
		}

		let cancelled = false;
		let timer: number | undefined;
		const pollForCore = async () => {
			const reachable = await preferLocalCoreIfReachable().catch(() => false);
			if (cancelled) {
				return;
			}
			if (reachable) {
				const token = pendingGuestToken.current;
				pendingGuestToken.current = null;
				setLocalCoreSetup(null);
				if (token) {
					toast.success("Ryu Core is ready");
					useAppStore.getState().setPendingAuthToken(token);
				}
				return;
			}
			timer = window.setTimeout(pollForCore, 1500);
		};

		timer = window.setTimeout(pollForCore, 500);
		return () => {
			cancelled = true;
			if (timer !== undefined) {
				window.clearTimeout(timer);
			}
		};
	}, [localCoreSetup?.phase]);

	async function beginCoreDownload() {
		const attempt = coreDownloadAttempt.current + 1;
		coreDownloadAttempt.current = attempt;
		setLocalCoreSetup({ phase: "downloading" });
		try {
			const download = await loadBrowserCoreDownload();
			if (coreDownloadAttempt.current !== attempt) {
				return;
			}
			startBrowserCoreDownload(download);
			setLocalCoreSetup({
				fileName: download.fileName,
				phase: "waiting",
			});
		} catch (error) {
			if (coreDownloadAttempt.current !== attempt) {
				return;
			}
			setLocalCoreSetup({
				message:
					error instanceof Error
						? error.message
						: "Ryu couldn't start the Core download.",
				phase: "error",
			});
		}
	}

	async function handleSignIn() {
		// Show the waiting panel with its spinner immediately, before
		// startDeviceAuth resolves — otherwise any backend latency leaves an empty,
		// confusing panel (no code, no spinner, no Open button) until the code lands.
		setWaiting(true);
		setPolling(true);
		setUserCode(null);
		setVerificationUri(null);
		try {
			const returnTo = IS_WEBAPP ? window.location.origin : undefined;
			const info = await startDeviceAuth(BACKEND_URL, returnTo);
			setUserCode(info.userCode);
			setVerificationUri(info.verificationUriComplete);
			// Device auth succeeded — opening the browser is best-effort; a failure
			// here must not look like sign-in failed (NavUser already .catch()es).
			await openExternal(info.verificationUriComplete).catch(() => undefined);
			setPolling(true);

			cancelPoll.current = pollAuthStatus(
				info,
				async (token) => {
					await storeSessionToken(token);
					if (!IS_WEBAPP) {
						await getCurrentWindow()
							.setFocus()
							.catch(() => {
								// Focusing the window is best-effort; ignore failures.
							});
					}
					// Webapp: prefer local Core when reachable; else cloud + nudge.
					const pick = await preferLocalOrCloud();
					if (pick === "local") {
						toast.success("Connected to your local node");
					} else if (pick === "cloud" && shouldNudgeLocalMissing()) {
						markLocalNudgeShown();
						toast.info("No local node detected", {
							description:
								"Using Ryu Cloud for now. Open the node selector to connect a local or remote node.",
						});
					}
					useAppStore.getState().setPendingAuthToken(token);
				},
				() => {
					// The poll only calls back here when sign-in times out. Explain why
					// the code screen is disappearing instead of silently bouncing the
					// user back to the start with no idea what happened.
					toast.error("Sign-in timed out", {
						description: "That took too long. Please try signing in again.",
					});
					setWaiting(false);
					setPolling(false);
					setUserCode(null);
					setVerificationUri(null);
				}
			);
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: "Failed to start device authorization";
			reportError(err instanceof Error ? err : new Error(message));
			toast.error("Couldn't start sign-in", {
				description: message.includes("localhost:3000")
					? "This build is pointing at a dev server. Reinstall the latest release."
					: message,
			});
			setWaiting(false);
			setPolling(false);
			setUserCode(null);
			setVerificationUri(null);
		}
	}

	async function handleContinueAsGuest() {
		if (guestLoading) {
			return;
		}
		setGuestLoading(true);
		try {
			const result = await authClient.signIn.anonymous();
			if (result.error) {
				throw new Error(result.error.message || "Guest sign-in failed");
			}
			const token = result.data?.token;
			if (!token) {
				throw new Error("Guest sign-in did not return a session");
			}
			// The bearer is stored in the existing local vault. It is never rendered
			// or put in the URL; the app only uses it for authenticated API calls.
			await storeSessionToken(token);
			if (browserDevice.isComputer) {
				const localReady = await preferLocalCoreIfReachable();
				if (localReady) {
					toast.success("Connected to your local node");
					useAppStore.getState().setPendingAuthToken(token);
					return;
				}
				pendingGuestToken.current = token;
				await beginCoreDownload();
				return;
			}

			await preferLocalOrCloud();
			useAppStore.getState().setPendingAuthToken(token);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Guest sign-in failed";
			toast.error("Couldn't continue as guest", { description: message });
		} finally {
			setGuestLoading(false);
		}
	}

	async function handleUseCloud() {
		const token = pendingGuestToken.current;
		coreDownloadAttempt.current += 1;
		if (!token) {
			setLocalCoreSetup(null);
			return;
		}

		setGuestLoading(true);
		try {
			const pick = await preferLocalOrCloud();
			pendingGuestToken.current = null;
			setLocalCoreSetup(null);
			if (pick === "local") {
				toast.success("Connected to your local node");
			}
			useAppStore.getState().setPendingAuthToken(token);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Ryu Cloud is unavailable.";
			toast.error("Couldn't continue with Ryu Cloud", {
				description: message,
			});
		} finally {
			setGuestLoading(false);
		}
	}

	function handleCancel() {
		cancelPoll.current?.();
		cancelPoll.current = null;
		setWaiting(false);
		setPolling(false);
		setUserCode(null);
		setVerificationUri(null);
	}

	function handleRetry() {
		// Startup failed and the app-level init effect only runs once on mount, so
		// re-run the canonical spawn-and-poll flow by reloading the webview. At the
		// login screen there is no in-memory state to lose, and the store resets to
		// "starting" — so the button immediately shows the "Getting Ryu ready…"
		// spinner again while Core boots.
		window.location.reload();
	}

	const coreStatusLabel =
		coreStatus === "stopped"
			? IS_WEBAPP
				? "Couldn't reach Ryu Cloud. Check your connection."
				: "Ryu couldn't start this time."
			: IS_WEBAPP
				? "Connecting to Ryu…"
				: "Getting Ryu ready…";

	return (
		// biome-ignore lint/a11y/noAriaHiddenOnFocusable: top area used as drag region
		<div className="size-full" data-tauri-drag-region="true">
			<LoginView
				coreReady={coreReady}
				coreStarting={IS_WEBAPP && coreStatus === "starting"}
				coreStatusLabel={coreStatusLabel}
				guestLoading={guestLoading}
				hasVerificationUri={verificationUri !== null}
				localCoreSetup={localCoreSetup}
				onCancel={handleCancel}
				onContinueAsGuest={canUseGuestMode ? handleContinueAsGuest : undefined}
				onDownloadCoreAgain={canUseGuestMode ? beginCoreDownload : undefined}
				onOpenCoreDownloads={
					canUseGuestMode
						? () => openExternal(`${WEB_URL}/download/core`)
						: undefined
				}
				onOpenVerification={() =>
					verificationUri && openExternal(verificationUri)
				}
				onRetry={handleRetry}
				onSignIn={handleSignIn}
				onUseCloud={canUseGuestMode ? handleUseCloud : undefined}
				polling={polling}
				userCode={userCode}
				waiting={waiting}
			/>
		</div>
	);
}
