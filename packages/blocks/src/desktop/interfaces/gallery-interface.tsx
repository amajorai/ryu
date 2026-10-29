import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { GALLERY_CARD_ATTRIBUTE, GalleryCard } from "./gallery-card.tsx";
import { GalleryDetail } from "./gallery-detail.tsx";
import {
	EMPTY_GALLERY_FILTER,
	GALLERY_GAP,
	GALLERY_GAP_COMPACT,
	type GalleryFilter,
	type GalleryStatusFilter,
	galleryAgentChips,
	galleryColumnCount,
	galleryColumns,
	galleryItem,
	galleryItems,
	galleryNoMatchText,
	galleryRelated,
} from "./gallery-model.ts";
import {
	GalleryEmpty,
	GalleryNoMatch,
	GallerySkeleton,
} from "./gallery-states.tsx";
import { GalleryToolbar } from "./gallery-toolbar.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const MINUTE = 60_000;
/** Width assumed before the first measurement (and where layout is absent). */
const UNMEASURED_WIDTH = 1440;
/** Below this the header and gutters tighten for a phone-sized frame. */
const COMPACT_MAX_WIDTH = 640;
/** Below this the detail column folds away and the conversation takes the page. */
const DETAIL_SPLIT_MIN_WIDTH = 880;
/** The detail column grows a little on wider frames. */
const DETAIL_MID_MIN_WIDTH = 1080;
const DETAIL_WIDE_MIN_WIDTH = 1280;
/** Extra vertical rhythm between cards: the title sits under each cover. */
const ROW_EXTRA = 8;
/** How many cards the "More like this" shelf shows. */
const RELATED_LIMIT = 6;

/** Wall clock that ticks once a minute so relative times stay honest. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's rendered width, kept current with a ResizeObserver. */
function useElementWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setWidth(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const next = entries[0]?.contentRect.width;
			if (next !== undefined) {
				setWidth(next);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width || UNMEASURED_WIDTH;
}

/** True for targets whose keys belong to typing or to the host's chat. */
function ownsKeys(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[data-testid='gallery-thread-view']") !== null
	);
}

/**
 * Gallery: every conversation as a pin on a masonry board, Pinterest style.
 * Each card carries a cover generated from its thread id, the title, and a
 * byline; search and chips (status, then agent) narrow the board, and hover
 * reveals Open and Message. Opening a card shows a pin page: cover, title,
 * owner, facts and "More like this" beside the host's real conversation.
 */
