import { useDirection } from "@ryu/ui/components/direction.tsx";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type DockDirection,
	dockResizeDelta,
} from "./workspace-dock-direction.ts";

// ── Drag resize hook ──────────────────────────────────────────────────────────

export function useResizeHandle(
	direction: "vertical" | "horizontal",
	setSize: (updater: (prev: number) => number) => void,
	dirOverride?: DockDirection
) {
	// The horizontal dock sits on the inline-end edge, so RTL mirrors the drag.
	const contextDir = useDirection();
	const dir = dirOverride ?? contextDir;
	const resizing = useRef(false);
	const startPos = useRef(0);
	const startSize = useRef(0);
	// Exposed so callers can suppress the open/close transition while dragging,
	// otherwise the size transition fights the live drag and feels laggy.
	const [isResizing, setIsResizing] = useState(false);

	const onMouseDown = useCallback(
		(e: ReactMouseEvent, currentSize: number) => {
			e.preventDefault();
			resizing.current = true;
			setIsResizing(true);
			startPos.current = direction === "vertical" ? e.clientY : e.clientX;
			startSize.current = currentSize;
			document.body.style.cursor =
				direction === "vertical" ? "row-resize" : "col-resize";
			document.body.style.userSelect = "none";
		},
		[direction]
	);

	useEffect(() => {
		const onMove = (e: MouseEvent) => {
			if (!resizing.current) {
				return;
			}
			const pos = direction === "vertical" ? e.clientY : e.clientX;
			const delta = dockResizeDelta(direction, dir, startPos.current, pos);
			setSize(() => Math.max(80, Math.min(800, startSize.current + delta)));
		};
		const onUp = () => {
			if (!resizing.current) {
				return;
			}
			resizing.current = false;
			setIsResizing(false);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
		document.addEventListener("mousemove", onMove, { passive: true });
		document.addEventListener("mouseup", onUp);
		return () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
	}, [direction, dir, setSize]);

	return { onMouseDown, isResizing };
}
