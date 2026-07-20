"use client";

// The Ryu desktop window chrome. Built on the SAME real `@ryu/ui` Sidebar
// primitives, real `Logo`, and HugeIcons the live app's `AppSidebar` uses
// (apps/desktop/src/components/layout/AppSidebar.tsx), so every desktop panel
// reads as the real app. The live sidebar's drag-drop / customize / persistence
// machinery is container-only and intentionally omitted here; this is the
// presentational frame screens render inside.
//
// Extracted from apps/storyboard so both the storyboard and the web landing's
// app-showcase render the exact same shell (no drift, no rewrite).
//
// Variant note: the live `AppSidebar` is `<Sidebar variant="floating">`, whose
// floating panel (rounded-3xl + border + drop-shadow) is rendered by the
// primitive's NON-`collapsible="none"` branch using viewport-`fixed` positioning.
// That positioning escapes a constrained container, so we keep
// `collapsible="none"` (which lays out cleanly in a constrained container) and
// reproduce the floating panel manually on an inner wrapper — matching
// `packages/ui/src/components/sidebar.tsx` `sidebar-inner` + the `p-2` gap.

import {
	Activity01Icon,
	Add01Icon,
	ArrowDown01Icon,
	Calendar03Icon,
	LibraryIcon,
	Mic01Icon,
	PencilEdit01Icon,
	Search01Icon,
	Store01Icon,
	UserGroupIcon,
	WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Avatar, AvatarFallback } from "@ryu/ui/components/avatar";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
} from "@ryu/ui/components/sidebar";
import type { ReactNode } from "react";

const RECENT_CHATS = [
	"Refactor the auth flow",
	"Summarize the Q3 report",
	"Debug the SSE stream",
	"Plan the launch checklist",
];

const AGENTS = ["Ryu", "Claude Code", "Codex"];
const TEAMS = ["Research Squad"];
const SPACES = ["Product Docs", "Research"];
const MEETINGS: { name: string; recording?: boolean }[] = [
	{ name: "Weekly sync", recording: true },
	{ name: "Design review" },
];
const WORKFLOWS = ["Daily digest"];

/** A reorderable header nav button, mirroring the live sidebar's chrome row. */
function NavButton({
	icon,
	label,
	shortcut,
	active,
	onClick,
}: {
	icon: typeof Store01Icon;
	label: string;
	shortcut?: string;
	active?: boolean;
	onClick?: () => void;
}) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton className="h-8" isActive={active} onClick={onClick}>
				<HugeiconsIcon className="size-4" icon={icon} />
				<span>{label}</span>
				{shortcut ? (
					<span className="ml-auto text-muted-foreground text-xs">
						{shortcut}
					</span>
				) : null}
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

/** A content section (Agents / Teams / Spaces / …), mirroring the live sidebar's
 *  `SidebarSection`: a draggable muted-xs label with a hover collapse chevron,
 *  and a "+" add button revealed on section hover. */
function Section({ label, children }: { label: string; children: ReactNode }) {
	return (
		<SidebarGroup className="group/section py-1">
			<div className="relative flex items-center">
				<div className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-xs">
					<span className="min-w-0 truncate">{label}</span>
					<HugeiconsIcon
						className="-ml-1 size-3 shrink-0 opacity-0 transition group-hover/section:opacity-100"
						icon={ArrowDown01Icon}
					/>
				</div>
				<div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
					<span className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-hover/section:opacity-100">
						<HugeiconsIcon icon={Add01Icon} size={14} />
					</span>
				</div>
			</div>
			<SidebarGroupContent>
				<SidebarMenu className="gap-0.5">{children}</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	);
}

function LogoRow({ name }: { name: string }) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton className="h-8">
				<RyuLogo
					className="shrink-0 text-foreground"
					size="16px"
					variant="outline"
				/>
				<span className="truncate">{name}</span>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

function IconRow({ icon, name }: { icon: typeof LibraryIcon; name: string }) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton className="h-8">
				<HugeiconsIcon className="size-4 text-muted-foreground" icon={icon} />
				<span className="truncate">{name}</span>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

/** A meeting row — Mic icon + title, with a pulsing red dot only while a meeting
 *  is recording (matching the live `MeetingsSection`). */
function MeetingRow({
	name,
	recording,
}: {
	name: string;
	recording?: boolean;
}) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton className="h-8">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Mic01Icon}
				/>
				<span className="min-w-0 flex-1 truncate">{name}</span>
				{recording ? (
					<span className="size-2 shrink-0 animate-pulse rounded-full bg-red-500" />
				) : null}
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

