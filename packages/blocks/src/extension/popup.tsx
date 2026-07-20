"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@ryu/ui/components/avatar";
import { Button } from "@ryu/ui/components/button";
import {
	ArrowUpRight,
	MessageSquare,
	Send,
	Server,
	Settings,
} from "lucide-react";
import type { ReactNode } from "react";

export type PopupCoreStatus = "running" | "starting" | "stopped";

export interface PopupRecent {
	id: string;
	subtitle: string;
	title: string;
}

export interface PopupUser {
	email?: string | null;
	image?: string | null;
	name?: string | null;
}

const QUICK_LINKS = [
	{ path: "/chat", icon: MessageSquare, label: "Chat" },
	{ path: "/services", icon: Server, label: "Services" },
	{ path: "/settings", icon: Settings, label: "Settings" },
] as const;

const STATUS_META: Record<PopupCoreStatus, { color: string; label: string }> = {
	running: { color: "bg-emerald-500", label: "Running" },
	starting: { color: "bg-amber-500", label: "Starting" },
	stopped: { color: "bg-red-500", label: "Stopped" },
};

function initialsFor(user: PopupUser): string {
	if (user.name) {
		return user.name
			.split(" ")
			.map((n) => n[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);
	}
	return user.email?.[0]?.toUpperCase() ?? "?";
}

export interface ExtensionPopupProps {
	coreStatus?: PopupCoreStatus;
	onOpen?: (path: string) => void;
	onQuickMessageChange?: (value: string) => void;
	onSubmitQuickChat?: () => void;
	quickMessage?: string;
	recents?: PopupRecent[];
	user?: PopupUser | null;
	/** Renders the per-user dropdown trigger; live extension injects the real menu. */
	userMenu?: ReactNode;
}

/**
 * The toolbar popup body, presentational. Every browser-backed input (core
 * status, the signed-in user, recents, handlers) is an optional prop with a
 * safe static default so the block renders standalone in the storyboard while
 * the live popup injects the real session and node data.
 */
export function ExtensionPopup({
	coreStatus = "running",
	quickMessage = "",
	recents = [],
	user = null,
	userMenu,
	onQuickMessageChange,
	onSubmitQuickChat,
	onOpen,
}: ExtensionPopupProps) {
	// Fall through to the stopped state for any unexpected value, mirroring the
	// original popup's defensive ternary.
	const status = STATUS_META[coreStatus] ?? STATUS_META.stopped;
	const canSend = quickMessage.trim().length > 0;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between border-border border-b px-4 py-3">
				<div className="flex items-center gap-2.5">
					<span className="flex size-6 items-center justify-center rounded-md bg-primary font-bold text-primary-foreground text-xs">
						R
					</span>
					<span className="font-heading font-semibold text-sm tracking-tight">
						Ryu
					</span>
				</div>
				<div className="flex items-center gap-1.5">
					<span className={`size-2 rounded-full ${status.color}`} />
					<span className="text-[11px] text-muted-foreground">
						{status.label}
					</span>
				</div>
			</div>

			<div className="border-border border-b px-4 py-3">
				<form
					className="flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						onSubmitQuickChat?.();
					}}
				>
					<input
						className="flex-1 rounded-md border bg-muted/50 px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
						onChange={(e) => onQuickMessageChange?.(e.target.value)}
						placeholder="Ask Ryu something…"
						type="text"
						value={quickMessage}
					/>
					<Button
						className="size-8 shrink-0"
						disabled={!canSend}
						size="icon"
						type="submit"
						variant="ghost"
					>
						<Send className="size-3.5" />
					</Button>
				</form>
			</div>

			<div className="grid grid-cols-4 gap-1 border-border border-b px-4 py-3">
				{QUICK_LINKS.map(({ path, icon: Icon, label }) => (
					<button
						className="flex flex-col items-center gap-1 rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						key={path}
						onClick={() => onOpen?.(path)}
						type="button"
					>
						<Icon className="size-4" />
						<span className="font-medium text-[10px]">{label}</span>
					</button>
				))}
			</div>

			<div className="flex-1 overflow-y-auto">
				<div className="px-4 pt-3 pb-1.5">
					<span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
						Recent
					</span>
				</div>
				{recents.length === 0 ? (
					<div className="px-4 py-6 text-center text-muted-foreground text-xs">
						No conversations yet
					</div>
				) : (
					<div className="px-2 pb-2">
						{recents.map((conv) => (
							<button
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
								key={conv.id}
								onClick={() => onOpen?.("/chat")}
								type="button"
							>
								<MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<div className="truncate font-medium text-xs">
										{conv.title}
									</div>
									<div className="truncate text-[10px] text-muted-foreground">
										{conv.subtitle}
									</div>
								</div>
							</button>
						))}
					</div>
				)}
			</div>

			<div className="border-border border-t px-4 py-2.5">
				<Button
					className="w-full gap-1.5"
					onClick={() => onOpen?.("/chat")}
					size="sm"
					variant="default"
				>
					Open Ryu
					<ArrowUpRight className="size-3.5" />
				</Button>
			</div>

			{user ? (
				<div className="flex items-center gap-2 border-border border-t px-4 py-2.5">
					<Avatar className="size-6 rounded-md">
						<AvatarImage alt={user.name ?? ""} src={user.image ?? undefined} />
						<AvatarFallback className="rounded-md text-[10px]">
							{initialsFor(user)}
						</AvatarFallback>
					</Avatar>
					<span className="flex-1 truncate font-medium text-xs">
						{user.name ?? user.email}
					</span>
					{userMenu ?? (
						<Button className="size-7" size="icon" variant="ghost">
							<Settings className="size-3.5" />
						</Button>
					)}
				</div>
			) : null}
		</div>
	);
}