export function GalleryInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["gallery"]>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const boardRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const lastOpenedId = useRef<string | null>(null);
	const width = useElementWidth(rootRef);
	const now = useMinuteClock();
	const reduceMotion = useReducedMotion();
	const [filter, setFilter] = useState<GalleryFilter>(EMPTY_GALLERY_FILTER);

	const agents = useMemo(() => galleryAgentChips(snapshot), [snapshot]);
	// An agent chip whose agent left the snapshot stops filtering.
	const agentId =
		filter.agentId && agents.some((agent) => agent.id === filter.agentId)
			? filter.agentId
			: null;
	const items = useMemo(
		() =>
			galleryItems(snapshot, {
				agentId,
				query: filter.query,
				status: filter.status,
			}),
		[snapshot, agentId, filter.query, filter.status]
	);

	const compact = width < COMPACT_MAX_WIDTH;
	const inset = compact ? 16 : 24;
	const gap = compact ? GALLERY_GAP_COMPACT : GALLERY_GAP;
	const rowGap = gap + ROW_EXTRA;
	const contentWidth = Math.max(0, width - inset * 2);
	const columnCount = galleryColumnCount(contentWidth, gap);
	const columnWidth =
		(contentWidth - gap * (columnCount - 1)) / Math.max(1, columnCount);
	const columns = useMemo(
		() => galleryColumns(items, columnCount, columnWidth, rowGap),
		[items, columnCount, columnWidth, rowGap]
	);

	const open = threadView !== null && threadView !== undefined;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const activeItem = activeThread ? galleryItem(snapshot, activeThread) : null;
	const related = useMemo(
		() =>
			activeThreadId
				? galleryRelated(snapshot, activeThreadId, RELATED_LIMIT)
				: [],
		[snapshot, activeThreadId]
	);
	let detailWidth = 352;
	if (width >= DETAIL_WIDE_MIN_WIDTH) {
		detailWidth = 456;
	} else if (width >= DETAIL_MID_MIN_WIDTH) {
		detailWidth = 400;
	}

	const openThread = useCallback(
		(threadId: string) => {
			lastOpenedId.current = threadId;
			port.openThread(threadId);
		},
		[port]
	);
	const messageAgent = useCallback(
		(id: string) => port.startThread({ agentId: id }),
		[port]
	);
	const startNew = useCallback(() => {
		port.startThread(agentId ? { agentId } : {});
	}, [port, agentId]);
	const clearFilters = useCallback(() => setFilter(EMPTY_GALLERY_FILTER), []);

	// Opening hides the board; move focus to the pin page heading if it was on
	// the board (or nowhere). Closing returns focus to the card it came from.
	const wasOpen = useRef(open);
	useEffect(() => {
		if (open && !wasOpen.current) {
			const focused = document.activeElement;
			if (
				!focused ||
				focused === document.body ||
				boardRef.current?.contains(focused)
			) {
				headingRef.current?.focus({ preventScroll: true });
			}
		}
		if (!open && wasOpen.current && lastOpenedId.current) {
			const card = boardRef.current?.querySelector<HTMLElement>(
				`[${GALLERY_CARD_ATTRIBUTE}="${CSS.escape(lastOpenedId.current)}"]`
			);
			card?.focus({ preventScroll: false });
		}
		wasOpen.current = open;
	}, [open]);

	useEffect(() => {
		if (activeThreadId) {
			lastOpenedId.current = activeThreadId;
		}
	}, [activeThreadId]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (event.defaultPrevented || event.metaKey || event.ctrlKey) {
				return;
			}
			if (event.key === "/" && !open && !ownsKeys(event.target)) {
				event.preventDefault();
				searchRef.current?.focus();
				return;
			}
			if (event.key === "Escape" && open && !ownsKeys(event.target)) {
				event.preventDefault();
				port.closeThread();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, port]);

	const filterAgent = agents.find((agent) => agent.id === agentId);
	let board: ReactNode;
	if (loading) {
		board = <GallerySkeleton columnCount={columnCount} gap={gap} />;
	} else if (snapshot.threads.length === 0) {
		board = <GalleryEmpty agentName={null} onNew={startNew} />;
	} else if (items.length === 0) {
		board = (
			<GalleryNoMatch
				description={galleryNoMatchText(
					{ agentId, query: filter.query, status: filter.status },
					filterAgent?.name
				)}
				onClear={clearFilters}
			/>
		);
	} else {
		board = (
			<div
				aria-label="Conversations"
				className="flex items-start px-[var(--gallery-inset)] pb-10"
				role="list"
				style={{ gap }}
			>
				{columns.map((column, columnIndex) => (
					<div
						className="flex min-w-0 flex-1 flex-col"
						// Columns are positional slots; their content changes, not their identity.
						key={`column-${columnIndex.toString()}`}
						role="none"
						style={{ gap: rowGap }}
					>
						{column.map((item, row) => (
							<GalleryCard
								index={row * columnCount + columnIndex}
								item={item}
								key={item.thread.id}
								now={now}
								onMessage={messageAgent}
								onOpen={openThread}
								reduceMotion={reduceMotion}
							/>
						))}
					</div>
				))}
			</div>
		);
	}

	const style = { "--gallery-inset": `${inset}px` } as CSSProperties;

	return (
		<div
			className="relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-gallery"
			ref={rootRef}
			style={style}
		>
			<div
				aria-hidden={open || undefined}
				className={cn("flex size-full min-h-0 flex-col", open && "invisible")}
				inert={open}
				ref={boardRef}
			>
				<GalleryToolbar
					agents={agents}
					compact={compact}
					filter={{ agentId, query: filter.query, status: filter.status }}
					inputRef={searchRef}
					onAgent={(id) =>
						setFilter((previous) => ({ ...previous, agentId: id }))
					}
					onNew={startNew}
					onQuery={(query) => setFilter((previous) => ({ ...previous, query }))}
					onStatus={(status: GalleryStatusFilter | null) =>
						setFilter((previous) => ({ ...previous, status }))
					}
				/>
				<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
					{board}
				</div>
			</div>
			{open ? (
				<div className="absolute inset-0 bg-background">
					<GalleryDetail
						columnWidth={detailWidth}
						compact={width < DETAIL_SPLIT_MIN_WIDTH}
						headingRef={headingRef}
						item={activeItem}
						now={now}
						onBack={() => port.closeThread()}
						onMessage={messageAgent}
						onOpen={openThread}
						reduceMotion={reduceMotion}
						related={related}
						threadView={threadView}
					/>
				</div>
			) : null}
		</div>
	);
}