/** The compact node-selector pill shown in the live header's top row
 *  (`NodeSelector mode="compact-dropdown"`): a status dot + node name + chevron. */
function NodeSelectorPill() {
	return (
		<span className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-xs">
			<span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
			<span className="text-foreground">Local</span>
			<HugeiconsIcon
				className="size-3 text-muted-foreground"
				icon={ArrowDown01Icon}
			/>
		</span>
	);
}

/** A header nav item the showcase can drive to switch the inset content. */
export interface ShellNavItem {
	icon: typeof Store01Icon;
	id: string;
	label: string;
	shortcut?: string;
}

/** The Ryu desktop window: the real floating sidebar + main content inset. */
export function DesktopShell({
	children,
	showChats = true,
	navItems,
	activeNav,
	onNavSelect,
}: {
	children: ReactNode;
	/** Kept for call-site compatibility; the real sidebar has no flat-nav highlight. */
	active?: string;
	showChats?: boolean;
	/** Override the header nav rows (the showcase uses this to drive view switching). */
	navItems?: ShellNavItem[];
	activeNav?: string;
	onNavSelect?: (id: string) => void;
}) {
	const header = navItems ?? [
		{ id: "new-chat", label: "New chat", icon: PencilEdit01Icon },
		{ id: "search", label: "Search", icon: Search01Icon, shortcut: "Ctrl K" },
		{ id: "store", label: "Store", icon: Store01Icon },
		{ id: "timeline", label: "Timeline", icon: Activity01Icon },
		{ id: "calendar", label: "Calendar", icon: Calendar03Icon },
	];
	return (
		<SidebarProvider className="size-full min-h-0">
			<Sidebar
				className="h-full bg-transparent p-2"
				collapsible="none"
				variant="floating"
			>
				{/* The floating panel: mirrors the primitive's `sidebar-inner` so this
				    reads as `variant="floating"` despite `collapsible="none"`. */}
				<div className="ryu-chrome-shadow inset-shadow-sm flex size-full flex-col rounded-3xl border border-background bg-sidebar drop-shadow-2xl dark:bg-sidebar/50">
					<SidebarHeader className="pt-3 pb-0">
						<div className="flex items-center gap-2 px-2 pb-1">
							<RyuLogo
								className="shrink-0 text-foreground"
								size="20px"
								variant="outline"
							/>
							<NodeSelectorPill />
						</div>
						<SidebarMenu>
							{header.map((item) => (
								<NavButton
									active={activeNav === item.id}
									icon={item.icon}
									key={item.id}
									label={item.label}
									onClick={onNavSelect ? () => onNavSelect(item.id) : undefined}
									shortcut={item.shortcut}
								/>
							))}
						</SidebarMenu>
					</SidebarHeader>

					<SidebarContent className="scroll-fade-effect-y pt-2">
						<Section label="Agents">
							{AGENTS.map((name) => (
								<LogoRow key={name} name={name} />
							))}
						</Section>
						<Section label="Teams">
							{TEAMS.map((name) => (
								<IconRow icon={UserGroupIcon} key={name} name={name} />
							))}
						</Section>
						<Section label="Spaces">
							{SPACES.map((name) => (
								<IconRow icon={LibraryIcon} key={name} name={name} />
							))}
						</Section>
						<Section label="Meetings">
							{MEETINGS.map((m) => (
								<MeetingRow
									key={m.name}
									name={m.name}
									recording={m.recording}
								/>
							))}
						</Section>
						<Section label="Workflows">
							{WORKFLOWS.map((name) => (
								<IconRow icon={WorkflowSquare01Icon} key={name} name={name} />
							))}
						</Section>
						{showChats ? (
							<Section label="Chats">
								{RECENT_CHATS.map((c) => (
									<SidebarMenuItem key={c}>
										<SidebarMenuButton className="h-8">
											<span className="truncate text-sidebar-foreground/80">
												{c}
											</span>
										</SidebarMenuButton>
									</SidebarMenuItem>
								))}
							</Section>
						) : null}
					</SidebarContent>

					<SidebarFooter>
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton className="h-11 gap-2">
									<Avatar className="size-7">
										<AvatarFallback>JW</AvatarFallback>
									</Avatar>
									<div className="flex min-w-0 flex-col text-left leading-tight">
										<span className="truncate font-medium text-sm">
											Jia Wei
										</span>
										<span className="truncate text-muted-foreground text-xs">
											Pro plan
										</span>
									</div>
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarFooter>
				</div>
			</Sidebar>

			<SidebarInset className="min-w-0 overflow-hidden">
				{children}
			</SidebarInset>
		</SidebarProvider>
	);
}
