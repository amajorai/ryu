import { LoginView } from "@ryu/blocks/desktop/login";
import { toast } from "@ryu/ui/components/sileo";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { BACKEND_URL, storeSessionToken } from "@/lib/auth-client.ts";
import { pollAuthStatus, startDeviceAuth } from "@/lib/oauth.ts";
import {
	markLocalNudgeShown,
	preferLocalOrCloud,
	shouldNudgeLocalMissing,
} from "@/lib/prefer-local-node.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { reportError } from "@/src/lib/crash.ts";
import { useAppStore } from "../store/useAppStore.ts";

const IS_WEBAPP = import.meta.env.VITE_RYU_SURFACE === "webapp";

export default function LoginPage() {
	const [waiting, setWaiting] = useState(false);
	const [userCode, setUserCode] = useState<string | null>(null);
	const [verificationUri, setVerificationUri] = useState<string | null>(null);
	const [polling, setPolling] = useState(false);
	const cancelPoll = useRef<(() => void) | null>(null);
	const coreStatus = useAppStore((s) => s.coreStatus);
	const coreReady = coreStatus === "running";

	useEffect(() => {
		return () => {
			cancelPoll.current?.();
		};
	}, []);

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
					await getCurrentWindow()
						.setFocus()
						.catch(() => {
							// Focusing the window is best-effort; ignore failures.
						});
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
				coreStarting={coreStatus === "starting"}
				coreStatusLabel={coreStatusLabel}
				hasVerificationUri={verificationUri !== null}
				onCancel={handleCancel}
				onOpenVerification={() =>
					verificationUri && openExternal(verificationUri)
				}
				onRetry={handleRetry}
				onSignIn={handleSignIn}
				polling={polling}
				userCode={userCode}
				waiting={waiting}
			/>
		</div>
	);
}
