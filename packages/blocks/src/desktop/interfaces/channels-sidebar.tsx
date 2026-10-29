import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import {
	SidebarContent,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuItem,
	SidebarSeparator,
} from "@ryu/ui/components/sidebar";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceChannel,
	InterfaceChannelSection,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { ChevronRight, Hash, House, SquarePen } from "lucide-react";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { ChannelsAvatar, PresenceDot } from "./channels-avatar.tsx";
import { agentById } from "./interface-renderer.ts";

/**
 * The menu-button look of `SidebarMenuButton`, without its `useSidebar()`
 * dependency. That hook needs a `SidebarProvider`, and a second provider
 * would register its own Cmd/Ctrl+B shortcut and rewrite the `sidebar_state`
 * cookie, fighting the app's real sidebar. Hover is the accent fill; the
 * selected row is a clearly filled primary tint (the accent sits too close to
 * the sidebar surface in light themes to carry selection on its own), and
 * focus-visible is the only outline in the list.
 */
const MENU_BUTTON_CLASS =
	"peer/menu-button group/menu-button flex h-7 w-full items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-active:bg-sidebar-primary/15 data-active:font-medium data-active:text-sidebar-foreground data-active:hover:bg-sidebar-primary/20";

/**
 * The sidebar's disclosure state, owned by the interface so the workspace
 * rail (which sits outside the sidebar) can bring the channel list back.
 */
export function useChannelsSidebarState() {
	const navRef = useRef<HTMLDivElement>(null);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const toggle = (sectionId: string) =>
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(sectionId)) {
				next.delete(sectionId);
			} else {
				next.add(sectionId);
			}
			return next;
		});
	// Home brings the full channel list back: expand every section and move
	// focus to the channel you are in.
	const goHome = () => {
		setCollapsed(new Set());
		const scroller = navRef.current;
		scroller?.scrollTo({ top: 0 });
		const target =
			scroller?.querySelector<HTMLButtonElement>('[aria-current="page"]') ??
			scroller?.querySelector<HTMLButtonElement>("[data-channel-row]");
		target?.focus();
	};
	return { collapsed, goHome, navRef, toggle };
}

interface ChannelsSidebarProps {
	/** Extra classes from the interface (the one-column phone layout). */
	className?: string;
	collapsed: ReadonlySet<string>;
	/** True while the title-bar search narrows the list. */
	filtering: boolean;
	/** Display label for a channel (`website-redesign`, or the agent's name). */
	labelFor: (channel: InterfaceChannel) => string;
	loading: boolean;
	navRef: RefObject<HTMLDivElement | null>;
	onCompose: () => void;
	onSelect: (channel: InterfaceChannel) => void;
	onToggle: (sectionId: string) => void;
	/** Running threads per channel id: the sidebar's unread state. */
	runningCounts: ReadonlyMap<string, number>;
	sections: InterfaceChannelSection[];
	selectedId: string | undefined;
	snapshot: InterfaceSnapshot;
}

/** Skeleton label widths, so the loading list does not read as a grid. */
const CHANNEL_SKELETON_WIDTHS = ["w-28", "w-24", "w-36"] as const;
const DM_SKELETON_WIDTHS = ["w-20", "w-28", "w-16", "w-24"] as const;

/**
 * The channel sidebar, drawn with the app's own sidebar tokens and parts:
 * the workspace header with its compose button, then collapsible Channels /
 * Direct messages groups.
 */
