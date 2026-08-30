"use client";

// Presentational layer of the desktop Library page — the unified browsing
// surface that standardises how every collection (agents, workflows, chats,
// spaces, teams, meetings) is listed. The live app
// (`apps/desktop/src/pages/LibraryPage.tsx`) is a thin container: it loads each
// collection via its data hook, normalises rows into `LibraryCardData`, and
// renders these components with real handlers.
//
// Every tab shares ONE card/row/toolbar — that shared surface is the whole point
// of the page ("standardise the views"). The grid/list duality is captured in a
// single `view` prop on each card, mirroring `EngineCardShell`, so there are no
// per-type bespoke layouts.

import {
	ArrowDown01Icon,
	Search01Icon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ViewMode } from "@ryu/blocks/desktop/view-toggle.tsx";
import {
	type LibraryViewMode,
	LibraryViewToggle,
	ViewToggle,
} from "@ryu/blocks/desktop/view-toggle.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Card, CardContent, CardHeader } from "@ryu/ui/components/card.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactElement, ReactNode } from "react";

/** A sort option shown in the toolbar's sort dropdown. */
export interface LibrarySortOption {
	label: string;
	value: string;
}

/** One row's worth of display data, normalised by the container from any hook. */
export interface LibraryCardData {
	/** Optional short chip rendered top-right — a KIND ("Agent", "Workflow") or a
	 *  type-specific label. Deliberately narrow: this slot is overloaded already
	 *  (the mixed Recents/Favorites tabs put the item's TYPE here), so a status
	 *  attribute must not compete for it. */
	badge?: string | null;
	/** Whether this item is currently favorited. */
	favorited: boolean;
	/** Icon shown beside the name (per-type or per-item). */
	icon: IconSvgElement;
	/** Optional app-contributed icon node, used when the source icon is a string. */
	iconNode?: ReactNode;
	/** Stable key, unique within a tab. */
	key: string;
	name: string;
	/** Optional richer preview rendered in the card body (grid view only) — a
	 * workflow's input→output strip, a space page's markdown snippet, etc. */
	preview?: ReactNode;
	/** The item's STATUS attribute as a glyph (`StatusBadge`), shown before the
	 *  badge chip. Separate from `badge` because that one is a `string` the mixed
	 *  tabs already claim for the type label — an item can be both an "Agent" and
	 *  "Built-in", and one slot cannot say both. */
	statusIcon?: ReactNode;
	/** One-line secondary text (description, engine, member count, …). */
	subtitle?: string | null;
}

const noop = () => {
	// Default no-op for the presentational layer.
};

/**
 * Toolbar above the item list: search, an optional filter slot (type chips on
 * the Recents/Favorites tabs), a sort dropdown, the grid/list toggle, and the
 * tab's create CTA. The container owns all state; this is purely controlled.
 */
