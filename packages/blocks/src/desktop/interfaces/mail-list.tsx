import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { mailPageRange } from "./mail-model.ts";
import { MailIconButton } from "./mail-parts.tsx";
import { type MailDensity, MailRow, type MailRowModel } from "./mail-row.tsx";

/**
 * The shared checkbox draws a tick for every checked state. Gmail's partial
 * selection is a dash, so the mixed state hides the tick and draws one.
 */
const INDETERMINATE_CLASS =
	"data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:before:h-0.5 data-indeterminate:before:w-2 data-indeterminate:before:rounded-full data-indeterminate:before:bg-primary-foreground data-indeterminate:[&_svg]:hidden";

const SKELETON_ROWS = [
	["w-24", "w-72"],
	["w-20", "w-96"],
	["w-28", "w-64"],
	["w-16", "w-80"],
	["w-24", "w-60"],
	["w-20", "w-88"],
] as const;

function ListSkeleton({ density }: { density: MailDensity }) {
	return (
		<div aria-hidden="true" data-testid="mail-skeleton">
			{SKELETON_ROWS.map(([sender, subject]) => (
				<div
					className={cn(
						"flex items-center gap-3 border-border/70 border-b pr-4 pl-4",
						density === "line" ? "h-10" : "h-[76px]"
					)}
					key={`${sender}-${subject}`}
				>
					<Skeleton className="size-4" radius="block" />
					<Skeleton className="size-4" radius="block" />
					<Skeleton className={cn("ml-1 h-3", sender)} radius="pill" />
					<Skeleton
						className={cn("ml-4 h-3 max-w-[50%]", subject)}
						radius="pill"
					/>
					<Skeleton className="ml-auto h-3 w-12" radius="pill" />
				</div>
			))}
		</div>
	);
}

/** Gmail's plain empty list: a sentence near the top, nothing ornamental. */
function ListEmpty({
	action,
	message,
}: {
	action: ReactNode;
	message: string;
}) {
	return (
		<div
			className="flex flex-col items-center gap-3 px-6 pt-16 pb-8 text-center"
			data-testid="mail-empty"
		>
			<p className="max-w-sm text-foreground/80 text-sm">{message}</p>
			{action}
		</div>
	);
}

function ShortcutsFooter() {
	return (
		<p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-6 text-muted-foreground text-xs">
			<span className="inline-flex items-center gap-1.5">
				<Kbd>j</Kbd>
				<Kbd>k</Kbd>
				Move
			</span>
			<span className="inline-flex items-center gap-1.5">
				<Kbd>o</Kbd>
				Open
			</span>
			<span className="inline-flex items-center gap-1.5">
				<Kbd>u</Kbd>
				Back to list
			</span>
			<span className="inline-flex items-center gap-1.5">
				<Kbd>x</Kbd>
				Select
			</span>
			<span className="inline-flex items-center gap-1.5">
				<Kbd>c</Kbd>
				Compose
			</span>
			<span className="inline-flex items-center gap-1.5">
				<Kbd>/</Kbd>
				Search
			</span>
		</p>
	);
}

/**
 * The message list: Gmail's toolbar (select all, refresh, the page range)
 * over the rows of the current folder, label or search.
 */