export function ChannelsSidebar({
	className,
	collapsed,
	filtering,
	labelFor,
	loading,
	navRef,
	onCompose,
	onSelect,
	onToggle,
	runningCounts,
	sections,
	selectedId,
	snapshot,
}: ChannelsSidebarProps) {
	const composeHintId = useId();
	const hasChannels = sections.some((section) => section.channels.length > 0);
	let body: ReactNode;
	if (hasChannels) {
		body = sections.map((section) => (
			<SidebarSection
				collapsed={collapsed.has(section.id)}
				filtering={filtering}
				key={section.id}
				labelFor={labelFor}
				onSelect={onSelect}
				onToggle={() => onToggle(section.id)}
				runningCounts={runningCounts}
				section={section}
				selectedId={selectedId}
				snapshot={snapshot}
			/>
		));
	} else if (loading) {
		body = <SidebarSkeleton />;
	} else {
		body = (
			<p className="px-4 py-2 text-sidebar-foreground/70 text-sm leading-5">
				{filtering ? "No channels match." : "No channels yet."}
			</p>
		);
	}
	return (
		<div
			className={cn(
				"relative flex @max-[640px]:w-full w-[248px] shrink-0 flex-col bg-sidebar text-sidebar-foreground",
				className
			)}
			data-slot="channels-sidebar"
		>
			<SidebarHeader className="h-12 shrink-0 flex-row items-center gap-2 py-0 pr-2 pl-4">
				<p className="min-w-0 flex-1 truncate font-bold text-base text-sidebar-foreground">
					Ryu
				</p>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-describedby={composeHintId}
								aria-label="New message"
								// On a phone the floating button below takes over.
								className="@max-[640px]:hidden text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring"
								onClick={onCompose}
								size="icon-sm"
								variant="ghost"
							/>
						}
					>
						<SquarePen aria-hidden="true" />
					</TooltipTrigger>
					<TooltipContent side="bottom">New message</TooltipContent>
				</Tooltip>
				<span className="sr-only" id={composeHintId}>
					New thread, no agent picked yet
				</span>
			</SidebarHeader>
			<SidebarSeparator className="mx-0" />
			<SidebarContent className="gap-0 py-2 @max-[640px]:pb-20" ref={navRef}>
				<nav aria-busy={loading && !hasChannels} aria-label="Channels">
					{body}
				</nav>
			</SidebarContent>
			{/* The phone layout's compose button, where a thumb reaches it. */}
			<Button
				aria-describedby={composeHintId}
				aria-label="New message"
				className="absolute right-4 bottom-4 @min-[640px]:hidden size-12 rounded-xl shadow-md [&_svg:not([class*='size-'])]:size-5"
				onClick={onCompose}
				size="icon"
			>
				<SquarePen aria-hidden="true" />
			</Button>
		</div>
	);
}

/** The loading list: the real rows' geometry, so nothing shifts on arrival. */
function SidebarSkeleton() {
	return (
		<div aria-hidden="true" className="flex flex-col gap-4 px-2">
			<div className="flex flex-col">
				<Skeleton
					className="mx-2 my-2 h-3 w-16 bg-sidebar-accent"
					radius="dense"
				/>
				{CHANNEL_SKELETON_WIDTHS.map((width) => (
					<div className="flex h-7 items-center gap-2 px-2" key={width}>
						<Skeleton className="size-4 bg-sidebar-accent" radius="dense" />
						<Skeleton
							className={cn("h-3", width, "bg-sidebar-accent")}
							radius="dense"
						/>
					</div>
				))}
			</div>
			<div className="flex flex-col">
				<Skeleton
					className="mx-2 my-2 h-3 w-24 bg-sidebar-accent"
					radius="dense"
				/>
				{DM_SKELETON_WIDTHS.map((width) => (
					<div className="flex h-7 items-center gap-2 px-2" key={width}>
						<Skeleton className="size-5 bg-sidebar-accent" radius="block" />
						<Skeleton
							className={cn("h-3", width, "bg-sidebar-accent")}
							radius="dense"
						/>
					</div>
				))}
			</div>
			<span className="sr-only">Loading channels</span>
		</div>
	);
}

/**
 * The far-left workspace rail: workspace tile, Home (the only destination
 * this interface has), and your own presence at the bottom. Flat filled
 * tiles, no borders or shadows.
 */
export function WorkspaceRail({
	onHome,
	threadOpen,
}: {
	onHome: () => void;
	/** A thread panel is open: give its width back below 1100px. */
	threadOpen: boolean;
}) {
	return (
		<div
			className={cn(
				"flex @max-[900px]:hidden w-14 shrink-0 flex-col items-center gap-3 border-sidebar-border border-r bg-sidebar pt-2 pb-3 text-sidebar-foreground",
				threadOpen && "@max-[1100px]:hidden"
			)}
		>
			<span
				aria-label="Ryu workspace"
				className="corner-squircle flex size-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"
				role="img"
			>
				<RyuLogo
					animated={false}
					size="22px"
					tone="inherit"
					variant="outline"
				/>
			</span>
			<nav aria-label="Workspace" className="flex flex-col items-center">
				<button
					aria-current="page"
					className="group flex flex-col items-center gap-1 rounded-lg outline-hidden"
					onClick={onHome}
					type="button"
				>
					<span className="corner-squircle flex size-9 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground ring-sidebar-ring transition-colors group-hover:bg-sidebar-primary/15 group-focus-visible:ring-2">
						<House aria-hidden="true" className="size-4" />
					</span>
					<span className="font-medium text-sidebar-foreground text-xs leading-4">
						Home
					</span>
				</button>
			</nav>
			<span
				aria-label="You, active"
				className="relative mt-auto flex"
				role="img"
			>
				<ChannelsAvatar name="You" size={36} />
				<PresenceDot active ringClassName="bg-sidebar" />
			</span>
		</div>
	);
}

