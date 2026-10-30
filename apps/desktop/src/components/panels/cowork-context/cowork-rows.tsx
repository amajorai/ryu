import {
	ArrowDown01Icon,
	ArrowUpRight01Icon,
	CheckmarkCircle02Icon,
	File01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { FileTypeIcon } from "@ryu/blocks/desktop/agent-elements/file-type-icon.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ReactNode, useId, useState } from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import type { FileSummary } from "@/src/lib/api/git.ts";
import { MAX_SOURCE_ITEMS } from "./cowork-source-tools.ts";
import type {
	CoworkPlanTodo,
	DerivedSource,
	SourceItem,
} from "./cowork-types.ts";

// ── Section helpers (see context-sections.tsx) ──

export function SectionIcon({ icon }: { icon: IconSvgElement }) {
	return <HugeiconsIcon aria-hidden className="size-4" icon={icon} />;
}

export function SectionActionButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<Button
			aria-label={label}
			onClick={(event) => {
				event.stopPropagation();
				onClick();
			}}
			size="icon-sm"
			title={label}
			variant="ghost-muted"
		>
			<HugeiconsIcon aria-hidden className="size-4" icon={ArrowUpRight01Icon} />
		</Button>
	);
}

// ── One row geometry for every subsection list ────────────────────────────────
//
// Sources, source items, Subagents, Rendered artifacts and Side chats were five
// hand-rolled copies of the same row, and they disagreed: a bare 14px glyph in
// one, a 24px avatar in another, so their labels started 10px apart. Rows now
// sit at the interface default (`text-sm`) under a `text-sm font-semibold`
// section title, with secondary detail at `text-xs`.
//
// PANEL_ROW_ICON is a fixed box, so a glyph row and an avatar row indent
// identically — that box, not the glyph inside it, is what sets the indent.
// PANEL_ROW_BADGE is the section title's own count, reused here so the trailing
// slot has ONE treatment: plain tertiary text, never a pill for a normal count.
export const PANEL_ROW =
	"flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors duration-150 hover:bg-muted hover:duration-0";
const PANEL_ROW_STATIC =
	"flex min-h-8 w-full min-w-0 items-center gap-2 px-2 py-1 text-sm";
export const PANEL_ROW_ICON =
	"grid size-5 shrink-0 place-items-center text-muted-foreground";
export const PANEL_ROW_BADGE =
	"shrink-0 text-muted-foreground/70 text-xs tabular-nums";

export function SectionTitle({
	count,
	title,
}: {
	count?: number;
	title: string;
}) {
	return (
		<span className="flex items-center gap-2">
			<span className="font-semibold text-foreground text-sm">{title}</span>
			{count !== undefined && count > 0 && (
				<span className={PANEL_ROW_BADGE} data-slot="cowork-section-count">
					{count}
				</span>
			)}
		</span>
	);
}

function EmptyHint({ children }: { children: ReactNode }) {
	return <p className="py-1 text-muted-foreground text-xs">{children}</p>;
}

export function OverflowRow({
	count,
	label,
	onShowAll,
}: {
	count: number;
	label: string;
	onShowAll?: () => void;
}) {
	const copy = `+${count} more ${label}`;
	if (!onShowAll) {
		return <li className="px-2 py-1 text-muted-foreground text-xs">{copy}</li>;
	}
	return (
		<li>
			<button
				className={cn(PANEL_ROW, "text-muted-foreground")}
				onClick={onShowAll}
				type="button"
			>
				<span>{copy}</span>
				<span className="ml-auto text-xs">View all</span>
			</button>
		</li>
	);
}

// ── Progress checklist ─────────────────────────────────────────────────────────

function TodoStatusDot({ status }: { status: CoworkPlanTodo["status"] }) {
	if (status === "completed") {
		return (
			<HugeiconsIcon
				aria-hidden
				className="size-4 shrink-0 text-primary"
				icon={CheckmarkCircle02Icon}
			/>
		);
	}
	if (status === "in_progress") {
		return (
			<span className="mt-px flex size-3.5 shrink-0 items-center justify-center rounded-full border-2 border-primary" />
		);
	}
	return (
		<span className="mt-px size-3.5 shrink-0 rounded-full border border-muted-foreground" />
	);
}

export function ProgressSection({
	todos,
	limit,
}: {
	/** Accepted for callers; the in-progress dot is static, so it is unused. */
	chatStatus?: string;
	limit?: number;
	todos: CoworkPlanTodo[];
}) {
	if (todos.length === 0) {
		return <EmptyHint>Steps will show as the task unfolds.</EmptyHint>;
	}
	const shown = limit === undefined ? todos : todos.slice(0, limit);
	const overflow = todos.length - shown.length;
	return (
		<ul className="flex flex-col gap-2">
			{shown.map((todo, idx) => (
				<li
					className="flex items-start gap-2"
					key={`${idx}-${todo.content.slice(0, 24)}`}
				>
					<TodoStatusDot status={todo.status} />
					<span
						className={cn(
							"text-sm leading-snug",
							todo.status === "completed"
								? "text-muted-foreground line-through"
								: todo.status === "in_progress"
									? "text-foreground"
									: "text-muted-foreground"
						)}
					>
						{todo.content}
					</span>
				</li>
			))}
			{overflow > 0 && <OverflowRow count={overflow} label="steps" />}
		</ul>
	);
}

