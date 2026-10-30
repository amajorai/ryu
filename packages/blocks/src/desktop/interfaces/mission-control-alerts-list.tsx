import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useRef } from "react";
import { MORE_ROW_PX, useWholeRows } from "./mission-control-hooks.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * On a wide wall a list fills the height its row was given by the station
 * board and scrolls inside it, sized to whole rows over a "more" row.
 */
const WALL_FRAME =
	"flex min-h-0 flex-1 flex-col @min-[860px]/wall:absolute @min-[860px]/wall:inset-0";

/** Ages and times: one treatment across the wall. */
export const TIME_TEXT = "text-muted-foreground text-xs tabular-nums";

/**
 * A list that never cuts a row: it stops at the last whole row that fits and
 * offers the rest through a "more" row that pages it, then returns to the top.
 */
export function WholeRowList({
	children,
	className,
	contentKey,
	listRef,
}: {
	children: ReactNode;
	className?: string;
	contentKey: string;
	listRef?: RefObject<HTMLDivElement | null>;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const [frameRef, measureRef, rows] = useWholeRows(contentKey);
	const ownRef = useRef<HTMLDivElement | null>(null);
	const setList = useCallback(
		(node: HTMLDivElement | null) => {
			measureRef(node);
			ownRef.current = node;
			if (listRef) {
				listRef.current = node;
			}
		},
		[measureRef, listRef]
	);
	const page = () => {
		const list = ownRef.current;
		if (!list) {
			return;
		}
		const behavior = reduceMotion ? "auto" : "smooth";
		if (rows.hiddenBelow === 0) {
			list.scrollTo({ behavior, top: 0 });
			return;
		}
		const visibleTo = list.scrollTop + list.clientHeight;
		const next = [...list.querySelectorAll<HTMLElement>("[data-row]")].find(
			(mark) => mark.offsetTop + mark.offsetHeight > visibleTo + 1
		);
		list.scrollTo({ behavior, top: next?.offsetTop ?? list.scrollHeight });
	};
	const clipped = rows.height !== null;
	return (
		<div className={WALL_FRAME} ref={frameRef}>
			<div
				className={cn(
					"relative min-h-0 overflow-y-auto overscroll-contain px-1 [scrollbar-width:thin]",
					className
				)}
				ref={setList}
				style={clipped ? { height: rows.height ?? undefined } : undefined}
			>
				{children}
			</div>
			{clipped ? (
				<button
					className="mx-1 flex shrink-0 items-center gap-1.5 rounded-md px-2 text-left text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					onClick={page}
					style={{ height: MORE_ROW_PX }}
					type="button"
				>
					<ChevronDown
						aria-hidden="true"
						className={cn("size-3.5", rows.hiddenBelow === 0 && "rotate-180")}
					/>
					{rows.hiddenBelow === 0
						? "Back to top"
						: tl("{hiddenBelow} more", {
								hiddenBelow: String(rows.hiddenBelow),
							})}
				</button>
			) : null}
		</div>
	);
}
