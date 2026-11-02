import { cn } from "@ryu/ui/lib/utils";
import { CELL_SIZE, HEAD_SIZE, TILE_ATTRIBUTE } from "./quiz-board.tsx";
import { TILE_BEVEL, TILE_FACE } from "./quiz-palette.ts";

const SKELETON_COLUMNS = ["c0", "c1", "c2", "c3", "c4", "c5"];
const SKELETON_ROWS = ["r0", "r1", "r2", "r3", "r4"];

/** The board while the first snapshot loads: unlit cells, a soft pulse. */
export function QuizBoardSkeleton() {
	return SKELETON_COLUMNS.map((column) => (
		<div className="flex min-h-0 min-w-0 flex-col gap-1.5" key={column}>
			<div
				className={cn(
					"mb-1.5 flex shrink-0 items-center justify-center rounded-[3px]",
					HEAD_SIZE
				)}
				style={{ backgroundImage: TILE_FACE, boxShadow: TILE_BEVEL }}
			>
				<span className="h-2.5 w-3/5 rounded-full bg-(--quiz-lamp-off) motion-safe:animate-pulse" />
			</div>
			{SKELETON_ROWS.map((row) => (
				<div
					className={cn(
						"flex items-center justify-center rounded-[3px]",
						CELL_SIZE
					)}
					key={row}
					style={{ backgroundImage: TILE_FACE, boxShadow: TILE_BEVEL }}
				>
					<span className="h-5 w-1/3 rounded-sm bg-(--quiz-lamp-off) motion-safe:animate-pulse" />
				</div>
			))}
		</div>
	));
}

/** Scroll a tile into view (the folded board scrolls) without moving focus. */
export function revealTile(container: HTMLElement | null, threadId: string) {
	container
		?.querySelector<HTMLElement>(
			`[${TILE_ATTRIBUTE}][data-thread-id="${CSS.escape(threadId)}"]`
		)
		?.scrollIntoView({ block: "nearest" });
}

/** Focus a tile by thread id inside the board (used for arrow keys and returns). */
export function focusTile(
	container: HTMLElement | null,
	threadId: string
): boolean {
	const tile = container?.querySelector<HTMLElement>(
		`[${TILE_ATTRIBUTE}][data-thread-id="${CSS.escape(threadId)}"]`
	);
	tile?.focus();
	return Boolean(tile);
}
