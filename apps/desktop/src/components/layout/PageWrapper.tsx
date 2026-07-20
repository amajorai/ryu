import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils.ts";

interface PageWrapperProps {
	children: React.ReactNode;
}

export function PageWrapper({ children }: PageWrapperProps) {
	// The window is "edge-to-edge" (square corners, no border) whenever it is
	// either maximized or fullscreen. Tracking both is required: exiting
	// fullscreen back to a windowed size reports isMaximized() === false but
	// only fires resize events, so a maximized-only check could stay stuck.
	const [edgeToEdge, setEdgeToEdge] = useState(false);

	useEffect(() => {
		// getCurrentWebviewWindow() throws synchronously outside Tauri (browser-mode
		// dev/QA), which would trip the app-wide crash boundary on every route.
		if (!("__TAURI_INTERNALS__" in window)) {
			return;
		}
		const win = getCurrentWebviewWindow();
		let disposed = false;

		const sync = async () => {
			try {
				const [isMax, isFull] = await Promise.all([
					win.isMaximized(),
					win.isFullscreen(),
				]);
				if (!disposed) {
					setEdgeToEdge(isMax || isFull);
				}
			} catch {
				// ignore — non-Tauri/browser context
			}
		};

		sync();
		// onResized fires on every maximize/restore/fullscreen transition, so the
		// corner state updates immediately instead of waiting on a poll tick.
		const unlistenPromise = win.onResized(() => {
			sync();
		});

		return () => {
			disposed = true;
			unlistenPromise
				.then((unlisten) => unlisten())
				.catch(() => {
					// ignore — listener may already be gone
				});
		};
	}, []);

	useEffect(() => {
		if (edgeToEdge) {
			document.body.classList.add("maximized");
		} else {
			document.body.classList.remove("maximized");
		}
		// Portaled overlays (dialogs, sheets, drawers) render at document.body,
		// outside this wrapper, so they can't inherit its rounded corners. Expose
		// the live window radius as a CSS variable the @ryu/ui overlays consume
		// (rounded-[var(--ryu-window-radius,0px)]) so every backdrop matches the
		// window silhouette: the roundness-derived `--ryu-window-radius-base`
		// (set by useThemePreset.applyWindowRadius) when windowed, 0 when
		// edge-to-edge. The wrapper div below reads the same base so the two
		// stay in lockstep with the Appearance → Roundness slider.
		document.documentElement.style.setProperty(
			"--ryu-window-radius",
			edgeToEdge ? "0px" : "var(--ryu-window-radius-base, 2rem)"
		);
	}, [edgeToEdge]);

	return (
		<div
			className={cn(
				"/50 relative flex h-screen w-full overflow-hidden bg-background backdrop-blur-xl",
				edgeToEdge
					? "rounded-none"
					: "rounded-[var(--ryu-window-radius-base,2rem)]"
			)}
		>
			{children}
		</div>
	);
}
