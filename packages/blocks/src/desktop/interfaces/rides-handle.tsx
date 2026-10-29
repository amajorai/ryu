import { type PointerEvent, useRef } from "react";

/** Pixels the handle must travel before a drag counts as one. */
const DRAG_PX = 24;

/**
 * The phone sheet's grab handle, as a rider app draws it: drag it up to
 * pull the sheet open, down to let it settle back to its peek height, or
 * press it (Enter or Space with the keyboard) to toggle. Hidden wherever
 * the sheet is a full-height side panel.
 */
export function SheetHandle({
	expanded,
	onExpandedChange,
}: {
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
}) {
	const startY = useRef<number | null>(null);
	const dragged = useRef(false);

	const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
		startY.current = event.clientY;
		dragged.current = false;
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
		if (startY.current === null || dragged.current) {
			return;
		}
		const travel = event.clientY - startY.current;
		if (Math.abs(travel) < DRAG_PX) {
			return;
		}
		dragged.current = true;
		onExpandedChange(travel < 0);
	};
	const onPointerUp = () => {
		startY.current = null;
	};

	return (
		<div className="flex @min-[1000px]:hidden shrink-0 justify-center pt-2">
			<button
				aria-expanded={expanded}
				aria-label={expanded ? "Collapse trips" : "Expand trips"}
				className="flex h-5 w-16 cursor-grab touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
				onClick={() => {
					// A drag already chose; only a plain press toggles.
					if (dragged.current) {
						dragged.current = false;
						return;
					}
					onExpandedChange(!expanded);
				}}
				onPointerCancel={onPointerUp}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				type="button"
			>
				<span
					aria-hidden="true"
					className="h-1 w-9 rounded-full bg-muted-foreground/40"
				/>
			</button>
		</div>
	);
}
