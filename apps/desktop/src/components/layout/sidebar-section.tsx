import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	FilterHorizontalIcon,
	MoreHorizontalIcon,
	SlidersHorizontalIcon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages, useLocalizedString } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	SidebarGroup,
	SidebarGroupContent,
} from "@ryu/ui/components/sidebar.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import type { ReorderShift } from "@ryu/ui/hooks/use-reorder-shift.tsx";
import type { ReactNode } from "react";
import {
	ALL_CHAT_GROUP_BY,
	ChatViewMenuItems,
} from "./sidebar-chat-grouping.tsx";
import {
	type ChatMoveDrop,
	useChatMoveDropTarget,
} from "./sidebar-chat-selection.tsx";
import {
	activeChatFilterCount,
	type ChatGroupBy,
	type ChatSectionView,
} from "./sidebar-chat-view.ts";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import { PAGE_SIZE_OPTIONS } from "./sidebar-scope-picker.tsx";
import type { SectionKey } from "./sidebar-sections.ts";
import {
	isSortKey,
	SORT_OPTIONS,
	type SortKey,
} from "./sidebar-sort-paging.ts";

/** Drag-and-drop wiring threaded into every reorderable section header. */
export interface SectionDnd {
	draggingKey: SectionKey | null;
	dragOverKey: SectionKey | null;
	onDragEnd: () => void;
	onDragOver: (key: SectionKey) => void;
	onDragStart: (key: SectionKey) => void;
	onDrop: (key: SectionKey) => void;
	/** Current section order, so a target can tell which side to draw the drop line. */
	order: SectionKey[];
	/** Slides sections apart to preview the drop. */
	shift: ReorderShift;
}

/** The per-section overflow menu: move, hide, page size, sort, and customize. */
export interface SectionMenu {
	canMove: (key: SectionKey, dir: "up" | "down") => boolean;
	onHide: (key: SectionKey) => void;
	onMove: (key: SectionKey, dir: "up" | "down") => void;
	onOpenCustomize: () => void;
	/** Save a chat section's group-by + filters. */
	onSetChatView: (key: SectionKey, view: ChatSectionView) => void;
	onSetPageSize: (key: SectionKey, size: number) => void;
	onSetSort: (key: SectionKey, sort: SortKey) => void;
}

/** A section action folded into the header's ⋯ menu instead of its own
 *  hover button, so a header shows at most "+" and "⋯". */
export interface SectionMenuAction {
	icon: IconSvgElement;
	id: string;
	label: string;
	onSelect: () => void;
}

export interface SectionProps {
	/** Group-by + filters, on the chat sections (Pinned, Chats, Projects, Archived). */
	chatView?: ChatSectionView;
	collapsed: boolean;
	dnd: SectionDnd;
	/** Shared section glyph used by both the stacked header and tabbed selector. */
	icon?: IconSvgElement;
	menu: SectionMenu;
	onOpenQuickPreview?: ChatRowHandlers["onOpenQuickPreview"];
	onOpenQuickReply?: ChatRowHandlers["onOpenQuickReply"];
	onToggleCollapsed: (key: SectionKey) => void;
	/** Items to show before a "Show more" control (0 means show all). */
	pageSize: number;
	/** How this section orders its items before pagination. */
	sort: SortKey;
}

/** A small "+" affordance in a section header, revealed on section hover. */
export function SectionActionButton({
	icon,
	onClick,
	title,
}: {
	icon: IconSvgElement;
	onClick: () => void;
	title: string;
}) {
	const localizedTitle = useLocalizedString(title) ?? title;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={localizedTitle}
						className="size-6 rounded-lg opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/section:opacity-100 group-hover/section:duration-0"
						onClick={(e) => {
							e.stopPropagation();
							onClick();
						}}
						size="icon-xs"
						type="button"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-3.5" icon={icon} />
					</Button>
				}
			/>
			<TooltipContent>{localizedTitle}</TooltipContent>
		</Tooltip>
	);
}

export function SectionAddButton({
	onClick,
	title,
}: {
	onClick: () => void;
	title: string;
}) {
	return (
		<span className="mr-1">
			<SectionActionButton icon={Add01Icon} onClick={onClick} title={title} />
		</span>
	);
}

/** Hover-reveal action for a nested sub-section header (project folder / date
 *  bucket). Same affordance as {@link SectionActionButton} but keyed to the
 *  sub-section's own `group/subsection` hover so it shows only for the folder
 *  the pointer is over, not the whole section. */
