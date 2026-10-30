import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { agentById, compactAge } from "./interface-renderer.ts";
import { notebookEditedLabel, notebookPageTitle } from "./notebook-model.ts";
import { NotebookPageGlyph, NotebookStatusMark } from "./notebook-parts.tsx";

/**
 * Gallery slots: a whole number of cards fills the column at every width, so
 * the row ends on a card edge and the fade reads as "more", never a crop.
 */
export const SLOT =
	"shrink-0 snap-start basis-[calc((100%-0.75rem)/2)] @lg/notebook:basis-[calc((100%-1.5rem)/3)] @3xl/notebook:basis-[calc((100%-2.25rem)/4)] @5xl/notebook:basis-[calc((100%-3rem)/5)]";

export const CARD_HEIGHT = "h-36";

const CARD = cn(
	"group/card relative flex w-full flex-col overflow-hidden rounded-lg bg-card text-left outline-none ring-1 ring-border/70 transition-colors duration-100 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/60 active:bg-muted/60 dark:ring-border/50",
	CARD_HEIGHT
);

/** A Notion "Recently visited" card: cover, page icon, title, edited time. */
export function PageCard({
	now,
	onOpen,
	snapshot,
	thread,
}: {
	now: number;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const lead = agentById(snapshot, thread.agentIds[0]);
	const status = threadStatus(thread);
	const title = notebookPageTitle(thread);
	const tl = useLiteralMessages();
	return (
		<li className={SLOT}>
			<button
				aria-label={tl("{title}, {status}, edited {edited}", {
					edited: notebookEditedLabel(thread.updatedAt, now).toLowerCase(),
					status: THREAD_STATUS_LABELS[status],
					title,
				})}
				className={CARD}
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				{/* Notion's card for a page without a cover: a flat neutral cover. */}
				<span aria-hidden="true" className="block h-11 shrink-0 bg-muted" />
				<span className="-mt-4 flex px-4">
					<span className="flex size-8 items-center justify-center rounded-md bg-card">
						<NotebookPageGlyph className="size-5" />
					</span>
				</span>
				<span className="line-clamp-2 px-4 pt-2 font-medium text-sm leading-5">
					{title}
				</span>
				<span className="mt-auto flex items-center gap-1.5 px-4 pb-3 text-muted-foreground text-xs">
					<NotebookStatusMark status={status} />
					<span className="truncate">
						{lead ? `${lead.name} · ` : ""}
						{compactAge(thread.updatedAt, now)}
					</span>
				</span>
			</button>
		</li>
	);
}

export function NewPageCard({ onNewPage }: { onNewPage: () => void }) {
	return (
		<li className={SLOT}>
			<button
				className={cn(
					CARD,
					"items-center justify-center gap-2 bg-transparent text-muted-foreground hover:text-foreground"
				)}
				onClick={onNewPage}
				type="button"
			>
				<Plus aria-hidden="true" className="size-4" />
				<span className="font-medium text-sm">New page</span>
			</button>
		</li>
	);
}

/**
 * Notion's horizontally scrolling card row: edges fade where more cards hide,
 * and arrow buttons page through it on hover.
 */
export function Gallery({
	children,
	labelledBy,
}: {
	children: ReactNode;
	labelledBy: string;
}) {
	const listRef = useRef<HTMLUListElement>(null);
	const [edges, setEdges] = useState({ end: false, start: false });
	const measure = useCallback(() => {
		const list = listRef.current;
		if (!list) {
			return;
		}
		const start = list.scrollLeft > 6;
		const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 6;
		setEdges((previous) =>
			previous.start === start && previous.end === end
				? previous
				: { end, start }
		);
	}, []);
	useEffect(() => {
		const list = listRef.current;
		measure();
		if (!list || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		return () => observer.disconnect();
	}, [measure]);
	const page = (direction: 1 | -1) => {
		const list = listRef.current;
		list?.scrollBy({
			behavior: "smooth",
			left: direction * list.clientWidth * 0.8,
		});
	};
	// Whole cards fill the column and the row ends flush on a card edge; the
	// arrow on that edge, faint until hover, says there is more. The list
	// bleeds 4px only so focus rings are not clipped.
	const arrow =
		"absolute top-1/2 z-10 flex size-7 -translate-y-1/2 items-center justify-center rounded-md bg-background text-foreground opacity-70 shadow-xs ring-1 ring-border outline-none transition-opacity duration-100 hover:bg-muted hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 group-hover/gallery:opacity-100";
	return (
		<div className="group/gallery relative">
			<ul
				aria-labelledby={labelledBy}
				className="-m-1 flex snap-x scroll-px-1 gap-3 overflow-x-auto p-1 [scrollbar-width:none]"
				onScroll={measure}
				ref={listRef}
			>
				{children}
			</ul>
			{edges.start ? (
				<button
					aria-label="Scroll recent pages back"
					className={cn(arrow, "-left-2")}
					onClick={() => page(-1)}
					type="button"
				>
					<ChevronLeft aria-hidden="true" className="size-4" />
				</button>
			) : null}
			{edges.end ? (
				<button
					aria-label="Scroll recent pages forward"
					className={cn(arrow, "-right-2")}
					onClick={() => page(1)}
					type="button"
				>
					<ChevronRight aria-hidden="true" className="size-4" />
				</button>
			) : null}
		</div>
	);
}