// ── File row (artifacts) ───────────────────────────────────────────────────────

export function FileRow({ file }: { file: FileSummary }) {
	const filename = file.path.split(/[\\/]/).at(-1) ?? file.path;
	return (
		<div className="flex items-center gap-2 py-1 text-sm" title={file.path}>
			<HugeiconsIcon
				aria-hidden
				className="size-3.5 shrink-0 text-muted-foreground"
				icon={File01Icon}
			/>
			<span
				className="min-w-0 flex-1 truncate text-foreground"
				title={filename}
			>
				{filename}
			</span>
		</div>
	);
}

// ── Sources (connectors + what each one touched) ───────────────────────────────

// Each connector row expands in place to the files it read/wrote, the links it
// fetched or found, and the commands it ran. A nested BouncyAccordion would put
// a second card (28px radii, `bg-card` on `bg-card`) inside the section, so this
// is the plain disclosure the rest of the rail uses — same row idiom as
// SubagentsList. The outer accordion measures its content with a ResizeObserver,
// so expanding a group grows the section; that also means the item list must not
// live in a fixed-height scroller (a pinned `offsetHeight` never grows), hence
// the `+N more` cap by count.

export function SourceItemRow({ item }: { item: SourceItem }) {
	const icon = item.filePath ? (
		<FileTypeIcon className="size-3.5" path={item.filePath} />
	) : (
		<HugeiconsIcon className="size-3.5" icon={item.icon} />
	);
	const body = (
		<>
			<span
				aria-hidden
				className={PANEL_ROW_ICON}
				data-file-path={item.filePath}
			>
				{icon}
			</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-foreground" title={item.label}>
					{item.label}
				</span>
				{item.detail && item.detail !== item.label && (
					<span
						className="truncate text-muted-foreground text-xs"
						title={item.detail}
					>
						{item.detail}
					</span>
				)}
			</span>
		</>
	);
	if (!item.url) {
		return (
			<li className={PANEL_ROW_STATIC} title={item.detail ?? item.label}>
				{body}
			</li>
		);
	}
	const url = item.url;
	return (
		<li>
			<button
				className={PANEL_ROW}
				onClick={() => {
					Promise.resolve(openExternal(url)).catch(() => {
						/* the link stays visible; nothing else to do */
					});
				}}
				title={url}
				type="button"
			>
				{body}
			</button>
		</li>
	);
}

function SourceGroup({
	source,
	itemLimit,
	onShowAll,
}: {
	itemLimit?: number;
	onShowAll?: () => void;
	source: DerivedSource;
}) {
	const [open, setOpen] = useState(false);
	const contentId = useId();
	const shown = source.items.slice(0, itemLimit ?? MAX_SOURCE_ITEMS);
	const overflow = source.items.length - shown.length;

	if (source.items.length === 0) {
		return (
			<li className={PANEL_ROW_STATIC}>
				<span aria-hidden className={PANEL_ROW_ICON}>
					<HugeiconsIcon className="size-3.5" icon={source.icon} />
				</span>
				<span
					className="min-w-0 flex-1 truncate text-foreground"
					title={source.label}
				>
					{source.label}
				</span>
			</li>
		);
	}

	return (
		<li>
			<button
				aria-controls={contentId}
				aria-expanded={open}
				className={PANEL_ROW}
				onClick={() => setOpen((prev) => !prev)}
				type="button"
			>
				<span aria-hidden className={PANEL_ROW_ICON}>
					<HugeiconsIcon className="size-3.5" icon={source.icon} />
				</span>
				<span
					className="min-w-0 flex-1 truncate text-foreground"
					title={source.label}
				>
					{source.label}
				</span>
				<span className={PANEL_ROW_BADGE}>{source.items.length}</span>
				{/* Boxed like the parent row's chevron, so both end on one optical
				    column instead of the subsection's sitting 6px further in. */}
				<span aria-hidden className={PANEL_ROW_ICON}>
					<HugeiconsIcon
						className={cn(
							"size-3.5 transition-transform duration-200",
							open && "rotate-180"
						)}
						icon={ArrowDown01Icon}
					/>
				</span>
			</button>
			{open && (
				<ul
					className="mt-0.5 mb-1 ml-4 flex flex-col gap-0.5 border-border border-l pl-2"
					id={contentId}
				>
					{shown.map((item) => (
						<SourceItemRow item={item} key={item.id} />
					))}
					{overflow > 0 && (
						<OverflowRow count={overflow} label="items" onShowAll={onShowAll} />
					)}
				</ul>
			)}
		</li>
	);
}

export function SourcesList({
	sources,
	limit,
	onShowAll,
}: {
	limit?: number;
	onShowAll?: () => void;
	sources: DerivedSource[];
}) {
	// Keep every source group in the compact summary. The limit applies to the
	// concrete items inside each group; truncating groups here could hide the
	// only visible evidence that a run used an MCP, app, or integration.
	return (
		<ul className="flex flex-col gap-0.5">
			{sources.map((source) => (
				<SourceGroup
					itemLimit={limit}
					key={source.id}
					onShowAll={onShowAll}
					source={source}
				/>
			))}
		</ul>
	);
}
