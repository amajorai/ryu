"use client";

import {
	ArrowUp02Icon,
	ArrowUpRight01Icon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
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

const STATUS_META = {
	running: { color: "bg-success", label: "Running" },
	starting: { color: "bg-warning", label: "Starting" },
	stopped: { color: "bg-destructive", label: "Stopped" },
} satisfies Record<PopupCoreStatus, { color: string; label: string }>;

/** Most recents the popup lists under its page actions. */
const MAX_RECENTS = 5;

export interface ExtensionPopupProps {
	coreStatus?: PopupCoreStatus;
	/** Renders the compact per-surface model picker supplied by the extension. */
	modelPicker?: ReactNode;
	onOpen?: (path: string, conversationId?: string) => void;
	onQuickMessageChange?: (value: string) => void;
	onSubmitQuickChat?: () => void;
	/**
	 * Page actions for the active tab, rendered as the first rows of the
	 * scrolling list (use {@link PopupRow}). They scroll with the recents, so
	 * nothing is clipped by the fixed popup height.
	 */
	pageActions?: ReactNode;
	quickMessage?: string;
	recents?: PopupRecent[];
	user?: PopupUser | null;
	/** Renders the per-user dropdown trigger; live extension injects the real menu. */
	userMenu?: ReactNode;
}

export interface PopupRowProps {
	disabled?: boolean;
	icon?: ReactNode;
	label: ReactNode;
	meta?: ReactNode;
	onClick?: () => void;
	title?: string;
}

/** One `h-8` list row: muted icon, label and optional trailing meta. */
export function PopupRow({
	disabled,
	icon,
	label,
	meta,
	onClick,
	title,
}: PopupRowProps) {
	return (
		<button
			aria-busy={disabled || undefined}
			className="group/row flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-150 hover:bg-muted hover:duration-0 focus-visible:bg-accent focus-visible:outline-none disabled:opacity-50"
			disabled={disabled}
			onClick={onClick}
			title={title}
			type="button"
		>
			{icon ? (
				<span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground group-hover/row:text-foreground">
					{icon}
				</span>
			) : null}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{meta ? (
				<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
					{meta}
				</span>
			) : null}
		</button>
	);
}

/**
 * The toolbar popup body, presentational, in three zones: an `h-10` header
 * with the status dot, the composer as the hero, and one scrolling list of
 * page actions plus recent chats. Every browser-backed input is an optional
 * prop with a safe default so the block renders standalone in the storyboard.
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
	modelPicker,
	pageActions,
}: ExtensionPopupProps) {
	// Fall through to the stopped state for any unexpected value, mirroring the
	// original popup's defensive ternary.
	const status = STATUS_META[coreStatus] ?? STATUS_META.stopped;
	const canSend = quickMessage.trim().length > 0;
	const shownRecents = recents.slice(0, MAX_RECENTS);

	return (
		<div className="flex h-full flex-col bg-background text-foreground">
			<header className="flex h-10 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
				<div className="flex min-w-0 items-center gap-2">
					<span
						aria-hidden="true"
						className={cn("size-1.5 shrink-0 rounded-full", status.color)}
						title={status.label}
					/>
					<span className="font-medium text-sm">Ryu</span>
					<span className="sr-only" role="status">
						{status.label}
					</span>
				</div>
				<div className="flex items-center gap-1">
					<Button
						aria-label="Open Ryu"
						onClick={() => onOpen?.("/chat")}
						size="icon-sm"
						title="Open Ryu"
						variant="ghost-muted"
					>
						<HugeiconsIcon icon={ArrowUpRight01Icon} size={16} />
					</Button>
					{user
						? (userMenu ?? (
								<Button
									aria-label="Account settings"
									size="icon-sm"
									variant="ghost-muted"
								>
									<HugeiconsIcon icon={Settings01Icon} size={16} />
								</Button>
							))
						: null}
				</div>
			</header>

			<div className="shrink-0 px-4 pt-1 pb-3">
				<form
					className="flex flex-col gap-1 rounded-3xl border border-border bg-background px-3 py-2 shadow-xs focus-within:border-ring/50 dark:bg-card"
					onSubmit={(e) => {
						e.preventDefault();
						onSubmitQuickChat?.();
					}}
				>
					<input
						aria-label="Message Ryu"
						className="h-10 min-w-0 bg-transparent px-1 text-comfortable caret-foreground outline-none placeholder:text-muted-foreground"
						onChange={(e) => onQuickMessageChange?.(e.target.value)}
						placeholder="Ask Ryu something…"
						type="text"
						value={quickMessage}
					/>
					<div className="flex items-center justify-between gap-2">
						<div className="min-w-0">{modelPicker}</div>
						<Button
							aria-label="Send message"
							className="disabled:opacity-30"
							disabled={!canSend}
							size="icon-sm"
							type="submit"
							variant="default"
						>
							<HugeiconsIcon icon={ArrowUp02Icon} size={16} />
						</Button>
					</div>
				</form>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
				{pageActions ? (
					<div className="flex flex-col">{pageActions}</div>
				) : null}
				{shownRecents.length > 0 ? (
					<section aria-label="Recent" className="mt-3 flex flex-col">
						<h2 className="flex h-7 items-center px-2 font-normal text-detail text-muted-foreground">
							Recent
						</h2>
						{shownRecents.map((conv) => (
							<PopupRow
								key={conv.id}
								label={conv.title}
								meta={conv.subtitle}
								onClick={() => onOpen?.("/chat", conv.id)}
								title={conv.title}
							/>
						))}
					</section>
				) : null}
			</div>
		</div>
	);
}
