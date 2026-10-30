import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useRef } from "react";
// Boot effects fire before Tauri is guaranteed to have injected
// `window.__TAURI_INTERNALS__`, and `listen()` reaches into it for
// `transformCallback` — the single most frequent production error on 0.1.11.
// The gate makes an early subscription wait for the bridge instead of rejecting.
import { listenWhenReady } from "@/src/lib/tauri-ready.ts";
import {
	type InstallerProgress,
	installerComponentLabel,
} from "../lib/installer-progress.ts";
import { isOnboardingActive } from "../lib/onboarding-active.ts";

/** Terminates a `listenWhenReady(...).then(...)` chain. Outside Tauri the gate
 *  already resolves to a no-op unlisten, so reaching here means a real subscribe
 *  failure — worth a log, never worth an unhandled rejection at the window. */
function ignoreSubscribeFailure<TError>(error: TError): void {
	console.error("tauri event subscription failed", error);
}

/** Toasts for native events: background installer progress and Quick Capture. */
export function useNativeEventToasts(botProduct: boolean): void {
	// `tl` is a fresh function each render; read it through a ref so the
	// subscription is not torn down and re-made on every render.
	const tlCurrent = useLiteralMessages();
	const tlRef = useRef(tlCurrent);
	tlRef.current = tlCurrent;
	useEffect(() => {
		if (botProduct) {
			return;
		}
		// Surface the same versioned installer stream used inline by onboarding. A
		// no-op in onboarding avoids stacking a toast over the progress card; outside
		// the wizard this keeps background setup visible too.
		const unlisteners: (() => void)[] = [];
		listenWhenReady<InstallerProgress>("installer-progress", ({ payload }) => {
			if (isOnboardingActive()) {
				return;
			}
			const tl = tlRef.current;
			const label = installerComponentLabel(payload.component);
			const progress =
				payload.percent === undefined
					? undefined
					: `${payload.percent}% of setup`;
			if (payload.phase === "binary" && payload.status === "started") {
				toast.show({
					title: tl("Installing {componentLabel}", { componentLabel: label }),
					description: progress,
					type: "loading",
					duration: null,
				});
			} else if (
				payload.phase === "binary" &&
				(payload.status === "complete" || payload.status === "skipped")
			) {
				toast.success(
					payload.status === "skipped"
						? tl("{componentLabel} is already installed", {
								componentLabel: label,
							})
						: tl("{componentLabel} installed", { componentLabel: label })
				);
			} else if (payload.phase === "core" && payload.status === "started") {
				toast.show({
					title: "Starting Ryu Core",
					description: progress,
					type: "loading",
					duration: null,
				});
			} else if (payload.phase === "defaults") {
				if (
					payload.component === "bundled-defaults" &&
					payload.status === "started"
				) {
					toast.show({
						title: "Setting up Ryu",
						description:
							"Bundled models, engines, and skills are downloading in the background.",
						type: "loading",
						duration: null,
					});
				}
			} else if (
				payload.phase === "bootstrap" &&
				payload.status === "complete"
			) {
				toast.success("Core is ready; bundled defaults continue downloading");
			} else if (payload.phase === "error") {
				toast.error(payload.error ?? "Ryu setup failed");
			}
		})
			.then((fn) => unlisteners.push(fn))
			.catch(ignoreSubscribeFailure);
		return () => {
			for (const fn of unlisteners) {
				fn();
			}
		};
	}, [botProduct]);

	useEffect(() => {
		// Quick Capture (double-tap Shift). The gesture happens while another app is
		// frontmost, so the toast is the ONLY feedback that it worked — without it
		// the user has no way to tell a capture from a missed tap.
		const unlisteners: (() => void)[] = [];
		listenWhenReady<{ title?: string; source?: { app?: string | null } }>(
			"quick-capture:kept",
			({ payload }) => {
				toast.success({
					title: "Kept",
					description: payload.source?.app
						? `${payload.title ?? "Selection"} · from ${payload.source.app}`
						: (payload.title ?? "Selection"),
				});
			}
		)
			.then((fn) => unlisteners.push(fn))
			.catch(ignoreSubscribeFailure);
		listenWhenReady<{ error?: string }>(
			"quick-capture:failed",
			({ payload }) => {
				toast.error({
					title: "Couldn't keep that",
					description: payload.error ?? "The capture didn't reach Ryu.",
				});
			}
		)
			.then((fn) => unlisteners.push(fn))
			.catch(ignoreSubscribeFailure);
		return () => {
			for (const fn of unlisteners) {
				fn();
			}
		};
	}, []);
}