export function SubSectionActionButton({
	icon,
	onClick,
	title,
}: {
	icon: IconSvgElement;
	onClick: () => void;
	title: string;
}) {
	const localizedTitle = useLocalizedString(title) ?? title;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={localizedTitle}
						className="size-6 rounded-lg opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/subsection:opacity-100 group-hover/subsection:duration-0"
						onClick={(e) => {
							e.stopPropagation();
							onClick();
						}}
						size="icon-xs"
						type="button"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-3.5" icon={icon} />
					</Button>
				}
			/>
			<TooltipContent>{localizedTitle}</TooltipContent>
		</Tooltip>
	);
}

function SectionOverflowMenu({
	actions,
	chatGroupByOptions,
	chatView,
	label,
	menu,
	pageSize,
	sectionKey,
	sort,
}: {
	actions?: readonly SectionMenuAction[];
	chatGroupByOptions?: readonly ChatGroupBy[];
	chatView?: ChatSectionView;
	label: string;
	menu: SectionMenu;
	pageSize: number;
	sectionKey: SectionKey;
	sort: SortKey;
}) {
	const tl = useLiteralMessages();
	return (
		<DropdownMenu>
			{/* data-[popup-open] keeps the trigger visible while the menu is open, so
			    it neither fades out under the cursor nor loses its anchor. Base UI sets
			    data-popup-open, not data-state, on the trigger. */}
			<DropdownMenuTrigger
				aria-label={tl("{label} options", { label })}
				className="flex size-6 shrink-0 items-center justify-center rounded-lg"
				motion="opacity"
				onClick={(e) => e.stopPropagation()}
				reveal="section"
				variant="muted"
			>
				<HugeiconsIcon className="size-3.5" icon={MoreHorizontalIcon} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{actions && actions.length > 0 ? (
					<>
						{actions.map((action) => (
							<DropdownMenuItem key={action.id} onClick={action.onSelect}>
								<HugeiconsIcon className="size-4" icon={action.icon} />
								{action.label}
							</DropdownMenuItem>
						))}
						<DropdownMenuSeparator />
					</>
				) : null}
				<DropdownMenuItem
					disabled={!menu.canMove(sectionKey, "up")}
					onClick={() => menu.onMove(sectionKey, "up")}
				>
					<HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
					Move up
				</DropdownMenuItem>
				<DropdownMenuItem
					disabled={!menu.canMove(sectionKey, "down")}
					onClick={() => menu.onMove(sectionKey, "down")}
				>
					<HugeiconsIcon className="size-4" icon={ArrowDown01Icon} />
					Move down
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => menu.onHide(sectionKey)}>
					<HugeiconsIcon className="size-4" icon={ViewOffSlashIcon} />
					Hide section
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>Sort by</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuRadioGroup
							onValueChange={(value: string) => {
								if (isSortKey(value)) {
									menu.onSetSort(sectionKey, value);
								}
							}}
							value={sort}
						>
							{SORT_OPTIONS.filter((opt) => chatView || !opt.chatOnly).map(
								(opt) => (
									<DropdownMenuRadioItem key={opt.value} value={opt.value}>
										{opt.label}
									</DropdownMenuRadioItem>
								)
							)}
						</DropdownMenuRadioGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				{chatView ? (
					<ChatViewMenuItems
						groupByOptions={chatGroupByOptions ?? ALL_CHAT_GROUP_BY}
						onChange={(view) => menu.onSetChatView(sectionKey, view)}
						view={chatView}
					/>
				) : null}
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>Show items</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuRadioGroup
							onValueChange={(value: string) =>
								menu.onSetPageSize(sectionKey, Number(value))
							}
							value={String(pageSize)}
						>
							{PAGE_SIZE_OPTIONS.map((opt) => (
								<DropdownMenuRadioItem
									key={opt.value}
									value={String(opt.value)}
								>
									{opt.label}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={menu.onOpenCustomize}>
					<HugeiconsIcon className="size-4" icon={SlidersHorizontalIcon} />
					Customize sidebar
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Top-level collapsible + draggable section shell. The header doubles as the
 *  collapse toggle (click) and the drag handle (drag); the browser suppresses
 *  the click that follows a drag, so the two gestures don't collide. */
export function SidebarSection({
	action,
	chatDrop,
	menuActions,
	chatGroupByOptions,
	chatView,
	children,
	collapsed,
	dnd,
	icon,
	iconNode,
	label,
	menu,
	onToggleCollapsed,
	pageSize,
	sectionKey,
	sort,
	title,
	wrapHeader,
}: SectionProps & {
	action?: ReactNode;
	/** Accept chat rows dragged in from other sections (pin, archive, …). */
	chatDrop?: ChatMoveDrop;
	/** Secondary actions listed at the top of the header's ⋯ menu. */
	menuActions?: readonly SectionMenuAction[];
	/** Group-by choices offered for this chat section (empty hides Group by). */
	chatGroupByOptions?: readonly ChatGroupBy[];
	children: ReactNode;
	icon?: IconSvgElement;
	iconNode?: ReactNode;
	label: string;
	sectionKey: SectionKey;
	title?: string;
	/** Optional wrapper for the header row — e.g. a right-click "Delete all
	 *  chats" context menu. Defaults to identity (no wrapper). */
	wrapHeader?: (header: ReactNode) => ReactNode;
}) {
	const tl = useLiteralMessages();
	const localizedLabel = useLocalizedString(label) ?? label;
	const localizedTitle = useLocalizedString(title);
	const chatMove = useChatMoveDropTarget(chatDrop);
	const filterCount = chatView ? activeChatFilterCount(chatView.filters) : 0;
	// Sections slide apart to preview the drop; the line only marks a target
	// the slide cannot reach (one rendered in a different list).
	const isDragOver =
		dnd.dragOverKey === sectionKey &&
		dnd.draggingKey !== null &&
		dnd.draggingKey !== sectionKey &&
		!dnd.shift.previewing;
	const isDragging = dnd.draggingKey === sectionKey;
	// The drop inserts after the target when dragging downward, before it when
	// dragging upward — so draw the indicator line on the matching edge.
	const dropBelow =
		isDragOver &&
		dnd.draggingKey !== null &&
		dnd.order.indexOf(dnd.draggingKey) < dnd.order.indexOf(sectionKey);
	const headerButton = (
		<button
			className="group/hdr flex h-7 min-w-0 flex-1 cursor-grab items-center gap-2 rounded-lg px-2 text-detail text-muted-foreground transition-colors duration-150 hover:text-foreground hover:duration-0 active:cursor-grabbing"
			draggable
			onClick={() => onToggleCollapsed(sectionKey)}
			onDragEnd={() => dnd.onDragEnd()}
			onDragStart={(e) => {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", sectionKey);
				dnd.onDragStart(sectionKey);
			}}
			type="button"
		>
			{iconNode ??
				(icon && <HugeiconsIcon className="size-3.5 shrink-0" icon={icon} />)}
			<span className="min-w-0 truncate">{localizedLabel}</span>
			{filterCount > 0 ? (
				<HugeiconsIcon
					aria-label={tl(
						"{filterCount, plural, one {# filter} other {# filters}} active",
						{ filterCount }
					)}
					className="size-3.5 shrink-0 text-foreground"
					icon={FilterHorizontalIcon}
				/>
			) : null}
			<HugeiconsIcon
				className={`-ml-1 size-3.5 shrink-0 opacity-0 transition duration-150 group-hover/hdr:opacity-100 group-hover/hdr:duration-0 ${collapsed ? "-rotate-90" : ""}`}
				icon={ArrowDown01Icon}
			/>
		</button>
	);
	return (
		<SidebarGroup
			className={`group/section scroll-mt-2 ${chatMove.isOver ? "rounded-lg bg-accent" : ""}`}
			data-testid={`sidebar-section-${sectionKey}`}
			dragging={isDragging}
			id={`sidebar-sec-${sectionKey}`}
			onDragLeave={chatMove.onDragLeave}
			onDragOver={(e) => {
				if (chatMove.onDragOver(e)) {
					return;
				}
				if (dnd.draggingKey) {
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					dnd.onDragOver(
						dnd.shift.resolveOver(sectionKey, e.clientX, e.clientY)
					);
				}
			}}
			onDrop={(e) => {
				if (chatMove.onDrop(e)) {
					return;
				}
				e.preventDefault();
				dnd.onDrop(sectionKey);
			}}
			ref={dnd.shift.register(sectionKey)}
			spacing="compact"
			style={dnd.shift.styleFor(sectionKey)}
		>
			{isDragOver && (
				<div
					className={`reorder-drop-indicator pointer-events-none absolute inset-x-2 z-10 h-0.5 bg-primary ${dropBelow ? "bottom-0" : "top-0"}`}
				/>
			)}
			{(() => {
				const headerRow = (
					<div className="relative flex items-center">
						{title ? (
							<Tooltip>
								<TooltipTrigger render={headerButton} />
								<TooltipContent align="start">{localizedTitle}</TooltipContent>
							</Tooltip>
						) : (
							headerButton
						)}
						<div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
							{action}
							<SectionOverflowMenu
								actions={menuActions}
								chatGroupByOptions={chatGroupByOptions}
								chatView={chatView}
								label={label}
								menu={menu}
								pageSize={pageSize}
								sectionKey={sectionKey}
								sort={sort}
							/>
						</div>
					</div>
				);
				return wrapHeader ? wrapHeader(headerRow) : headerRow;
			})()}
			{!collapsed && <SidebarGroupContent>{children}</SidebarGroupContent>}
		</SidebarGroup>
	);
}