export function MailList({
	activeThreadId,
	cursorId,
	cursorMarked,
	density,
	emptyAction,
	emptyMessage,
	listLabel,
	loading,
	onFocusRow,
	onKeyDownRow,
	onNextPage,
	onOpen,
	onPreviousPage,
	onRefresh,
	onToggleAll,
	onToggleSelected,
	page,
	pageCount,
	ref,
	registerRow,
	rows,
	selectedIds,
	total,
}: {
	activeThreadId: string | null;
	cursorId: string | null;
	/** Show the keyboard cursor once the user has moved it. */
	cursorMarked: boolean;
	density: MailDensity;
	emptyAction: ReactNode;
	emptyMessage: string;
	listLabel: string;
	loading: boolean;
	onFocusRow: (threadId: string) => void;
	onKeyDownRow: (event: KeyboardEvent<HTMLElement>, threadId: string) => void;
	onNextPage: () => void;
	onOpen: (threadId: string) => void;
	onPreviousPage: () => void;
	onRefresh: () => void;
	onToggleAll: () => void;
	onToggleSelected: (threadId: string) => void;
	page: number;
	pageCount: number;
	ref?: Ref<HTMLDivElement>;
	registerRow: (threadId: string, element: HTMLElement | null) => void;
	rows: MailRowModel[];
	selectedIds: ReadonlySet<string>;
	total: number;
}) {
	const tl = useLiteralMessages();
	const selectedOnPage = rows.filter((row) =>
		selectedIds.has(row.thread.id)
	).length;
	const allSelected = rows.length > 0 && selectedOnPage === rows.length;
	const someSelected = selectedOnPage > 0 && !allSelected;
	let body: ReactNode;
	if (loading && rows.length === 0) {
		body = <ListSkeleton density={density} />;
	} else if (rows.length === 0) {
		body = <ListEmpty action={emptyAction} message={emptyMessage} />;
	} else {
		body = (
			<>
				<ul aria-label={listLabel} className="flex flex-col">
					{rows.map((row) => (
						<MailRow
							cursor={row.thread.id === cursorId}
							cursorMarked={cursorMarked}
							density={density}
							key={row.thread.id}
							onFocusRow={onFocusRow}
							onKeyDownRow={onKeyDownRow}
							onOpen={onOpen}
							onToggleSelected={onToggleSelected}
							open={row.thread.id === activeThreadId}
							registerRow={registerRow}
							row={row}
							selected={selectedIds.has(row.thread.id)}
						/>
					))}
				</ul>
				{density === "line" ? <ShortcutsFooter /> : null}
			</>
		);
	}
	return (
		<div
			className="@container/list flex min-h-0 min-w-0 flex-1 flex-col"
			data-density={density}
			data-testid="mail-list"
			ref={ref}
		>
			<div
				aria-label="List actions"
				className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-1.5"
				role="toolbar"
			>
				<span className="flex size-9 items-center justify-center">
					<Checkbox
						aria-label={allSelected ? "Deselect all" : "Select all"}
						checked={allSelected}
						className={INDETERMINATE_CLASS}
						disabled={rows.length === 0}
						indeterminate={someSelected}
						onCheckedChange={onToggleAll}
					/>
				</span>
				{selectedOnPage > 0 ? (
					<span
						aria-live="polite"
						className="px-2 text-foreground/80 text-sm"
						data-testid="mail-selected-count"
					>
						{tl("{selectedOnPage} selected", { selectedOnPage })}
					</span>
				) : (
					<MailIconButton label="Refresh" onClick={onRefresh}>
						<RotateCw aria-hidden="true" className="size-4" />
					</MailIconButton>
				)}
				<span className="ml-auto flex items-center gap-1">
					<span
						className="px-2 text-muted-foreground text-xs tabular-nums"
						data-testid="mail-page-range"
					>
						{mailPageRange(total, page)}
					</span>
					<MailIconButton
						disabled={page === 0}
						label="Newer"
						onClick={onPreviousPage}
					>
						<ChevronLeft aria-hidden="true" className="size-4.5" />
					</MailIconButton>
					<MailIconButton
						disabled={page >= pageCount - 1}
						label="Older"
						onClick={onNextPage}
					>
						<ChevronRight aria-hidden="true" className="size-4.5" />
					</MailIconButton>
				</span>
			</div>
			<div
				className={cn(
					"min-h-0 flex-1 overflow-y-auto border-border/70 border-t",
					loading && "pointer-events-none"
				)}
			>
				{body}
			</div>
		</div>
	);
}

export function MailEmptyAction({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<Button onClick={onClick} size="sm" variant="outline">
			{label}
		</Button>
	);
}
