"use client";
import { cn } from "@ryu/ui/lib/utils.ts";
import styles from "./shell.module.css";

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
	ArrowDown01Icon,
	Calendar03Icon,
	LibraryIcon,
	PencilEdit01Icon,
	Search01Icon,
	Store01Icon,
	UserMultiple02Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Avatar, AvatarFallback } from "@ryu/ui/components/avatar";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
} from "@ryu/ui/components/sidebar";
import type { ReactNode } from "react";
import {
	IconRow,
	LogoRow,
	MeetingRow,
	NavButton,
	Section,
} from "./shell-rows.tsx";
import {
	BotModeSidebarContent,
	TrustModeSidebarContent,
} from "./shell-sidebar-modes.tsx";

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

/** The compact node-selector pill shown in the live header's top row
 *  (`NodeSelector mode="compact-dropdown"`): a status dot + node name + chevron. */
function NodeSelectorPill() {
	return (
		<span className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-xs">
			<span className="size-1.5 shrink-0 rounded-full bg-success" />
			<span className="text-foreground">Your computer</span>
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
	sidebarMode = "default",
	navItems,
	activeNav,
	onNavSelect,
	sidebarContent,
}: {
	children: ReactNode;
	/** Replace the sidebar's section list (the landing demos supply their own). */
	sidebarContent?: ReactNode;
	/** Kept for call-site compatibility; the real sidebar has no flat-nav highlight. */
	active?: string;
	sidebarMode?: "default" | "bot" | "trust";
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
				appearance="showcase-frame"
				className="h-full"
				collapsible="none"
				variant="floating"
			>
				{/* The floating panel: mirrors the primitive's `sidebar-inner` so this
				    reads as `variant="floating"` despite `collapsible="none"`. */}
				<div
					className={cn(
						styles.chromeShadow,
						"inset-shadow-sm flex size-full flex-col rounded-3xl border border-background bg-sidebar drop-shadow-2xl dark:bg-sidebar/50"
					)}
				>
					<SidebarHeader spacing="showcase">
						<div className="flex items-center gap-2 px-2 pb-1">
							<RyuLogo
								className="shrink-0"
								size="20px"
								tone="foreground"
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

					<SidebarContent spacing="compact">
						{sidebarContent ? (
							<div className="scroll-fade no-scrollbar min-h-0 flex-1 overflow-auto px-2">
								{sidebarContent}
							</div>
						) : sidebarMode === "bot" ? (
							<BotModeSidebarContent />
						) : sidebarMode === "trust" ? (
							<TrustModeSidebarContent />
						) : (
							<>
								<Section label="Agents">
									{AGENTS.map((name) => (
										<LogoRow key={name} name={name} />
									))}
								</Section>
								<Section label="Teams">
									{TEAMS.map((name) => (
										<IconRow icon={UserMultiple02Icon} key={name} name={name} />
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
										<IconRow
											icon={WorkflowCircle06Icon}
											key={name}
											name={name}
										/>
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
							</>
						)}
					</SidebarContent>

					<SidebarFooter>
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton className="h-11">
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
