// Windowed rendering for long sidebar chat lists.
//
// A sidebar with every chat revealed (page size "All", or a date / group-by view
// with hundreds of chats) used to mount one full ChatRow per chat. Past
// CHAT_ROW_VIRTUALIZE_THRESHOLD entries, ChatRowList hands its entries to this
// list, which mounts only the rows near the sidebar's scroll viewport. Rows are
// measured, so expanded rows, previews and group headers keep their real height.
//
// Rows that other sidebar features read from the DOM stay mounted even when
// they are offscreen: the open chat, the focused row (keyboard navigation and
// inline rename), the row being dragged (its dragend must still fire), and the
// nearest unread row above and below the window (the "More unreads" pills).
// Range selection sees unmounted rows through the virtual-list registry.

import { SidebarMenu } from "@ryu/ui/components/sidebar.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	defaultRangeExtractor,
	measureElement as measureVirtualElement,
	type Range,
	useVirtualizer,
} from "@tanstack/react-virtual";
import {
	type FocusEvent,
	Fragment,
	type DragEvent as ReactDragEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { sidebarChatRowIdsWithin } from "./sidebar-chat-selection.tsx";
import {
	registerSidebarVirtualChatRows,
	SIDEBAR_CHAT_VIRTUAL_LIST_ATTRIBUTES,
} from "./sidebar-chat-virtual-registry.ts";

/** Lists longer than this many entries render windowed. */
export const CHAT_ROW_VIRTUALIZE_THRESHOLD = 100;
/** A single-line chat row is `h-8`. */
const ROW_ESTIMATE_PX = 32;
/** `SidebarMenu`'s `gap-0.5`. */
const ROW_GAP_PX = 2;
const OVERSCAN_ROWS = 12;
/** First-paint viewport guess, replaced by the real scroller's size. */
const INITIAL_VIEWPORT = { height: 800, width: 0 };
const ENTRY_ATTRIBUTE = "data-virtual-chat-entry";

export interface VirtualChatRowEntry {
	/** Chat ids the entry shows when it is not expanded, in visual order. */
	ids: readonly string[];
	key: string;
	unread: boolean;
}

function scrollParentOf(element: HTMLElement): HTMLElement | null {
	for (let node = element.parentElement; node; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if (overflowY === "auto" || overflowY === "scroll") {
			return node;
		}
	}
	return null;
}

/** The list's top edge in the scroller's content coordinates. */
function offsetWithin(list: HTMLElement, scroller: HTMLElement): number {
	return Math.round(
		list.getBoundingClientRect().top -
			scroller.getBoundingClientRect().top +
			scroller.scrollTop
	);
}

/** Layout-free environments (and hidden rows) measure 0; keep the estimate. */
function measureEntry(
	element: Element,
	entry: ResizeObserverEntry | undefined,
	instance: Parameters<typeof measureVirtualElement>[2]
): number {
	const size = measureVirtualElement(element, entry, instance);
	return size > 0 ? size : ROW_ESTIMATE_PX;
}

function entryIndexOf(target: EventTarget | null): number | null {
	if (!(target instanceof Element)) {
		return null;
	}
	const index = target
		.closest(`[${ENTRY_ATTRIBUTE}]`)
		?.getAttribute("data-index");
	return index == null ? null : Number(index);
}

export function VirtualChatRowList({
	activeId,
	className,
	entries,
	renderEntry,
}: {
	activeId: string | null;
	className?: string;
	entries: readonly VirtualChatRowEntry[];
	renderEntry: (index: number) => ReactNode;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const entriesRef = useRef(entries);
	entriesRef.current = entries;
	// `undefined` until the first layout pass; `null` when nothing scrolls.
	const [scroller, setScroller] = useState<HTMLElement | null | undefined>();
	const [scrollMargin, setScrollMargin] = useState(0);
	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
	const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
	const [reveal, setReveal] = useState<{ id: string; index: number } | null>(
		null
	);

	const activeIndex = useMemo(
		() => (activeId ? entries.findIndex((e) => e.ids.includes(activeId)) : -1),
		[activeId, entries]
	);
	const unreadIndices = useMemo(() => {
		const indices: number[] = [];
		entries.forEach((entry, index) => {
			if (entry.unread) {
				indices.push(index);
			}
		});
		return indices;
	}, [entries]);
	const keptIndices = [activeIndex, focusedIndex, draggingIndex, reveal?.index]
		.filter((index): index is number => typeof index === "number" && index >= 0)
		.sort((left, right) => left - right);
	const keptSignature = keptIndices.join(",");

	const rangeExtractor = useCallback(
		(range: Range) => {
			const indices = new Set(defaultRangeExtractor(range));
			for (const index of keptSignature ? keptSignature.split(",") : []) {
				const value = Number(index);
				if (value < range.count) {
					indices.add(value);
				}
			}
			let above: number | undefined;
			let below: number | undefined;
			for (const index of unreadIndices) {
				if (index < range.startIndex) {
					above = index;
				} else if (index > range.endIndex && below === undefined) {
					below = index;
				}
			}
			for (const index of [above, below]) {
				if (index !== undefined && index < range.count) {
					indices.add(index);
				}
			}
			return [...indices].sort((left, right) => left - right);
		},
		[keptSignature, unreadIndices]
	);

	const virtualizer = useVirtualizer({
		count: entries.length,
		estimateSize: () => ROW_ESTIMATE_PX,
		gap: ROW_GAP_PX,
		getItemKey: (index) => entriesRef.current[index]?.key ?? index,
		getScrollElement: () => scroller ?? null,
		initialRect: INITIAL_VIEWPORT,
		measureElement: measureEntry,
		overscan: OVERSCAN_ROWS,
		rangeExtractor,
		scrollMargin,
		// Measuring inside a ref callback must not flush React synchronously.
		useFlushSync: false,
	});

	// Find the scroller and the list's offset inside it before paint.
	useLayoutEffect(() => {
		const list = listRef.current;
		if (!list) {
			return;
		}
		const next = scroller === undefined ? scrollParentOf(list) : scroller;
		if (next !== scroller) {
			setScroller(next);
		}
		if (next) {
			const margin = offsetWithin(list, next);
			setScrollMargin((current) => (current === margin ? current : margin));
		}
	});

	// Sections above the list expand and collapse without a scroll event.
	useEffect(() => {
		const list = listRef.current;
		if (!(scroller && list) || typeof ResizeObserver !== "function") {
			return;
		}
		const update = () => {
			const margin = offsetWithin(list, scroller);
			setScrollMargin((current) => (current === margin ? current : margin));
		};
		const observer = new ResizeObserver(update);
		observer.observe(scroller);
		for (const child of scroller.children) {
			observer.observe(child);
		}
		return () => observer.disconnect();
	}, [scroller]);

	// Opening a chat elsewhere (a tab, search, a link) brings its row into view.
	const lastActiveId = useRef(activeId);
	useEffect(() => {
		if (activeId === lastActiveId.current) {
			return;
		}
		lastActiveId.current = activeId;
		if (scroller && activeIndex >= 0) {
			virtualizer.scrollToIndex(activeIndex, { align: "auto" });
		}
	}, [activeId, activeIndex, scroller, virtualizer]);

	// Arrow-key navigation into an unmounted row: focus it once it mounts.
	useEffect(() => {
		if (!reveal) {
			return;
		}
		const row = listRef.current?.querySelector<HTMLElement>(
			`[data-sidebar-chat-id="${CSS.escape(reveal.id)}"]`
		);
		if (row) {
			row.focus();
			setReveal(null);
		}
	});

	useEffect(() => {
		const list = listRef.current;
		if (!list) {
			return;
		}
		return registerSidebarVirtualChatRows(list, {
			orderedIds: () => {
				const mounted = new Map<number, Element>();
				for (const element of list.querySelectorAll(`[${ENTRY_ATTRIBUTE}]`)) {
					mounted.set(Number(element.getAttribute("data-index")), element);
				}
				return entriesRef.current.flatMap((entry, index) => {
					const element = mounted.get(index);
					return element ? sidebarChatRowIdsWithin(element) : [...entry.ids];
				});
			},
			reveal: (id) => {
				const index = entriesRef.current.findIndex((e) => e.ids.includes(id));
				if (index < 0) {
					return;
				}
				setReveal({ id, index });
				virtualizer.scrollToIndex(index, { align: "auto" });
			},
		});
	}, [virtualizer]);

	const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
		setFocusedIndex(entryIndexOf(event.target));
	};
	const onBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
		if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
			setFocusedIndex(null);
		}
	};
	const onDragStartCapture = (event: ReactDragEvent<HTMLDivElement>) => {
		setDraggingIndex(entryIndexOf(event.target));
	};

	if (scroller === null) {
		// Nothing scrolls this list (an unbounded container): window it would
		// hide rows for good, so render every entry.
		return (
			<div className={cn("w-full min-w-0", className)} ref={listRef}>
				<SidebarMenu>
					{entries.map((entry, index) => (
						<Fragment key={entry.key}>{renderEntry(index)}</Fragment>
					))}
				</SidebarMenu>
			</div>
		);
	}

	return (
		<div
			{...SIDEBAR_CHAT_VIRTUAL_LIST_ATTRIBUTES}
			className={cn("relative w-full min-w-0", className)}
			data-testid="sidebar-virtual-chat-rows"
			onBlurCapture={onBlurCapture}
			onDragEndCapture={() => setDraggingIndex(null)}
			onDragStartCapture={onDragStartCapture}
			onFocusCapture={onFocusCapture}
			ref={listRef}
			// Each window entry is its own presentational menu; this is the list.
			role="list"
			style={{ height: virtualizer.getTotalSize() }}
		>
			{virtualizer.getVirtualItems().map((item) => (
				<SidebarMenu
					{...{ [ENTRY_ATTRIBUTE]: "" }}
					className="absolute top-0 left-0"
					data-index={item.index}
					key={item.key}
					ref={virtualizer.measureElement}
					role="none"
					style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
				>
					{renderEntry(item.index)}
				</SidebarMenu>
			))}
		</div>
	);
}
