import { useI18n } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useRef, useState } from "react";
import { useAutoHideTitleBar } from "@/src/hooks/useAutoHideTitleBar.ts";
import { setTitlebarHidden } from "@/src/lib/decorumTitlebar.ts";
import { toggleFullscreen, useFullscreen } from "@/src/lib/fullscreen.ts";

/**
 * Auto-hide for the title bar: slides the bar away until the cursor nears the
 * top edge, and keeps it peeked while a strip menu or a caption button holds it.
 */
export function useTitleBarAutoHide(isMobile: boolean) {
	const { t } = useI18n();
	// Auto-hide slides the bar away until the cursor nears the top edge. Forced
	// off on mobile — there's no hover-peek equivalent and the Sheet already
	// owns navigation chrome.
	const [autoHideTitleBar, setAutoHideTitleBar] = useAutoHideTitleBar();
	// Fullscreen forces the same reveal-on-hover behaviour without touching the
	// saved preference, so an Electron-style fullscreen actually clears the chrome
	// instead of leaving a fake titlebar painted across the top of the display.
	// Hover still peeks it, so tabs stay reachable.
	const isFullscreen = useFullscreen();
	const effectiveAutoHide = (autoHideTitleBar || isFullscreen) && !isMobile;
	const handleToggleFullscreen = () => {
		toggleFullscreen().catch(() => {
			toast.error(
				t(
					"shell.fullscreen-error",
					undefined,
					"Couldn't toggle full screen in this window."
				)
			);
		});
	};
	const [titleBarPeeked, setTitleBarPeeked] = useState(false);
	const [titleBarMenuOpen, setTitleBarMenuOpen] = useState(false);
	const titleBarMenuOpenRef = useRef(false);
	const titleBarHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!effectiveAutoHide) {
			if (titleBarHideTimer.current) {
				clearTimeout(titleBarHideTimer.current);
				titleBarHideTimer.current = null;
			}
			setTitleBarPeeked(false);
			setTitleBarMenuOpen(false);
			titleBarMenuOpenRef.current = false;
		}
	}, [effectiveAutoHide]);

	useEffect(() => {
		return () => {
			if (titleBarHideTimer.current) {
				clearTimeout(titleBarHideTimer.current);
			}
		};
	}, []);

	const showTitleBarPeek = () => {
		if (titleBarHideTimer.current) {
			clearTimeout(titleBarHideTimer.current);
			titleBarHideTimer.current = null;
		}
		setTitleBarPeeked(true);
	};

	const scheduleTitleBarHide = () => {
		// Keep the bar up while a strip context menu is open — otherwise the
		// leave-to-menu path hides the trigger and the menu loses its anchor.
		if (titleBarMenuOpenRef.current) {
			return;
		}
		if (titleBarHideTimer.current) {
			clearTimeout(titleBarHideTimer.current);
		}
		titleBarHideTimer.current = setTimeout(() => setTitleBarPeeked(false), 200);
	};

	const onTitleBarMenuOpenChange = (open: boolean) => {
		titleBarMenuOpenRef.current = open;
		setTitleBarMenuOpen(open);
		if (open) {
			showTitleBarPeek();
		} else {
			scheduleTitleBarHide();
		}
	};

	const titleBarVisible =
		!effectiveAutoHide || titleBarPeeked || titleBarMenuOpen;

	// Mirror tuck onto Decorum's Windows/Linux caption buttons (separate DOM
	// overlay). Cleared on unmount so a remount never leaves them stuck hidden.
	useEffect(() => {
		setTitlebarHidden(effectiveAutoHide && !titleBarVisible);
	}, [effectiveAutoHide, titleBarVisible]);

	useEffect(() => {
		return () => {
			setTitlebarHidden(false);
		};
	}, []);

	// Caption buttons live outside the React title bar; keep the peek up while
	// the cursor is over them so min/max/close stay reachable after a peek.
	const showTitleBarPeekRef = useRef(showTitleBarPeek);
	const scheduleTitleBarHideRef = useRef(scheduleTitleBarHide);
	showTitleBarPeekRef.current = showTitleBarPeek;
	scheduleTitleBarHideRef.current = scheduleTitleBarHide;

	useEffect(() => {
		if (!effectiveAutoHide) {
			return;
		}
		const container = document.querySelector<HTMLElement>(
			"[data-tauri-decorum-tb]"
		);
		if (!container) {
			return;
		}
		// Container itself is pointer-events:none; listen for bubbled events from
		// the caption buttons so moving onto min/max/close keeps the peek up.
		const onOver = () => {
			showTitleBarPeekRef.current();
		};
		const onOut = (e: MouseEvent) => {
			const next = e.relatedTarget;
			if (next instanceof Node && container.contains(next)) {
				return;
			}
			scheduleTitleBarHideRef.current();
		};
		container.addEventListener("mouseover", onOver);
		container.addEventListener("mouseout", onOut);
		return () => {
			container.removeEventListener("mouseover", onOver);
			container.removeEventListener("mouseout", onOut);
		};
	}, [effectiveAutoHide]);

	return {
		autoHideTitleBar,
		setAutoHideTitleBar,
		isFullscreen,
		effectiveAutoHide,
		handleToggleFullscreen,
		showTitleBarPeek,
		scheduleTitleBarHide,
		onTitleBarMenuOpenChange,
		titleBarVisible,
	};
}
