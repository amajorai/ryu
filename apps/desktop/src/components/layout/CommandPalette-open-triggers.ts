import { useHotkey } from "@ryu/hotkeys/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { type Dispatch, type SetStateAction, useEffect } from "react";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import { listenWhenReady } from "@/src/lib/tauri-ready.ts";

/** Hotkey, window-event, and tray triggers that open or toggle the palette. */
export function useCommandPaletteOpenTriggers(
	setOpen: Dispatch<SetStateAction<boolean>>,
	openTab: (path: string) => void
): void {
	// The palette toggle routes through the unified hotkey system so a rebind in
	// Settings → Keyboard Shortcuts retargets it live. The custom event stays for
	// the titlebar search button and tray actions that open the palette directly.
	useHotkey("command-palette.toggle", () => setOpen((prev) => !prev));

	useEffect(() => {
		const handleOpenEvent = () => setOpen(true);
		window.addEventListener("ryu:open-command-palette", handleOpenEvent);
		return () => {
			window.removeEventListener("ryu:open-command-palette", handleOpenEvent);
		};
	}, []);

	// Tray quick actions (Rust emits these from src-tauri/src/tray.rs).
	//
	// `/timeline` is an app-owned path resolved through the companion-alias
	// catch-all, and the owning app is not pre-installed — so the tray item is gated on
	// the same live feed the route mounts from, and does nothing when no enabled
	// app claims it rather than opening an "App not enabled" tab. Same AFFORDANCE
	// rule the `nav.timeline` hotkey in `Layout.tsx` already follows.
	const timelineCompanion = useCompanionAlias("/timeline");
	useEffect(() => {
		// Routed through the ready-gate. This effect runs on the first render of the
		// shell, which on a cold start can beat Tauri's injection of
		// `window.__TAURI_INTERNALS__` — and a bare `listen()` then rejects reaching
		// for `transformCallback`, which is the most frequent production signature
		// (RUST-C, 66 events). The gate queues the subscribe until the bridge lands
		// and degrades to a no-op unlisten when there is no bridge at all.
		//
		// The `.catch` is attached at subscribe time, NOT only in the cleanup: the
		// palette stays mounted for the whole session, so its cleanup never runs on
		// the boot path, and a rejection parked on an un-terminated promise fires
		// `unhandledrejection` at the window before any later `.catch` could adopt it.
		let disposed = false;
		const unlisteners: UnlistenFn[] = [];
		const track = (unlisten: UnlistenFn) => {
			// Unmounted while the subscribe was still in flight — drop it immediately
			// rather than leaking a listener with no owner.
			if (disposed) {
				unlisten();
				return;
			}
			unlisteners.push(unlisten);
		};
		const ignore = <TError>(error: TError) => {
			console.error("tray event subscription failed", error);
		};
		listenWhenReady("tray-open-timeline", () => {
			if (timelineCompanion) {
				openTab("/timeline");
			}
		})
			.then(track)
			.catch(ignore);
		listenWhenReady("tray-open-palette", () => setOpen(true))
			.then(track)
			.catch(ignore);
		return () => {
			disposed = true;
			for (const unlisten of unlisteners) {
				unlisten();
			}
		};
		// `timelineCompanion` is a plain string|null, so this only re-subscribes
		// when the owning app is actually enabled or disabled.
	}, [openTab, timelineCompanion]);
}
