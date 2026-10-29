import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown, MessagesSquare, Plus, Search, X } from "lucide-react";
import { Fragment, type RefObject, useId } from "react";
import {
	CATEGORY_SECTION_LABELS,
	categorySections,
	FORUM_SORT_LABELS,
	FORUM_SORTS,
	type ForumCategory,
	type ForumSort,
} from "./forum-model.ts";
import { CategorySwatch, ICON_BUTTON } from "./forum-parts.tsx";

/** The centered column every forum page shares (Discourse's wrap). */
export const FORUM_WRAP =
	"mx-auto w-full max-w-[1110px] px-4 @min-[720px]:px-6";

export interface ForumHeaderProps {
	onHome: () => void;
	onNewTopic: () => void;
	onSearch: (value: string) => void;
	search: string;
	searchRef: RefObject<HTMLInputElement | null>;
}

/** Site title, search, and New topic: the bar every Discourse page wears. */
export function ForumHeader({
	onHome,
	onNewTopic,
	onSearch,
	search,
	searchRef,
}: ForumHeaderProps) {
	const searchId = useId();
	return (
		<header className="shrink-0 border-border border-b bg-background">
			<div className={cn(FORUM_WRAP, "flex h-14 items-center gap-3")}>
				<button
					className="-ml-1.5 flex h-9 min-w-0 shrink-0 items-center gap-2 rounded-md px-1.5 outline-none transition-colors duration-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
					onClick={onHome}
					type="button"
				>
					<span className="flex size-7 items-center justify-center rounded-md bg-foreground text-background">
						<MessagesSquare
							aria-hidden="true"
							className="size-4"
							strokeWidth={2}
						/>
					</span>
					<span className="@min-[480px]:inline hidden font-semibold text-[15px] text-foreground tracking-tight">
						Workspace
					</span>
					<span className="sr-only @min-[480px]:hidden">Workspace</span>
				</button>
				<span className="flex-1" />
				<div className="relative w-full min-w-0 max-w-72" role="search">
					<label className="sr-only" htmlFor={searchId}>
						Search topics
					</label>
					<Search
						aria-hidden="true"
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						strokeWidth={2}
					/>
					<input
						autoComplete="off"
						className="h-9 w-full appearance-none rounded-full border border-transparent bg-input/50 pr-10 pl-9 text-foreground text-sm outline-none transition-[color,box-shadow,background-color] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
						id={searchId}
						onChange={(event) => onSearch(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								if (search) {
									onSearch("");
								} else {
									event.currentTarget.blur();
								}
							}
						}}
						placeholder="Search"
						ref={searchRef}
						type="search"
						value={search}
					/>
					{search ? (
						<button
							aria-label="Clear search"
							className={cn(
								ICON_BUTTON,
								"absolute top-1/2 right-1 size-7 -translate-y-1/2 rounded-full"
							)}
							onClick={() => onSearch("")}
							type="button"
						>
							<X aria-hidden="true" className="size-3.5" strokeWidth={2} />
						</button>
					) : (
						<Kbd className="pointer-events-none absolute top-1/2 right-2 @min-[720px]:inline-flex hidden -translate-y-1/2">
							/
						</Kbd>
					)}
				</div>
				<Button
					aria-label="New topic"
					className="shrink-0"
					onClick={onNewTopic}
					size="sm"
				>
					<Plus aria-hidden="true" data-icon="inline-start" />
					<span className="@min-[560px]:inline hidden">New topic</span>
				</Button>
			</div>
		</header>
	);
}

export type ForumListView = ForumSort | "categories";

const ALL_CATEGORIES = "all";

function CategoryChooser({
	categories,
	categoryId,
	onSelect,
}: {
	categories: readonly ForumCategory[];
	categoryId: string | null;
	onSelect: (categoryId: string | null) => void;
}) {
	const tl = useLiteralMessages();
	const current = categories.find((category) => category.id === categoryId);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={tl("Category: {name}", {
					name: current?.name ?? tl("All categories"),
				})}
				render={
					<button
						className="inline-flex h-8 max-w-56 shrink-0 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-foreground text-sm outline-none transition-colors duration-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-muted"
						type="button"
					/>
				}
			>
				{current ? <CategorySwatch category={current} /> : null}
				<span className="truncate">{current?.name ?? "All categories"}</span>
				<ChevronDown
					aria-hidden="true"
					className="size-3.5 shrink-0 text-muted-foreground"
					strokeWidth={2}
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-60" drawerLabel="Category">
				<DropdownMenuRadioGroup
					onValueChange={(value: string) =>
						onSelect(value === ALL_CATEGORIES ? null : value)
					}
					value={current?.id ?? ALL_CATEGORIES}
				>
					<DropdownMenuRadioItem value={ALL_CATEGORIES}>
						All categories
					</DropdownMenuRadioItem>
					{categorySections(categories).map((section) => (
						<Fragment key={section.kind}>
							<DropdownMenuSeparator />
							<DropdownMenuGroup>
								<DropdownMenuLabel>
									{CATEGORY_SECTION_LABELS[section.kind]}
								</DropdownMenuLabel>
								{section.categories.map((category) => (
									<DropdownMenuRadioItem key={category.id} value={category.id}>
										<CategorySwatch category={category} />
										<span className="truncate">{category.name}</span>
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuGroup>
						</Fragment>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const PILL =
	"inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 font-medium text-sm outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/50";

export interface ForumNavProps {
	categories: readonly ForumCategory[];
	categoryId: string | null;
	onCategory: (categoryId: string | null) => void;
	onView: (view: ForumListView) => void;
	unread: number;
	view: ForumListView;
}

/**
 * Discourse's navigation bar: the category chooser, then the list pills.
 * The Categories pill only shows at the top level, as on Discourse.
 */
export function ForumNav({
	categories,
	categoryId,
	onCategory,
	onView,
	unread,
	view,
}: ForumNavProps) {
	const views: ForumListView[] =
		categoryId === null ? [...FORUM_SORTS, "categories"] : [...FORUM_SORTS];
	return (
		<div className="flex min-w-0 items-center gap-3">
			<CategoryChooser
				categories={categories}
				categoryId={categoryId}
				onSelect={onCategory}
			/>
			<nav
				aria-label="Topic lists"
				className="-my-1 flex min-w-0 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none]"
			>
				{views.map((item) => {
					const active = item === view;
					return (
						<button
							aria-current={active ? "page" : undefined}
							className={cn(
								PILL,
								active
									? "bg-primary text-primary-foreground"
									: "text-foreground hover:bg-muted"
							)}
							key={item}
							onClick={() => onView(item)}
							type="button"
						>
							{item === "categories" ? "Categories" : FORUM_SORT_LABELS[item]}
							{item === "unread" && unread > 0 ? (
								<span className="tabular-nums">({unread})</span>
							) : null}
						</button>
					);
				})}
			</nav>
		</div>
	);
}
