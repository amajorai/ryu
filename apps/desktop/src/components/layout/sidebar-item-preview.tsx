"use client";

import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ReactNode, useRef, useState } from "react";

const SIDEBAR_PREVIEW_BOUNDARY_SELECTOR = "[data-sidebar-preview-boundary]";

/**
 * Shared sidebar-row preview: always shows on hover (unlike OverflowTooltip,
 * which only appears when text overflows). Caps width so titles wrap
 * consistently; plugins and built-in rows share this chrome.
 */
export function SidebarItemPreview({
	children,
	content,
	className,
	spacing,
	renderContent,
	side = "right",
	sideOffset = 14,
}: {
	children: ReactNode;
	content: ReactNode;
	className?: string;
	spacing?: "conversation-preview";
	/** Render optional expensive content only after the hover card opens. */
	renderContent?: (open: boolean) => ReactNode;
	side?: "top" | "bottom" | "left" | "right" | "inline-start" | "inline-end";
	sideOffset?: number;
}) {
	const triggerRef = useRef<HTMLAnchorElement>(null);
	const [open, setOpen] = useState(false);
	const getPreviewAnchor = () => {
		const trigger = triggerRef.current;
		if (!trigger) {
			return null;
		}

		const boundary = trigger.closest<HTMLElement>(
			SIDEBAR_PREVIEW_BOUNDARY_SELECTOR
		);
		if (!boundary) {
			return trigger;
		}

		return {
			contextElement: trigger,
			getBoundingClientRect: () => {
				const triggerRect = trigger.getBoundingClientRect();
				const boundaryRect = boundary.getBoundingClientRect();
				return DOMRect.fromRect({
					height: triggerRect.height,
					width: 0,
					x: boundaryRect.right,
					y: triggerRect.top,
				});
			},
		};
	};

	return (
		<HoverCard onOpenChange={setOpen}>
			<HoverCardTrigger
				className="min-w-0 flex-1"
				closeDelay={0}
				delay={0}
				ref={triggerRef}
			>
				{children}
			</HoverCardTrigger>
			<HoverCardContent
				align="start"
				alignOffset={0}
				anchor={getPreviewAnchor}
				appearance="sidebar-preview"
				className={cn(className)}
				side={side}
				sideOffset={sideOffset}
				spacing={spacing}
			>
				{content}
				{renderContent ? renderContent(open) : null}
			</HoverCardContent>
		</HoverCard>
	);
}

/** Title block used by chat / plugin sidebar previews — wraps the full name. */
export function SidebarPreviewTitle({
	title,
	children,
}: {
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<p
				className="wrap-break-word font-medium text-sm leading-snug"
				data-ryu-i18n="off"
			>
				{title}
			</p>
			{children}
		</div>
	);
}

/** Compact metadata row (branch, worktree, agents, …). */
export function SidebarPreviewMeta({
	label,
	value,
	wrap = false,
}: {
	label: string;
	value: ReactNode;
	/**
	 * Wrap the value over several lines instead of end-truncating it. For a
	 * filesystem path the tail IS the useful half — end-truncation hides the leaf
	 * and leaves only the shared prefix every row already has in common, which is
	 * the exact reason the leaf-only version of this row was useless.
	 */
	wrap?: boolean;
}) {
	if (value === null || value === undefined || value === "") {
		return null;
	}
	return (
		<div
			className={`flex min-w-0 gap-2 text-xs ${wrap ? "items-start" : "items-baseline"}`}
		>
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span
				className={`min-w-0 text-foreground/90 ${wrap ? "wrap-anywhere" : "truncate"}`}
			>
				{value}
			</span>
		</div>
	);
}

/** Past titles for a chat (auto-rename history), oldest → newest. */
export function SidebarPreviewTitleHistory({
	entries,
}: {
	entries: Array<{ source: string; title: string }>;
}) {
	if (entries.length <= 1) {
		return null;
	}
	const prior = entries.slice(0, -1);
	return (
		<div className="flex flex-col gap-1 border-border/60 border-t pt-2">
			<p className="type-caption text-muted-foreground uppercase tracking-wide">
				Title history
			</p>
			<ul className="flex flex-col gap-0.5">
				{prior.map((entry, index) => (
					<li
						className="wrap-break-word text-muted-foreground text-xs leading-snug"
						key={`${entry.source}-${index}-${entry.title}`}
					>
						<span className="text-muted-foreground/70">
							{entry.source === "user"
								? "Renamed"
								: entry.source === "auto"
									? "Auto"
									: "First"}
							:{" "}
						</span>
						{entry.title}
					</li>
				))}
			</ul>
		</div>
	);
}
