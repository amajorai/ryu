"use client";

import {
	ArrowDown01Icon,
	BubbleChatIcon,
	Folder01Icon,
	FolderOpenIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { EntityAvatar } from "@ryu/ui/components/entity-avatar.tsx";
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarMenu,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import type { Phase } from "./hierarchy-desktop-demo-data.ts";

/** The messaging-style row every sidebar entity uses on the desktop. */
export function MessagingRow({
	active,
	avatar,
	name,
	preview,
	running,
	stamp,
	badge,
}: {
	active?: boolean;
	avatar: ReactNode;
	badge?: string;
	name: string;
	preview: string;
	running?: boolean;
	stamp: string;
}) {
	return (
		<SidebarMenuItem>
			<div
				className={cn(
					"flex min-h-14 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
					active ? "bg-muted" : "hover:bg-muted"
				)}
			>
				{avatar}
				<span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
					<span className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-sm">{name}</span>
						{running ? (
							<span
								aria-label="A session is running"
								className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground/80"
								role="img"
							/>
						) : (
							<span className="type-compact shrink-0 text-muted-foreground tabular-nums">
								{stamp}
							</span>
						)}
					</span>
					<span className="flex min-w-0 items-center gap-1.5">
						<span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
							{preview}
						</span>
						{badge ? (
							<span className="type-compact shrink-0 rounded-full bg-muted px-1.5 py-px text-muted-foreground">
								{badge}
							</span>
						) : null}
					</span>
				</span>
			</div>
		</SidebarMenuItem>
	);
}

export function GlyphAvatar({ emoji, tone }: { emoji: string; tone: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-9 shrink-0 items-center justify-center rounded-full text-base",
				tone
			)}
		>
			{emoji}
		</span>
	);
}

export function GroupAvatar({ names }: { names: string[] }) {
	return (
		<span aria-hidden="true" className="relative size-9 shrink-0">
			{names.slice(0, 2).map((name, index) => (
				<span
					className={cn(
						"absolute size-6 rounded-full ring-2 ring-sidebar",
						index === 0 ? "top-0 left-0" : "right-0 bottom-0"
					)}
					key={name}
				>
					<EntityAvatar className="size-6" name={name} />
				</span>
			))}
		</span>
	);
}

/** A sub-section header inside "Projects & chats", like the desktop's SubSection. */
export function SubSectionLabel({
	icon,
	label,
	count,
}: {
	count: number;
	icon: typeof Folder01Icon;
	label: string;
}) {
	return (
		<div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-muted-foreground text-xs">
			<HugeiconsIcon className="size-3.5" icon={icon} />
			<span>{label}</span>
			<span className="text-muted-foreground/60 tabular-nums">{count}</span>
		</div>
	);
}

export function SectionHeader({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-xs">
			<span>{label}</span>
			<HugeiconsIcon className="-ml-1 size-3" icon={ArrowDown01Icon} />
		</div>
	);
}

export function DemoSidebar({ phase, view }: { phase: Phase; view: string }) {
	const projectRunning = phase > 0 && phase < 4;
	return (
		<div className="flex flex-col" data-testid="hierarchy-demo-sidebar">
			<SidebarGroup spacing="compact">
				<SectionHeader label="Bots" />
				<SidebarGroupContent>
					<SidebarMenu>
						<MessagingRow
							avatar={<EntityAvatar className="size-9 shrink-0" name="Ryu" />}
							name="Ryu"
							preview="Your week is clear after 3pm"
							stamp="9:41"
						/>
						<MessagingRow
							avatar={<EntityAvatar className="size-9 shrink-0" name="Scout" />}
							name="Scout"
							preview="Pricing page reviewed"
							stamp="9:12"
						/>
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>
			<SidebarGroup spacing="compact">
				<SectionHeader label="Projects & chats" />
				<SidebarGroupContent>
					<SubSectionLabel count={2} icon={Folder01Icon} label="Projects" />
					<SidebarMenu>
						<MessagingRow
							active={view === "project"}
							avatar={<GlyphAvatar emoji="🚀" tone="bg-primary/10" />}
							name="Product launch"
							preview={
								phase >= 4
									? "Coordinator: all three sessions are done"
									: "Coordinator: delegating to 3 sessions"
							}
							running={projectRunning}
							stamp="Now"
						/>
						<MessagingRow
							avatar={<GlyphAvatar emoji="🔬" tone="bg-success/10" />}
							name="Q4 research"
							preview="Analyst: competitor table updated"
							stamp="Tue"
						/>
					</SidebarMenu>
					<SubSectionLabel count={2} icon={BubbleChatIcon} label="Chats" />
					<SidebarMenu>
						<MessagingRow
							avatar={<GroupAvatar names={["Reviewer", "Critic"]} />}
							badge="Debate"
							name="Reviewers"
							preview="Critic: tighten the second paragraph"
							stamp="Mon"
						/>
						<MessagingRow
							avatar={<EntityAvatar className="size-9 shrink-0" name="Ana" />}
							name="Ana"
							preview="You: shipping Friday 🎉"
							stamp="Sun"
						/>
					</SidebarMenu>
					<SubSectionLabel
						count={1}
						icon={FolderOpenIcon}
						label="Launch week"
					/>
					<SidebarMenu>
						<MessagingRow
							avatar={<GlyphAvatar emoji="📰" tone="bg-warning/10" />}
							name="Press kit"
							preview="Writer: embargo notes drafted"
							stamp="Sat"
						/>
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>
		</div>
	);
}
