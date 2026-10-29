import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	useI18n,
	useLiteralMessages,
	useLocalizedString,
} from "@ryu/i18n/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { SIDEBAR_OVERFLOW_POPOVER_KEY } from "./appearance-context-menu.tsx";
import { SIDEBAR_CHAT_SCOPE_ATTRIBUTES } from "./sidebar-chat-selection.tsx";

// How many rows the overflow popover reveals per infinite-scroll step.
const OVERFLOW_WINDOW_STEP = 30;

/** Describes a section's full list so the overflow popover can render + search
 *  it with the section's own rows (preserving context menus, side-chats, etc.). */
interface SectionOverflow<T> {
	/** Text a row is matched against when filtering. */
	getSearchText: (item: T) => string;
	/** Full sorted list (usually `paged.items`). */
	items: T[];
	/** Human label for the search placeholder, e.g. "agents". */
	label: string;
	/** Renders the given slice using the section's real rows. */
	renderList: (items: T[]) => ReactNode;
}

/** The "Show N more" trigger that opens a searchable, infinite-scrolled popover
 *  of the section's full list to the right of the sidebar. Exported so the e2e
 *  harness can mount it in isolation. */
export function SectionOverflowPopover<T>({
	remaining,
	overflow,
}: {
	remaining: number;
	overflow: SectionOverflow<T>;
}) {
	const { t } = useI18n();
	const tl = useLiteralMessages();
	const sectionLabel = useLocalizedString(overflow.label) ?? overflow.label;
	const searchLabel = t("sidebar.search-section", { section: sectionLabel });
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [windowCount, setWindowCount] = useState(OVERFLOW_WINDOW_STEP);
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) {
			return overflow.items;
		}
		return overflow.items.filter((item) =>
			overflow.getSearchText(item).toLowerCase().includes(q)
		);
	}, [overflow, query]);

	const windowed = filtered.slice(0, windowCount);
	const hasMore = filtered.length > windowCount;

	// Grow the window as the sentinel scrolls into view (in-memory windowing —
	// the data is already client-side, so no fetch paging is needed).
	useEffect(() => {
		if (!(open && hasMore)) {
			return;
		}
		const sentinel = sentinelRef.current;
		const root = scrollRef.current;
		if (!sentinel) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					setWindowCount((c) => c + OVERFLOW_WINDOW_STEP);
				}
			},
			{ root, rootMargin: "120px" }
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [open, hasMore]);

	const onOpenChange = (next: boolean) => {
		setOpen(next);
		if (next) {
			// Fresh view each open: clear the filter and collapse the window.
			setQuery("");
			setWindowCount(OVERFLOW_WINDOW_STEP);
		}
	};

	return (
		<Popover onOpenChange={onOpenChange} open={open}>
			<div className="mt-0.5 flex items-center gap-1 pl-6">
				<PopoverTrigger size="compact" variant="muted">
					{tl("Show {remaining} more", { remaining: String(remaining) })}
				</PopoverTrigger>
			</div>
			<PopoverContent
				align="start"
				className="flex w-64 flex-col"
				corners="rounded"
				side="right"
				sideOffset={8}
				spacing="compact"
			>
				<div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/50 px-2 focus-within:border-ring">
					<HugeiconsIcon
						className="shrink-0 text-muted-foreground"
						icon={Search01Icon}
						size={14}
					/>
					{/* search field is the popover's primary action */}
					<input
						aria-label={searchLabel}
						autoFocus
						className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
						onChange={(e) => {
							setQuery(e.target.value);
							setWindowCount(OVERFLOW_WINDOW_STEP);
						}}
						placeholder={searchLabel}
						type="text"
						value={query}
					/>
				</div>
				{/* Content dissolves under the search field above rather than
				    meeting it at a hard line. Top-only: the list ends on the
				    popover edge, so a bottom fade would just dim the last row. */}
				<div
					// Portalled after the sidebar: a shift-click range stays in this list.
					{...SIDEBAR_CHAT_SCOPE_ATTRIBUTES}
					className="ryu-scroll-edge-top max-h-80 overflow-y-auto overscroll-contain"
					ref={scrollRef}
				>
					{windowed.length === 0 ? (
						<p className="px-2 py-2 text-muted-foreground text-xs">
							No matches
						</p>
					) : (
						<>
							{overflow.renderList(windowed)}
							{hasMore ? <div aria-hidden="true" ref={sentinelRef} /> : null}
						</>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

export function SectionPagingControls<T>({
	paged,
	overflow,
}: {
	paged: {
		canShowLess: boolean;
		hasMore: boolean;
		lessCount: number;
		remaining: number;
		showLess: () => void;
		showMore: () => void;
	};
	/** When provided and the popover overflow mode is on, "Show N more" opens a
	 *  searchable popover instead of revealing the next page inline. */
	overflow?: SectionOverflow<T>;
}) {
	const [popoverMode] = usePersistedToggle(SIDEBAR_OVERFLOW_POPOVER_KEY, false);
	if (!(paged.hasMore || paged.canShowLess)) {
		return null;
	}
	if (popoverMode && overflow && paged.hasMore) {
		return (
			<SectionOverflowPopover overflow={overflow} remaining={paged.remaining} />
		);
	}
	return (
		<div className="mt-0.5 flex items-center gap-1 pl-6">
			{paged.hasMore ? (
				<ShowMoreButton onClick={paged.showMore} remaining={paged.remaining} />
			) : null}
			{paged.canShowLess ? (
				<ShowLessButton count={paged.lessCount} onClick={paged.showLess} />
			) : null}
		</div>
	);
}

/** A row that reveals the next page of items in a paginated section. */
function ShowMoreButton({
	onClick,
	remaining,
}: {
	onClick: () => void;
	remaining: number;
}) {
	const tl = useLiteralMessages();
	return (
		<button
			className="rounded px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
			onClick={onClick}
			type="button"
		>
			{tl("Show {remaining} more", { remaining: String(remaining) })}
		</button>
	);
}

/** A row that hides the last revealed page in a paginated section. */
function ShowLessButton({
	count,
	onClick,
}: {
	count: number;
	onClick: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<button
			className="rounded px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
			onClick={onClick}
			type="button"
		>
			{tl("Show {count} less", { count: String(count) })}
		</button>
	);
}
