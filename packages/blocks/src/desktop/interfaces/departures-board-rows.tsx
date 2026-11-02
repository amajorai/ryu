import { translate as tr } from "@ryu/i18n/lite";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ReactNode,
	type RefObject,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	COLUMN,
	ROW_GRID,
	ROW_HEIGHT_PX,
	SMALL_CAPS,
} from "./departures-board.tsx";
import { BlankFlap, BlankFlapText, FlapText } from "./departures-flap.tsx";
import {
	type DeparturesBoard,
	STATUS_FLAP_LENGTH,
} from "./departures-model.ts";

/** The board's filler rows, loading rows, footer, and empty state. */

const MAX_SPARE_ROWS = 40;

/** Whole rows that fit a height, so the board never ends on a cut-off row. */
export function spareRowCount(height: number): number {
	return Math.max(
		0,
		Math.min(MAX_SPARE_ROWS, Math.floor(height / ROW_HEIGHT_PX))
	);
}

/** How many whole spare rows fit the space the flights leave. */
function useSpareRows(): [RefObject<HTMLDivElement | null>, number] {
	const ref = useRef<HTMLDivElement>(null);
	const [rows, setRows] = useState(0);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) {
			return;
		}
		const measure = () => setRows(spareRowCount(node.clientHeight));
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	return [ref, rows];
}

/**
 * Unused board positions: blank flaps, the same hardware as a live row with
 * nothing printed on it. They fill the height the flights leave, in whole
 * rows; what is left under the last one is the board's frame.
 */
export function BoardSpareRows({
	offset,
	showTerminal,
}: {
	/** Rows already on the board, so the shading keeps alternating. */
	offset: number;
	showTerminal: boolean;
}) {
	const [ref, count] = useSpareRows();
	const rows = Array.from({ length: count }, (_, row) => `spare-${row}`);
	return (
		<div
			aria-hidden="true"
			className="flex min-h-0 flex-1 flex-col overflow-hidden"
			ref={ref}
		>
			{rows.map((row, index) => (
				<div
					className={cn(
						ROW_GRID,
						"h-12 shrink-0",
						(index + offset) % 2 === 1
							? "bg-(--dep-row-alt)"
							: "bg-(--dep-board)"
					)}
					key={row}
				>
					<span className={COLUMN.time}>
						<BlankFlapText length={5} />
					</span>
					<span className={COLUMN.flight}>
						<BlankFlapText length={7} />
					</span>
					<span className={COLUMN.title}>
						<BlankFlap className="h-7 w-full" />
					</span>
					<span className={COLUMN.gate}>
						<BlankFlap className="h-7 w-full" />
					</span>
					{showTerminal ? <span className={COLUMN.terminal} /> : null}
					<span className={COLUMN.status}>
						<span className="size-2 shrink-0" />
						<BlankFlapText className="@6xl:hidden" length={3} />
						<BlankFlapText
							className="@6xl:inline-flex hidden"
							length={STATUS_FLAP_LENGTH}
						/>
					</span>
					<span className={COLUMN.remarks} />
				</div>
			))}
		</div>
	);
}

const LOADING_ROWS = Array.from({ length: 12 }, (_, row) => `loading-${row}`);

/** While the first snapshot loads: soft bars in the column slots, pulsing. */
export function BoardLoadingRows() {
	const bar =
		"h-7 rounded-[0.18em] bg-(--dep-tile-bottom) motion-safe:animate-pulse";
	return (
		<div
			aria-hidden="true"
			className="flex min-h-0 flex-1 flex-col overflow-hidden border-(--dep-rule) border-t"
		>
			{LOADING_ROWS.map((row, index) => (
				<div
					className={cn(
						ROW_GRID,
						"h-12 shrink-0",
						index % 2 === 1 ? "bg-(--dep-row-alt)" : "bg-(--dep-board)"
					)}
					key={row}
				>
					<span className={cn(COLUMN.time, bar)} />
					<span className={cn(COLUMN.flight, bar)} />
					<span className={cn(COLUMN.title, bar)} />
					<span className={cn(COLUMN.gate, bar)} />
					<span className={COLUMN.status}>
						<span className="size-2 shrink-0" />
						<span className={cn("flex-1", bar)} />
					</span>
					<span className={COLUMN.remarks} />
				</div>
			))}
		</div>
	);
}

/** The board's foot line: how to drive it, printed like a FIDS ticker. */
export function BoardFooter({ panelOpen }: { panelOpen: boolean }) {
	const hints = [
		tr("↑ ↓ Select"),
		tr("Enter Open"),
		tr("← → Switch board"),
		panelOpen ? tr("Esc Close") : null,
	].filter(Boolean);
	return (
		<p
			className={cn(
				"@3xl:flex hidden h-8 shrink-0 items-center gap-6 border-(--dep-rule) border-t @5xl:px-5 px-4 text-(--dep-ink-faint)",
				SMALL_CAPS
			)}
		>
			{hints.map((hint) => (
				<span key={hint}>{hint}</span>
			))}
		</p>
	);
}

/** The board with nothing on it: a flap message and one plain line. */
export function BoardEmpty({
	action,
	board,
	description,
}: {
	action?: ReactNode;
	board: DeparturesBoard;
	description: string;
}) {
	const message =
		board === "arrivals" ? tr("No arrivals") : tr("No departures");
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 border-(--dep-rule) border-t px-6 py-16 text-center">
			<p className="sr-only">{message}</p>
			<FlapText
				className="font-mono font-semibold text-lg"
				length={message.length}
				tileClassName="h-8 w-[22px]"
				value={message}
			/>
			<p className="max-w-sm text-(--dep-ink-dim) text-sm">{description}</p>
			{action}
		</div>
	);
}