export function LibraryToolbar({
	className,
	query = "",
	onQueryChange = noop,
	searchPlaceholder = "Search…",
	showSearch = true,
	filterSlot,
	sort,
	sortOptions = [],
	onSortChange = noop,
	view,
	onViewChange = noop,
	showGraph = false,
	showShowcase = false,
	ctaLabel,
	ctaIcon,
	onCta,
}: {
	/** Overrides the row's own padding — the Library page renders this inside its
	 *  centered chrome column, which already owns the horizontal inset. */
	className?: string;
	query?: string;
	onQueryChange?: (value: string) => void;
	searchPlaceholder?: string;
	/** Hide the built-in search field (e.g. when search is folded into the tab bar). */
	showSearch?: boolean;
	filterSlot?: ReactNode;
	sort?: string;
	sortOptions?: LibrarySortOption[];
	onSortChange?: (value: string) => void;
	/** Grid/list view. Omit to hide the view toggle entirely (e.g. the Store,
	 *  which has no list mode). */
	view?: LibraryViewMode;
	onViewChange?: (mode: LibraryViewMode) => void;
	/** Skills-only Library extension: show the Relations projection. */
	showGraph?: boolean;
	/** Show the collection's richer visual presentation when one exists. */
	showShowcase?: boolean;
	ctaLabel?: string;
	ctaIcon?: IconSvgElement;
	onCta?: () => void;
}) {
	const activeSort = sortOptions.find((o) => o.value === sort);
	return (
		<div
			className={cn(
				"flex shrink-0 flex-wrap items-center gap-2 px-4 py-3",
				className
			)}
		>
			{showSearch ? (
				<div className="relative min-w-48 flex-1">
					<HugeiconsIcon
						className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
						icon={Search01Icon}
					/>
					<Input
						className="pl-8"
						onChange={(e) => onQueryChange(e.target.value)}
						placeholder={searchPlaceholder}
						value={query}
					/>
				</div>
			) : null}
			{filterSlot}
			{sortOptions.length > 0 ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button size="sm" variant="outline">
								{activeSort?.label ?? "Sort"}
								<HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
							</Button>
						}
					/>
					<DropdownMenuContent align="end">
						{sortOptions.map((o) => (
							<DropdownMenuItem
								key={o.value}
								onClick={() => onSortChange(o.value)}
							>
								{o.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
			{view ? (
				showGraph || showShowcase ? (
					<LibraryViewToggle
						onChange={onViewChange}
						showGraph={showGraph}
						showShowcase={showShowcase}
						value={view}
					/>
				) : (
					<ViewToggle
						onChange={onViewChange}
						value={view === "graph" ? "grid" : view}
					/>
				)
			) : null}
			{ctaLabel && onCta ? (
				<Button onClick={onCta} size="sm">
					{ctaIcon ? <HugeiconsIcon className="size-4" icon={ctaIcon} /> : null}
					{ctaLabel}
				</Button>
			) : null}
		</div>
	);
}

/** A toggleable type-filter chip, used in the toolbar's filter slot. */
export function LibraryFilterChip({
	label,
	icon,
	active,
	onClick = noop,
}: {
	label: string;
	icon?: IconSvgElement;
	active: boolean;
	onClick?: () => void;
}) {
	return (
		<Button
			onClick={onClick}
			size="sm"
			variant={active ? "secondary" : "ghost"}
		>
			{icon ? <HugeiconsIcon className="size-3.5" icon={icon} /> : null}
			{label}
		</Button>
	);
}

/** Favorite star toggle. Amber + filled when active, muted outline otherwise.
 *
 *  Exported because the Library's bespoke grids (the Spaces shelf, the Agents
 *  badge wall) drop `LibraryCard` for a presentation of their own but must still
 *  offer the same star — a per-surface copy would be the third one. */
export function FavoriteStar({
	favorited,
	onToggle,
	className,
}: {
	favorited: boolean;
	onToggle: () => void;
	className?: string;
}) {
	return (
		<Button
			aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
			aria-pressed={favorited}
			className={className}
			onClick={(e) => {
				// Don't trigger the card's open handler.
				e.stopPropagation();
				onToggle();
			}}
			size="icon-sm"
			variant="ghost"
		>
			<HugeiconsIcon
				className={cn(
					"size-4",
					favorited ? "fill-amber-400 text-amber-400" : "text-muted-foreground"
				)}
				icon={StarIcon}
			/>
		</Button>
	);
}

/** Container that lays its children out as a responsive grid or a flat list.
 *  `columns` caps the grid width: 2 mirrors the Store's centered card grid
 *  (`sm:grid-cols-2`), 3 (default) is the wider standalone layout. */
export function LibraryGrid({
	children,
	view = "grid",
	columns = 3,
}: {
	children: ReactNode;
	view?: ViewMode;
	columns?: 2 | 3;
}) {
	if (view === "list") {
		return <div className="flex flex-col gap-1.5">{children}</div>;
	}
	return (
		<div
			className={
				columns === 2
					? "grid grid-cols-1 gap-3 sm:grid-cols-2"
					: "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
			}
		>
			{children}
		</div>
	);
}

/**
 * One item rendered as either a grid card or a list row (driven by `view`). The
 * whole surface opens the item; the favorite star is a nested, stop-propagated
 * affordance. Shared by every Library tab — there is no per-type variant.
 *
 * `contextMenu` mirrors the Store card's prop of the same name: the caller
 * supplies the ROWS, this wraps the whole card (grid or list) in the trigger so
 * right-clicking anywhere on it opens them. Base UI wants `render=` rather than
 * a nested child — nesting a trigger around an element that already contains an
 * interactive control (the favorite star) is what crashes.
 */
export function LibraryCard({
	item,
	view = "grid",
	onOpen = noop,
	onToggleFavorite = noop,
	contextMenu,
}: {
	item: LibraryCardData;
	view?: ViewMode;
	onOpen?: () => void;
	onToggleFavorite?: () => void;
	/** Rows for the card's right-click menu. Omit for no menu. */
	contextMenu?: ReactNode;
}) {
	const star = (
		<FavoriteStar favorited={item.favorited} onToggle={onToggleFavorite} />
	);
	// The whole surface opens the item, but it can't be a <button> — the favorite
	// star is a nested interactive control, which is invalid inside a button.
	// Use the role="button" + keyboard pattern the sidebar rows use instead.
	const onKeyDown = (e: { key: string }) => {
		if (e.key === "Enter" || e.key === " ") {
			onOpen();
		}
	};

	const withMenu = (card: ReactElement) => {
		if (!contextMenu) {
			return card;
		}
		return (
			<ContextMenu>
				<ContextMenuTrigger render={card} />
				<ContextMenuContent align="end">{contextMenu}</ContextMenuContent>
			</ContextMenu>
		);
	};

	if (view === "list") {
		return withMenu(
			<div
				className="group flex w-full cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-muted"
				onClick={onOpen}
				onKeyDown={onKeyDown}
				role="button"
				tabIndex={0}
			>
				{item.iconNode ?? (
					<HugeiconsIcon
						className="size-4 shrink-0 opacity-70"
						icon={item.icon}
					/>
				)}
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-center gap-2">
						<span className="truncate font-medium text-sm">{item.name}</span>
						{item.statusIcon}
						{item.badge ? <Badge variant="outline">{item.badge}</Badge> : null}
					</div>
					{item.subtitle ? (
						<p className="truncate text-muted-foreground text-xs">
							{item.subtitle}
						</p>
					) : null}
				</div>
				<div className="shrink-0">{star}</div>
			</div>
		);
	}

	return withMenu(
		<Card
			className="group cursor-pointer gap-0 py-0 transition-colors hover:bg-muted/40"
			onClick={onOpen}
			onKeyDown={onKeyDown}
			role="button"
			tabIndex={0}
		>
			<CardHeader className="flex flex-row items-center justify-between gap-2 px-4 py-3">
				<span className="flex min-w-0 items-center gap-2">
					{item.iconNode ?? (
						<HugeiconsIcon
							className="size-4 shrink-0 opacity-70"
							icon={item.icon}
						/>
					)}
					<span className="truncate font-medium text-sm">{item.name}</span>
				</span>
				<span className="flex shrink-0 items-center gap-1">
					{item.statusIcon}
					{item.badge ? <Badge variant="outline">{item.badge}</Badge> : null}
					{star}
				</span>
			</CardHeader>
			{item.subtitle || item.preview ? (
				<CardContent className="flex flex-col gap-2 px-4 pb-3">
					{item.subtitle ? (
						<p className="line-clamp-2 text-muted-foreground text-sm">
							{item.subtitle}
						</p>
					) : null}
					{item.preview}
				</CardContent>
			) : null}
		</Card>
	);
}

/** Centered spinner for a tab still loading its collection. */
export function LibraryLoading() {
	return (
		<div className="flex items-center justify-center py-12">
			<Spinner />
		</div>
	);
}

/** Empty state shown when a tab resolves to no items. */
export function LibraryEmpty({
	icon,
	title,
	description,
	action,
}: {
	icon: IconSvgElement;
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<Empty className="py-12">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={icon} />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				{description ? (
					<EmptyDescription>{description}</EmptyDescription>
				) : null}
			</EmptyHeader>
			{action}
		</Empty>
	);
}
