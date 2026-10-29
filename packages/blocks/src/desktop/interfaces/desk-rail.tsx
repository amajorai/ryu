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
import {
	SidebarContent,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuItem,
	SidebarMenuSkeleton,
} from "@ryu/ui/components/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	DeskView,
	DeskViewSection,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	ChevronDown,
	Clock,
	FolderKanban,
	Inbox,
	LoaderCircle,
	type LucideIcon,
	Pin,
	Reply,
	SquarePen,
	UsersRound,
} from "lucide-react";
import {
	Fragment,
	type KeyboardEvent,
	useCallback,
	useRef,
	useState,
} from "react";
import { DeskAvatar } from "./desk-avatar.tsx";
import { DESK_FOCUS_RING, deskCursorStep } from "./desk-list.tsx";
import { DESK_NEEDS_YOU_VIEW_ID, pluralize } from "./desk-model.ts";
import { agentById } from "./interface-renderer.ts";

/**
 * The look of `SidebarMenuButton` without its `useSidebar()` dependency: that
 * hook needs a `SidebarProvider`, and a second provider would register its own
 * Cmd/Ctrl+B shortcut and cookie, fighting the app's real sidebar.
 */
const MENU_BUTTON_CLASS = `peer/menu-button group/menu-button flex h-8 w-full items-center gap-2 overflow-hidden rounded-lg pr-9 pl-2 text-left text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 ${DESK_FOCUS_RING}`;

const SHARED_ICONS: Record<string, LucideIcon> = {
	all: Inbox,
	"needs-you": Reply,
	pinned: Pin,
	waiting: Clock,
	working: LoaderCircle,
};

/** Views owned by one agent, team, or project (not the shared views). */
const SCOPED_KINDS = new Set<DeskView["kind"]>(["agent", "project", "team"]);

function viewIcon(view: DeskView): LucideIcon {
	if (view.kind === "team") {
		return UsersRound;
	}
	if (view.kind === "project") {
		return FolderKanban;
	}
	return SHARED_ICONS[view.id] ?? Inbox;
}

function viewAccessibleName(
	view: DeskView,
	snapshot: InterfaceSnapshot,
	needsYou: number
): string {
	const parts = [
		view.kind === "agent" ? `${view.label} inbox` : view.label,
		pluralize(view.threadIds.length, "conversation"),
	];
	if (needsYou > 0) {
		parts.push(`${needsYou} need${needsYou === 1 ? "s" : ""} you`);
	}
	if (
		view.kind === "agent" &&
		agentById(snapshot, view.refId)?.status === "working"
	) {
		parts.push("working now");
	}
	return parts.join(", ");
}

/**
 * Every count in the rail is the view's total, matching the list header
 * beside it. The Needs-you view's total sits on a solid pill; an inbox, team
 * or project holding threads that need the user sets its label and count in
 * full-strength text instead (the inbox convention for unread), so the rail
 * carries no separate marks.
 */
function railBadgeClass(urgent: boolean, needsYou: boolean): string {
	if (urgent) {
		return "bg-primary text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-active/menu-button:text-primary-foreground";
	}
	if (needsYou) {
		return "font-medium text-sidebar-foreground peer-hover/menu-button:text-sidebar-accent-foreground peer-data-active/menu-button:text-sidebar-accent-foreground";
	}
	return "font-normal text-sidebar-foreground/60 peer-hover/menu-button:text-sidebar-accent-foreground/70 peer-data-active/menu-button:text-sidebar-accent-foreground/70";
}

