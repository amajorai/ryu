import { cn } from "@ryu/ui/lib/utils";
import {
	BookOpen,
	CircleCheck,
	FolderClosed,
	House,
	Inbox,
	Library,
	type LucideIcon,
	Users,
} from "lucide-react";
import {
	LIBRARY_VIEW_LABELS,
	type LibraryBook,
	type LibraryBookKind,
	type LibraryView,
} from "./library-model.ts";

const VIEW_ICONS: Record<LibraryView, LucideIcon> = {
	all: Library,
	continue: BookOpen,
	finished: CircleCheck,
	home: House,
};

const COLLECTION_ICONS: Record<LibraryBookKind, LucideIcon> = {
	agent: BookOpen,
	project: FolderClosed,
	team: Users,
	unassigned: Inbox,
};

const LIBRARY_VIEWS: readonly LibraryView[] = ["all", "continue", "finished"];

function NavItem({
	active,
	count,
	icon: Icon,
	label,
	onSelect,
}: {
	active: boolean;
	count?: number;
	icon: LucideIcon;
	label: string;
	onSelect: () => void;
}) {
	return (
		<li>
			<button
				aria-current={active ? "page" : undefined}
				className={cn(
					"flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-sidebar-ring motion-reduce:transition-none",
					active
						? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
						: "text-sidebar-foreground hover:bg-sidebar-accent/60"
				)}
				onClick={onSelect}
				type="button"
			>
				<Icon
					aria-hidden="true"
					className={cn(
						"size-4 shrink-0",
						active ? "text-primary" : "text-muted-foreground"
					)}
					strokeWidth={1.75}
				/>
				<span className="min-w-0 flex-1 truncate">{label}</span>
				{count === undefined ? null : (
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						{count}
					</span>
				)}
			</button>
		</li>
	);
}

function GroupLabel({ children }: { children: string }) {
	return (
		<h2 className="px-2 pb-1 font-medium text-muted-foreground text-xs">
			{children}
		</h2>
	);
}

/**
 * The Books sidebar: Home, the library's smart views with their counts, and
 * one row per collection (projects, teams, and Unassigned).
 */
export function LibrarySidebar({
	collections,
	counts,
	onCollection,
	onView,
	selectedBookId,
	view,
}: {
	collections: LibraryBook[];
	counts: Record<LibraryView, number>;
	onCollection: (bookId: string) => void;
	onView: (view: LibraryView) => void;
	selectedBookId: string | null;
	view: LibraryView | null;
}) {
	return (
		<nav
			aria-label="Library"
			className="@3xl/library:flex hidden w-56 shrink-0 flex-col gap-5 overflow-y-auto border-border border-r bg-sidebar px-3 pt-4 pb-6"
		>
			<ul>
				<NavItem
					active={view === "home"}
					icon={VIEW_ICONS.home}
					label={LIBRARY_VIEW_LABELS.home}
					onSelect={() => onView("home")}
				/>
			</ul>
			<div>
				<GroupLabel>Library</GroupLabel>
				<ul className="flex flex-col gap-px">
					{LIBRARY_VIEWS.map((item) => (
						<NavItem
							active={view === item}
							count={counts[item]}
							icon={VIEW_ICONS[item]}
							key={item}
							label={LIBRARY_VIEW_LABELS[item]}
							onSelect={() => onView(item)}
						/>
					))}
				</ul>
			</div>
			{collections.length > 0 ? (
				<div>
					<GroupLabel>Collections</GroupLabel>
					<ul className="flex flex-col gap-px">
						{collections.map((book) => (
							<NavItem
								active={selectedBookId === book.id}
								count={book.chapters.length}
								icon={COLLECTION_ICONS[book.kind]}
								key={book.id}
								label={book.title}
								onSelect={() => onCollection(book.id)}
							/>
						))}
					</ul>
				</div>
			) : null}
		</nav>
	);
}

/** Below the sidebar breakpoint the views become a row of tabs. */
export function LibraryTabs({
	onView,
	view,
}: {
	onView: (view: LibraryView) => void;
	view: LibraryView | null;
}) {
	const views: readonly LibraryView[] = ["home", ...LIBRARY_VIEWS];
	return (
		<nav
			aria-label="Library sections"
			className="flex @3xl/library:hidden shrink-0 gap-1 overflow-x-auto border-border border-b px-4 py-2 [scrollbar-width:none]"
		>
			{views.map((item) => (
				<button
					aria-current={view === item ? "page" : undefined}
					className={cn(
						"h-8 shrink-0 rounded-md px-3 font-medium text-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
						view === item
							? "bg-muted text-foreground"
							: "text-muted-foreground hover:text-foreground"
					)}
					key={item}
					onClick={() => onView(item)}
					type="button"
				>
					{LIBRARY_VIEW_LABELS[item]}
				</button>
			))}
		</nav>
	);
}