function SidebarSection({
	collapsed,
	filtering,
	labelFor,
	onSelect,
	onToggle,
	runningCounts,
	section,
	selectedId,
	snapshot,
}: {
	collapsed: boolean;
	filtering: boolean;
	labelFor: (channel: InterfaceChannel) => string;
	onSelect: (channel: InterfaceChannel) => void;
	onToggle: () => void;
	runningCounts: ReadonlyMap<string, number>;
	section: InterfaceChannelSection;
	selectedId: string | undefined;
	snapshot: InterfaceSnapshot;
}) {
	const listId = useId();
	// A collapsed section still shows where you are and what is live.
	const visible = collapsed
		? section.channels.filter(
				(channel) => channel.id === selectedId || channel.running
			)
		: section.channels;
	return (
		<SidebarGroup className="px-2 py-0 pb-3">
			<h2 className="flex">
				<SidebarGroupLabel
					aria-controls={listId}
					aria-expanded={!collapsed}
					className="group/label h-7 w-full cursor-default gap-1 rounded-md px-2 font-medium text-sidebar-foreground/70 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
					onClick={onToggle}
					render={<button type="button" />}
				>
					<ChevronRight
						aria-hidden="true"
						className={cn(
							"size-4! transition-transform duration-150 motion-reduce:transition-none",
							collapsed ? "rotate-0" : "rotate-90"
						)}
					/>
					{section.label}
				</SidebarGroupLabel>
			</h2>
			<SidebarMenu className="gap-0" id={listId}>
				{section.channels.length === 0 ? (
					<SidebarMenuItem className="flex h-7 items-center pl-8 text-sidebar-foreground/70 text-sm">
						{filtering ? "No matches" : "None yet"}
					</SidebarMenuItem>
				) : null}
				{visible.map((channel) => (
					<SidebarMenuItem key={channel.id}>
						<ChannelRow
							active={channel.id === selectedId}
							channel={channel}
							label={labelFor(channel)}
							onSelect={onSelect}
							running={runningCounts.get(channel.id) ?? 0}
							snapshot={snapshot}
						/>
					</SidebarMenuItem>
				))}
			</SidebarMenu>
		</SidebarGroup>
	);
}

/**
 * One channel or DM. A row with work in flight reads bold unless you are in
 * it, the same signal for channels and DMs, as in a team chat's unread
 * state. There is no count badge or dot: in a team chat a count means
 * mentions, and agents at work are not mentions.
 */
function ChannelRow({
	active,
	channel,
	label,
	onSelect,
	running,
	snapshot,
}: {
	active: boolean;
	channel: InterfaceChannel;
	label: string;
	onSelect: (channel: InterfaceChannel) => void;
	running: number;
	snapshot: InterfaceSnapshot;
}) {
	const isDm = channel.kind === "agent";
	const agent = isDm ? agentById(snapshot, channel.agentIds[0]) : undefined;
	const unread = running > 0;
	const tl = useLiteralMessages();
	return (
		<button
			aria-current={active ? "page" : undefined}
			className={cn(
				MENU_BUTTON_CLASS,
				// Work in flight stays bold on the row you are in, so bold
				// always means the same thing.
				unread &&
					"font-semibold text-sidebar-foreground data-active:font-semibold",
				!(active || unread) && "text-sidebar-foreground/75"
			)}
			data-active={active ? "" : undefined}
			data-channel-row=""
			data-sidebar="menu-button"
			data-size="compact"
			onClick={() => onSelect(channel)}
			type="button"
		>
			{isDm ? (
				<span className="relative flex shrink-0">
					<ChannelsAvatar agent={agent} name={channel.name} size={20} />
					<PresenceDot
						active={agent?.status === "working"}
						className="size-2.5 [&>span]:size-1.5"
						ringClassName={
							active
								? "bg-transparent"
								: "bg-sidebar group-hover/menu-button:bg-sidebar-accent"
						}
					/>
				</span>
			) : (
				<Hash aria-hidden="true" className="size-4 shrink-0 opacity-70" />
			)}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{unread ? (
				<span className="sr-only">
					{tl(", {running} working", { running: String(running) })}
				</span>
			) : null}
		</button>
	);
}