function RailItem({
	focusable,
	needsYouIds,
	onFocusItem,
	onSelect,
	registerItem,
	selected,
	snapshot,
	view,
}: {
	/** The rail's one tab stop (roving tabindex). */
	focusable: boolean;
	/** Threads in the Needs-you view, to flag inboxes that hold some. */
	needsYouIds: ReadonlySet<string>;
	onFocusItem: (viewId: string) => void;
	onSelect: (viewId: string) => void;
	registerItem: (viewId: string, element: HTMLButtonElement | null) => void;
	selected: boolean;
	snapshot: InterfaceSnapshot;
	view: DeskView;
}) {
	const count = view.threadIds.length;
	const urgent = view.id === DESK_NEEDS_YOU_VIEW_ID && count > 0;
	const needsYou = SCOPED_KINDS.has(view.kind)
		? view.threadIds.filter((id) => needsYouIds.has(id)).length
		: 0;
	const Icon = viewIcon(view);
	const agent = view.kind === "agent" ? agentById(snapshot, view.refId) : null;
	return (
		<SidebarMenuItem>
			<button
				aria-current={selected ? "page" : undefined}
				aria-label={viewAccessibleName(view, snapshot, needsYou)}
				className={MENU_BUTTON_CLASS}
				data-active={selected ? "" : undefined}
				data-testid={`desk-view-${view.id}`}
				onClick={() => onSelect(view.id)}
				onFocus={() => onFocusItem(view.id)}
				ref={(element) => registerItem(view.id, element)}
				tabIndex={focusable ? 0 : -1}
				type="button"
			>
				{agent ? (
					<DeskAvatar
						agent={agent}
						presence
						size={16}
						surface={selected ? "sidebar-accent" : "sidebar"}
					/>
				) : (
					<Icon
						aria-hidden="true"
						className={cn(
							urgent ? "text-primary" : "text-sidebar-foreground/70"
						)}
					/>
				)}
				<span
					className={cn("truncate", needsYou > 0 && "font-medium")}
					data-testid={
						needsYou > 0 ? `desk-view-${view.id}-needs-you` : undefined
					}
				>
					{view.label}
				</span>
			</button>
			{count > 0 ? (
				<SidebarMenuBadge
					aria-hidden="true"
					className={cn(
						"top-1.5 right-1.5 tabular-nums",
						railBadgeClass(urgent, needsYou > 0)
					)}
					data-testid={`desk-view-${view.id}-count`}
				>
					{count}
				</SidebarMenuBadge>
			) : null}
		</SidebarMenuItem>
	);
}

