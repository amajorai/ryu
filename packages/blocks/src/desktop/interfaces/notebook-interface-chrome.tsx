import {
	type PointerEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import { inlineSign } from "./inline-direction.ts";
import { isInterfaceCovered } from "./interface-keys.ts";

/** The Notebook shell's sidebar edge and clocks, split from notebook-interface.tsx. */

const MINUTE = 60_000;
export const SIDEBAR_WIDTH = 248;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 380;

function clampSidebar(width: number): number {
	return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
}

/**
 * Notion's sidebar edge: drag to resize, double-click to reset. Pointer only
 * (like the Sheet's column handles); the fold button covers keyboard users.
 */
export function SidebarResizeHandle({
	onResize,
	onResizingChange,
	width,
}: {
	onResize: (width: number) => void;
	onResizingChange: (resizing: boolean) => void;
	width: number;
}) {
	const origin = useRef<{ sign: 1 | -1; width: number; x: number } | null>(
		null
	);
	const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		origin.current = {
			sign: inlineSign(event.currentTarget),
			width,
			x: event.clientX,
		};
		onResizingChange(true);
	};
	const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
		const start = origin.current;
		if (start) {
			onResize(
				clampSidebar(start.width + (event.clientX - start.x) * start.sign)
			);
		}
	};
	const onPointerEnd = (event: PointerEvent<HTMLSpanElement>) => {
		if (!origin.current) {
			return;
		}
		origin.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		onResizingChange(false);
	};
	return (
		<span
			aria-hidden="true"
			className="group/resize absolute inset-y-0 end-0 z-10 w-1.5 cursor-col-resize touch-none"
			onDoubleClick={() => onResize(SIDEBAR_WIDTH)}
			onPointerCancel={onPointerEnd}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
		>
			<span className="absolute inset-y-0 end-0 w-0.5 bg-transparent transition-colors duration-150 group-hover/resize:bg-ring/50 group-active/resize:bg-ring" />
		</span>
	);
}

/** Wall clock that ticks once a minute so relative times stay honest. */
export function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's size, kept current with a ResizeObserver. */
export function useElementSize(ref: { current: HTMLElement | null }): {
	height: number;
	width: number;
} {
	const [size, setSize] = useState({ height: 0, width: 0 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const box = element.getBoundingClientRect();
		setSize({ height: box.height, width: box.width });
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (rect) {
				setSize({ height: rect.height, width: rect.width });
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

/**
 * Ctrl+\ toggles the sidebar and Ctrl+Shift+F focuses Search from anywhere
 * in the window.
 */
export function useNotebookChords(
	rootRef: { current: HTMLElement | null },
	focusSearch: () => void,
	toggleSidebar: () => void
): void {
	// Ctrl+\ and Ctrl+Shift+F work from anywhere in the window, as the
	// tooltips promise, but leave other apps' text fields alone.
	useEffect(() => {
		const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			const key = event.key.toLowerCase();
			const isSidebarChord = key === "\\" && !event.shiftKey;
			const isSearchChord = key === "f" && event.shiftKey;
			if (
				event.defaultPrevented ||
				!(isSidebarChord || isSearchChord) ||
				!(event.metaKey || event.ctrlKey) ||
				event.altKey
			) {
				return;
			}
			const target = event.target instanceof HTMLElement ? event.target : null;
			const inside = target ? rootRef.current?.contains(target) : false;
			if (!inside && target?.closest("input, textarea, [contenteditable]")) {
				return;
			}
			event.preventDefault();
			if (isSearchChord) {
				focusSearch();
			} else {
				toggleSidebar();
			}
		};
		window.addEventListener("keydown", onWindowKeyDown);
		return () => window.removeEventListener("keydown", onWindowKeyDown);
	}, [focusSearch, rootRef, toggleSidebar]);
}
