"use client";
import {
	Add01Icon,
	ArrowDown01Icon,
	type LibraryIcon,
	Mic01Icon,
	type Store01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar";
import type { ReactNode } from "react";

/** A reorderable header nav button, mirroring the live sidebar's chrome row. */
export function NavButton({
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
export function Section({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<SidebarGroup className="group/section" spacing="compact">
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
				<SidebarMenu>{children}</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	);
}

export function LogoRow({ name }: { name: string }) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton className="h-8">
				<RyuLogo
					className="shrink-0"
					size="16px"
					tone="foreground"
					variant="outline"
				/>
				<span className="truncate">{name}</span>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

export function IconRow({
	icon,
	name,
}: {
	icon: typeof LibraryIcon;
	name: string;
}) {
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
export function MeetingRow({
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
					<>
						<span
							aria-hidden="true"
							className="size-2 shrink-0 rounded-full bg-destructive motion-safe:animate-pulse"
						/>
						<span className="sr-only">Recording</span>
					</>
				) : null}
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}
