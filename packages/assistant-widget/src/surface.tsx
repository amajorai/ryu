"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
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

/**
 * Shared quiet title row for floating, docked, and inline assistant surfaces: an
 * `h-10` pane header with `icon-sm` actions. Hosts pass at most two action icons;
 * the close button is the third.
 */
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
				"flex h-10 shrink-0 items-center gap-2 px-4",
				divider && "border-border border-b",
				className
			)}
			data-tauri-drag-region={false}
			data-testid={testId}
		>
			<span className="min-w-0 flex-1 truncate font-medium text-sm">
				{title}
			</span>
			<div className="-me-2 flex items-center gap-1">
				{actions}
				{onClose ? (
					<Button
						aria-label={closeLabel}
						onClick={onClose}
						size="icon-sm"
						title={closeTitle ?? closeLabel}
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
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
			className="shrink-0 px-2 pt-6 pb-2"
			data-testid="ryu-assistant-recent-chats"
		>
			<p className="flex h-7 items-center px-2 text-detail text-muted-foreground">
				{label}
			</p>
			<div className="flex flex-col">
				{items.slice(0, 4).map((item) => (
					<button
						className="flex h-8 min-w-0 items-center gap-3 rounded-lg px-2 text-left text-sm outline-none transition-colors duration-(--duration-fast) hover:bg-foreground/10 focus-visible:bg-foreground/10"
						key={item.id}
						onClick={() => onSelect(item.id)}
						type="button"
					>
						<span className="min-w-0 flex-1 truncate text-foreground">
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