/** The left views rail: shared views, agent inboxes, teams and projects. */
export function DeskViewsRail({
	loading,
	onSelect,
	onStart,
	sections,
	selectedId,
	snapshot,
	startLabel,
}: {
	loading: boolean;
	onSelect: (viewId: string) => void;
	/** Starts a conversation filed under the selected view. */
	onStart: () => void;
	sections: DeskViewSection[];
	selectedId: string;
	snapshot: InterfaceSnapshot;
	/** "New conversation with Atlas" and the like, for the compose button. */
	startLabel: string;
}) {
	const views = sections.flatMap((section) => section.views);
	const order = views.map((view) => view.id);
	const needsYouIds = new Set(
		views.find((view) => view.id === DESK_NEEDS_YOU_VIEW_ID)?.threadIds ?? []
	);
	const items = useRef(new Map<string, HTMLButtonElement>());
	const [focusedId, setFocusedId] = useState<string | null>(null);
	// One tab stop: the item the user last moved to, else the selected view.
	let tabStop = order.includes(selectedId) ? selectedId : (order[0] ?? null);
	if (focusedId && order.includes(focusedId)) {
		tabStop = focusedId;
	}

	const registerItem = useCallback(
		(viewId: string, element: HTMLButtonElement | null) => {
			if (element) {
				items.current.set(viewId, element);
			} else {
				items.current.delete(viewId);
			}
		},
		[]
	);

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}
		const step = deskCursorStep(event.key);
		const current = order.indexOf(tabStop ?? "");
		if (!step || current < 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const target = {
			first: 0,
			last: order.length - 1,
			next: Math.min(current + 1, order.length - 1),
			previous: Math.max(current - 1, 0),
		}[step];
		const nextId = order[target];
		if (nextId) {
			setFocusedId(nextId);
			items.current.get(nextId)?.focus();
		}
	};

	return (
		<nav
			aria-label="Desk views"
			className="flex w-60 shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground"
			data-testid="desk-rail"
		>
			<SidebarHeader className="h-14 shrink-0 flex-row items-center gap-2 border-sidebar-border border-b py-0 pr-2 pl-4">
				<h2 className="min-w-0 flex-1 truncate text-sidebar-foreground text-sm">
					<span className="font-semibold">Desk</span>
				</h2>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label={startLabel}
								data-testid="desk-new-conversation"
								onClick={onStart}
								size="icon-sm"
								variant="ghost-muted"
							/>
						}
					>
						<SquarePen aria-hidden="true" />
					</TooltipTrigger>
					<TooltipContent side="bottom">
						{startLabel} <Kbd>C</Kbd>
					</TooltipContent>
				</Tooltip>
			</SidebarHeader>
			<SidebarContent
				className="min-h-0 flex-1 gap-0 overflow-y-auto overscroll-contain py-1"
				onKeyDown={onKeyDown}
			>
				{loading && snapshot.threads.length === 0 ? (
					<SidebarGroup>
						<SidebarMenu>
							{["a", "b", "c", "d", "e"].map((key) => (
								<SidebarMenuItem key={key}>
									<SidebarMenuSkeleton showIcon />
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroup>
				) : (
					sections
						.filter((section) => section.views.length > 0)
						.map((section) => (
							<SidebarGroup className="py-1" key={section.id}>
								<SidebarGroupLabel
									className="h-7 px-2 text-muted-foreground"
									id={`desk-rail-${section.id}`}
								>
									{section.label}
								</SidebarGroupLabel>
								<SidebarMenu aria-labelledby={`desk-rail-${section.id}`}>
									{section.views.map((view) => (
										<RailItem
											focusable={view.id === tabStop}
											key={view.id}
											needsYouIds={needsYouIds}
											onFocusItem={setFocusedId}
											onSelect={onSelect}
											registerItem={registerItem}
											selected={view.id === selectedId}
											snapshot={snapshot}
											view={view}
										/>
									))}
								</SidebarMenu>
							</SidebarGroup>
						))
				)}
			</SidebarContent>
		</nav>
	);
}

/**
 * The views rail collapsed into a menu for narrow widths. Its trigger reads
 * as the list heading ("Needs you 6"), so the header looks the same as in the
 * wide layout.
 */
export function DeskViewSelect({
	className,
	onSelect,
	sections,
	selectedId,
}: {
	className?: string;
	onSelect: (viewId: string) => void;
	sections: DeskViewSection[];
	selectedId: string;
}) {
	const tl = useLiteralMessages();
	const selected = sections
		.flatMap((section) => section.views)
		.find((view) => view.id === selectedId);
	const label = selected?.label ?? "Conversations";
	return (
		<div className={cn("flex min-w-0", className)}>
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={tl("Desk view: {label}", { label })}
					data-testid="desk-view-select"
					render={
						<button
							className={cn(
								"-ml-2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted aria-expanded:bg-muted",
								DESK_FOCUS_RING
							)}
							type="button"
						/>
					}
				>
					<span className="truncate font-semibold text-foreground">
						{label}
					</span>
					<span className="shrink-0 text-muted-foreground tabular-nums">
						{selected?.threadIds.length ?? 0}
					</span>
					<ChevronDown
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					className="w-60"
					drawerLabel="Desk view"
				>
					<DropdownMenuRadioGroup
						onValueChange={(value: string) => onSelect(value)}
						value={selectedId}
					>
						{sections
							.filter((section) => section.views.length > 0)
							.map((section, index) => (
								<Fragment key={section.id}>
									{index > 0 ? <DropdownMenuSeparator /> : null}
									<DropdownMenuGroup>
										<DropdownMenuLabel>{section.label}</DropdownMenuLabel>
										{section.views.map((view) => (
											<DropdownMenuRadioItem key={view.id} value={view.id}>
												<span className="min-w-0 flex-1 truncate">
													{view.label}
												</span>
												<span className="text-muted-foreground text-xs tabular-nums">
													{view.threadIds.length}
												</span>
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuGroup>
								</Fragment>
							))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
