"use client";

import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/** The placements shared by the Desktop assistant and embeddable consumers. */
export type AssistantWidgetPlacement = "docked" | "floating" | "inline";

export interface RyuAssistantWidgetFrameProps {
	/** Accessible name for the surface. */
	ariaLabel?: string;
	children: ReactNode;
	className?: string;
	placement?: AssistantWidgetPlacement;
}

/**
 * Layout-only frame for an assistant surface. It deliberately owns geometry and
 * semantics, not transport or application state, so the same frame can hold
 * `RyuAssistantChat`, a custom chat renderer, or an iframe.
 */
export function RyuAssistantWidgetFrame({
	ariaLabel,
	children,
	className,
	placement = "inline",
}: RyuAssistantWidgetFrameProps) {
	const isDocked = placement === "docked";
	const Component = isDocked ? "aside" : "div";
	return (
		<Component
			aria-label={ariaLabel}
			className={cn(
				"flex min-h-0 flex-col",
				placement !== "inline" && "h-full",
				placement !== "docked" && "w-full",
				className
			)}
			data-lenis-prevent=""
			data-placement={placement}
			data-ryu-assistant-widget="true"
			role={!isDocked && ariaLabel ? "region" : undefined}
		>
			{children}
		</Component>
	);
}

export interface RyuAssistantWidgetHeaderProps {
	actions?: ReactNode;
	className?: string;
	closeLabel?: string;
	closeTitle?: string;
	/** Add a divider under the header, as used by the docked Desktop panel. */
	divider?: boolean;
	onClose?: () => void;
	testId?: string;
	title: ReactNode;
}

/** Shared quiet title row for floating, docked, and inline assistant surfaces. */
export function RyuAssistantWidgetHeader({
	actions,
	className,
	closeLabel = "Close assistant",
	closeTitle,
	divider = false,
	onClose,
	testId,
	title,
}: RyuAssistantWidgetHeaderProps) {
	return (
		<header
			className={cn(
				"flex shrink-0 items-center gap-1.5 px-3 py-2",
				divider && "border-border/60 border-b",
				className
			)}
			data-tauri-drag-region={false}
			data-testid={testId}
		>
			<span className="min-w-0 flex-1 truncate font-medium text-sm">
				{title}
			</span>
			<div className="flex items-center gap-0.5">
				{actions}
				{onClose ? (
					<Button
						aria-label={closeLabel}
						className="size-7"
						onClick={onClose}
						size="icon"
						title={closeTitle}
						variant="ghost"
					>
						<X className="size-3.5" />
					</Button>
				) : null}
			</div>
		</header>
	);
}

export interface RyuAssistantRecentChat {
	id: string;
	meta?: ReactNode;
	title: string;
}

/** A small, host-neutral recent-chat list for compact assistant surfaces. */
export function RyuAssistantRecentChats({
	items,
	label = "Recent chats",
	onSelect,
}: {
	items: readonly RyuAssistantRecentChat[];
	label?: string;
	onSelect: (id: string) => void;
}) {
	if (items.length === 0) {
		return null;
	}
	return (
		<section
			className="shrink-0 px-4 pb-2"
			data-testid="ryu-assistant-recent-chats"
		>
			<p className="mb-2 text-muted-foreground text-xs">{label}</p>
			<div className="flex flex-col">
				{items.slice(0, 4).map((item) => (
					<button
						className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent"
						key={item.id}
						onClick={() => onSelect(item.id)}
						type="button"
					>
						<span className="min-w-0 flex-1 truncate text-foreground/85">
							{item.title}
						</span>
						{item.meta ? (
							<span className="shrink-0 text-muted-foreground/70 text-xs">
								{item.meta}
							</span>
						) : null}
					</button>
				))}
			</div>
		</section>
	);
}
