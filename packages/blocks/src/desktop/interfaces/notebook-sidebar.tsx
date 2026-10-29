import { useLiteralMessages } from "@ryu/i18n/react";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import {
	ChevronsLeft,
	House,
	NotebookText,
	Plus,
	Search,
	SquarePen,
	X,
} from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import type { NotebookGroup, NotebookSection } from "./notebook-model.ts";
import { NOTEBOOK_SIDEBAR_FAINT } from "./notebook-parts.tsx";
import { NotebookTree } from "./notebook-tree.tsx";

/** A compact square icon button for the sidebar and the page top bar. */
export function NotebookIconButton({
	children,
	className,
	label,
	onClick,
	pressed,
	shortcut,
}: {
	children: ReactNode;
	className?: string;
	label: string;
	onClick: () => void;
	pressed?: boolean;
	shortcut?: string;
}) {
	return (
		<button
			aria-keyshortcuts={shortcut}
			aria-label={label}
			aria-pressed={pressed}
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-100 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-foreground/10 aria-pressed:bg-foreground/[0.06] aria-pressed:text-foreground [&_svg]:size-4",
				className
			)}
			onClick={onClick}
			title={label}
			type="button"
		>
			{children}
		</button>
	);
}

function NavRow({
	active,
	badge,
	icon,
	label,
	onClick,
}: {
	active?: boolean;
	badge?: number;
	icon: ReactNode;
	label: string;
	onClick: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<button
			aria-current={active ? "page" : undefined}
			aria-label={
				badge ? tl("{label}, {badge} need you", { badge, label }) : undefined
			}
			className={cn(
				"flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left font-medium text-sm outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/50",
				active
					? "bg-sidebar-accent text-sidebar-accent-foreground"
					: "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground"
			)}
			onClick={onClick}
			type="button"
		>
			<span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
				{icon}
			</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{badge ? (
				<span
					aria-hidden="true"
					className={cn("px-1 text-xs tabular-nums", NOTEBOOK_SIDEBAR_FAINT)}
				>
					{badge}
				</span>
			) : null}
		</button>
	);
}

export interface NotebookSidebarProps {
	activeThreadId: string | null;
	expanded: ReadonlySet<string>;
	focusRequest: { id: string; token: number } | null;
	homeActive: boolean;
	loading: boolean;
	needsYouCount: number;
	onClose: () => void;
	onHome: () => void;
	onNewPage: () => void;
	onOpen: (threadId: string) => void;
	onQueryChange: (query: string) => void;
	onSetExpanded: (id: string, open: boolean) => void;
	onStart: (group: NotebookGroup) => void;
	/** Overlay mode (narrow widths) shows a close "x" instead of the fold. */
	overlay: boolean;
	query: string;
	sections: readonly NotebookSection[];
	snapshot: InterfaceSnapshot;
}

/** The search shortcut as this platform writes it. */
function searchShortcutLabel(): string {
	const platform =
		typeof navigator === "undefined" ? "" : (navigator.platform ?? "");
	return /mac|iphone|ipad/i.test(platform) ? "\u21e7\u2318F" : "Ctrl Shift F";
}

const SKELETON_WIDTHS = [
	"w-24",
	"w-36",
	"w-28",
	"w-32",
	"w-20",
	"w-36",
	"w-28",
];

