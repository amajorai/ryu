import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	DASHBOARD_LAYOUT_KEY,
	type DashboardLayout,
	DEFAULT_LAYOUT,
	type LayoutItem,
	moveWidget,
	parseLayout,
	serializeLayout,
	type WidgetId,
} from "./dashboard-model.ts";

/** The current time, refreshed on each `intervalMs` boundary. */
export function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const schedule = () => {
			timer = setTimeout(
				() => {
					setNow(Date.now());
					schedule();
				},
				intervalMs - (Date.now() % intervalMs)
			);
		};
		setNow(Date.now());
		schedule();
		return () => clearTimeout(timer);
	}, [intervalMs]);
	return now;
}

function readStoredLayout(): LayoutItem[] {
	try {
		return (
			parseLayout(globalThis.localStorage?.getItem(DASHBOARD_LAYOUT_KEY)) ?? [
				...DEFAULT_LAYOUT,
			]
		);
	} catch {
		return [...DEFAULT_LAYOUT];
	}
}

function writeStoredLayout(layout: DashboardLayout | null): void {
	try {
		if (layout) {
			globalThis.localStorage?.setItem(
				DASHBOARD_LAYOUT_KEY,
				serializeLayout(layout)
			);
		} else {
			globalThis.localStorage?.removeItem(DASHBOARD_LAYOUT_KEY);
		}
	} catch {
		// Storage can be blocked (private windows, previews); the layout still
		// works for this session and simply is not remembered.
	}
}

/**
 * The viewer's widget arrangement, remembered in this browser. Every change
 * is written straight away; `reset` forgets it and returns to the default.
 */
export function useDashboardLayout(): {
	layout: LayoutItem[];
	reset: () => void;
	update: (next: (current: LayoutItem[]) => LayoutItem[]) => void;
} {
	const [layout, setLayout] = useState<LayoutItem[]>(readStoredLayout);
	const update = useCallback(
		(next: (current: LayoutItem[]) => LayoutItem[]) => {
			setLayout((current) => {
				const value = next(current);
				writeStoredLayout(value);
				return value;
			});
		},
		[]
	);
	const reset = useCallback(() => {
		writeStoredLayout(null);
		setLayout([...DEFAULT_LAYOUT]);
	}, []);
	return { layout, reset, update };
}

/** Ignore new drop targets briefly while the grid animates into its new order. */
const SETTLE_MS = 180;

/**
 * Pointer-driven reordering for the edit grid. Dragging over another widget
 * moves the dragged one into its slot straight away, so the grid reflows
 * under the pointer the way Notion and Datadog boards do. Uses pointer events
 * (not HTML drag and drop) so it behaves the same inside desktop webviews.
 */
export function useWidgetDrag(
	update: (next: (current: LayoutItem[]) => LayoutItem[]) => void
): {
	draggingId: WidgetId | null;
	startDrag: (id: WidgetId, event: ReactPointerEvent<HTMLElement>) => void;
} {
	const [draggingId, setDraggingId] = useState<WidgetId | null>(null);
	const settleRef = useRef(0);
	const cleanupRef = useRef<(() => void) | null>(null);

	useEffect(() => () => cleanupRef.current?.(), []);

	const startDrag = useCallback(
		(id: WidgetId, event: ReactPointerEvent<HTMLElement>) => {
			if (event.button !== 0) {
				return;
			}
			event.preventDefault();
			cleanupRef.current?.();
			setDraggingId(id);
			const onMove = (move: PointerEvent) => {
				if (performance.now() < settleRef.current) {
					return;
				}
				const hit = document
					.elementFromPoint(move.clientX, move.clientY)
					?.closest<HTMLElement>("[data-widget-id]");
				const targetId = hit?.dataset.widgetId;
				if (!targetId || targetId === id) {
					return;
				}
				settleRef.current = performance.now() + SETTLE_MS;
				update((current) => {
					const to = current.findIndex((item) => item.id === targetId);
					return to < 0 ? current : moveWidget(current, id, to);
				});
			};
			const finish = () => {
				cleanupRef.current?.();
			};
			const onKey = (key: KeyboardEvent) => {
				if (key.key === "Escape") {
					finish();
				}
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", finish);
			document.addEventListener("pointercancel", finish);
			document.addEventListener("keydown", onKey);
			cleanupRef.current = () => {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", finish);
				document.removeEventListener("pointercancel", finish);
				document.removeEventListener("keydown", onKey);
				cleanupRef.current = null;
				setDraggingId(null);
			};
		},
		[update]
	);

	return { draggingId, startDrag };
}
