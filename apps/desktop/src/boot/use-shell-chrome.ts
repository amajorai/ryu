import { useEffect } from "react";
import { applyDecorumChrome } from "@/src/lib/decorumTitlebar.ts";
import { initBackgroundCustomization } from "../hooks/useBackgroundCustomization.ts";
import { initChromeShadows } from "../hooks/useChromeShadows.ts";
import { initInvertedBackgrounds } from "../hooks/useInvertedBackgrounds.ts";
import { initPointerCursor } from "../hooks/usePointerCursor.ts";
import {
	initAnimationsPreference,
	initTheme,
} from "../hooks/useThemePreset.ts";

/** Applies the persisted appearance preferences and keeps the native titlebar
 *  fix in place. */
export function useShellChrome(): void {
	useEffect(() => {
		// `initDialogOverlayBlur()` is deliberately NOT here — it runs in main.tsx
		// module scope, because its default is off while the CSS base state is on,
		// so applying it one effect late would flash a blurred backdrop.
		initTheme();
		initAnimationsPreference();
		initPointerCursor();
		initChromeShadows();
		initInvertedBackgrounds();
		initBackgroundCustomization();
	}, []);

	useEffect(() => {
		// macOS keeps the native traffic lights restored by the native titlebar
		// plugin. Decorum's injected overlay is a Windows/Linux concern; observing
		// every DOM mutation here on macOS only reintroduces a second shell layer.
		if (navigator.userAgent.includes("Mac")) {
			return;
		}
		// tauri-plugin-decorum re-asserts its native titlebar (full width, with its
		// own drag region) on window events — focus, maximize/restore, resize. The
		// old fix only ran on a 5s interval, so any revert AFTER that window left a
		// full-width decorum bar covering the app's titlebar with the drag region
		// already stripped — making the titlebar undraggable AND the tabs unclickable.
		// Re-assert the fix permanently: an observer (disconnected during our own
		// writes so they don't re-trigger it) plus the same window events decorum
		// reacts to. Also mirrors auto-hide tuck onto the caption buttons.
		const observeOpts: MutationObserverInit = {
			attributes: true,
			attributeFilter: ["style", "class"],
			childList: true,
			subtree: true,
		};
		// Debounced via rAF so a burst of unrelated DOM mutations (e.g. a streaming
		// chat) coalesces into a single fix per frame. Disconnect around our own
		// writes so they never re-trigger the observer into a loop.
		let scheduled = false;
		const run = () => {
			scheduled = false;
			observer.disconnect();
			applyDecorumChrome();
			observer.observe(document.documentElement, observeOpts);
		};
		const observer = new MutationObserver(() => {
			if (scheduled) {
				return;
			}
			scheduled = true;
			requestAnimationFrame(run);
		});
		applyDecorumChrome();
		observer.observe(document.documentElement, observeOpts);
		window.addEventListener("focus", applyDecorumChrome);
		window.addEventListener("resize", applyDecorumChrome);
		return () => {
			observer.disconnect();
			window.removeEventListener("focus", applyDecorumChrome);
			window.removeEventListener("resize", applyDecorumChrome);
		};
	}, []);
}