/** Notion's sidebar: workspace, search, Home, the page tree, New page. */
export function NotebookSidebar({
	activeThreadId,
	expanded,
	focusRequest,
	homeActive,
	loading,
	needsYouCount,
	onClose,
	onHome,
	onNewPage,
	onOpen,
	onQueryChange,
	onSetExpanded,
	onStart,
	overlay,
	query,
	sections,
	snapshot,
}: NotebookSidebarProps) {
	const tl = useLiteralMessages();
	const searchId = useId();
	const searchRef = useRef<HTMLInputElement>(null);
	const empty =
		!loading && snapshot.threads.length === 0 && snapshot.agents.length === 0;
	let tree: ReactNode;
	if (loading) {
		tree = (
			<div aria-hidden="true" className="flex flex-col gap-2.5 px-2 pt-2">
				{SKELETON_WIDTHS.map((width, index) => (
					<Skeleton
						className={cn("h-3.5", width, index === 0 && "h-3 w-16")}
						// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows.
						key={index}
						radius="dense"
					/>
				))}
			</div>
		);
	} else if (sections.length === 0) {
		tree = (
			<p className="px-2 py-1.5 text-muted-foreground text-sm">
				{query.trim()
					? tl("No pages match “{query}”", { query: query.trim() })
					: "No pages yet. Start one and an agent picks it up."}
			</p>
		);
	} else {
		tree = (
			<NotebookTree
				activeThreadId={activeThreadId}
				expanded={expanded}
				focusRequest={focusRequest}
				onOpen={onOpen}
				onSetExpanded={onSetExpanded}
				onStart={onStart}
				sections={sections}
				snapshot={snapshot}
			/>
		);
	}

	return (
		<nav
			aria-label="Notebook"
			className="flex size-full flex-col bg-sidebar text-sidebar-foreground"
		>
			<div className="group/head flex h-12 shrink-0 items-center gap-1 px-2">
				<div className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
					<span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
						<NotebookText
							aria-hidden="true"
							className="size-3.5"
							strokeWidth={2}
						/>
					</span>
					<span className="truncate font-semibold text-sm">Notebook</span>
				</div>
				<NotebookIconButton
					className={cn(
						!overlay &&
							"opacity-0 focus-visible:opacity-100 group-hover/head:opacity-100"
					)}
					label={overlay ? "Close sidebar" : "Collapse sidebar"}
					onClick={onClose}
					shortcut={overlay ? "Escape" : "Control+\\"}
				>
					{overlay ? <X /> : <ChevronsLeft />}
				</NotebookIconButton>
				<NotebookIconButton label="New page" onClick={onNewPage}>
					<SquarePen />
				</NotebookIconButton>
			</div>

			<div className="flex shrink-0 flex-col gap-px px-2 pb-2">
				<label
					className="group/search flex h-7 cursor-text items-center gap-1.5 rounded-md px-1.5 text-sm transition-colors duration-100 focus-within:bg-background focus-within:ring-1 focus-within:ring-border hover:bg-sidebar-accent/70 focus-within:hover:bg-background"
					htmlFor={searchId}
				>
					<span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
						<Search aria-hidden="true" className="size-4" />
					</span>
					<span className="sr-only">Search pages</span>
					<input
						aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
						autoComplete="off"
						className="min-w-0 flex-1 bg-transparent text-sidebar-foreground outline-none placeholder:text-sidebar-foreground/70 [&::-webkit-search-cancel-button]:appearance-none"
						id={searchId}
						onChange={(event) => onQueryChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && query) {
								event.preventDefault();
								event.stopPropagation();
								onQueryChange("");
							}
						}}
						placeholder="Search"
						ref={searchRef}
						spellCheck={false}
						type="search"
						value={query}
					/>
					{query ? (
						<button
							aria-label="Clear search"
							className="flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
							onClick={() => {
								onQueryChange("");
								searchRef.current?.focus();
							}}
							type="button"
						>
							<X aria-hidden="true" className="size-3.5" />
						</button>
					) : (
						<Kbd
							aria-hidden="true"
							className="h-5 min-w-0 rounded-sm bg-transparent px-1 opacity-0 transition-opacity duration-100 group-focus-within/search:opacity-0 group-hover/search:opacity-100"
						>
							{searchShortcutLabel()}
						</Kbd>
					)}
				</label>
				<NavRow
					active={homeActive}
					badge={needsYouCount}
					icon={<House />}
					label="Home"
					onClick={onHome}
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 [scrollbar-width:thin]">
				{tree}
			</div>

			<div className="shrink-0 border-sidebar-border border-t px-2 py-2">
				<NavRow
					icon={<Plus />}
					label={empty ? "Start your first page" : "New page"}
					onClick={onNewPage}
				/>
			</div>
		</nav>
	);
}
