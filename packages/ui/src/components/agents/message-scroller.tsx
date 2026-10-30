"use client";

// beui.dev/components/agents/message-scroller

import { ArrowDown02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { PreviewRail } from "@ryu/ui/components/motion/preview-rail.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useMessageScrollerFollow } from "./message-scroller-follow.ts";
import type { MessageScrollerProps } from "./message-scroller-props.ts";
import { CollapsedMessageRail } from "./message-scroller-rail.tsx";
import { useMessageScrollerRail } from "./message-scroller-rail-sync.ts";
import type { MessageScrollerScope } from "./message-scroller-scope.ts";
import { useMessageScrollerViewport } from "./message-scroller-viewport.tsx";

export type { MessageScrollerProps } from "./message-scroller-props.ts";

export function MessageScroller(componentProps: MessageScrollerProps) {
	const {
		followOutput = true,
		followThreshold = 56,
		smooth = true,
		onFollowChange,
		showScrollToLatest = true,
		showUnreadMessages = true,
		label = "Conversation",
		busy,
		navigation,
		railItems: externalRailItems,
		renderPreview,
		navigationLabel = "Message navigation",
		viewportClassName,
		contentClassName,
		contentInset = "default",
		contentSpacing = "default",
		railClassName,
		viewportRef: externalViewportRef,
		viewportProps,
		contentProps,
		className,
		children,
		...props
	} = componentProps;
	const tl = useLiteralMessages();
	// Each hook reads only bindings that earlier hooks already assigned.
	const scope = {
		...componentProps,
		followOutput,
		followThreshold,
		smooth,
		showScrollToLatest,
		showUnreadMessages,
		label,
		navigationLabel,
		contentInset,
		contentSpacing,
		props,
	} as MessageScrollerScope;
	Object.assign(scope, useMessageScrollerRail(scope));
	Object.assign(scope, useMessageScrollerFollow(scope));
	Object.assign(scope, useMessageScrollerViewport(scope));
	const {
		activeRailId,
		railCollapsed,
		railOverflowing,
		railItems,
		scrollToRailItem,
		viewport,
		following,
		newMessageCount,
		scrollToEnd,
		reduce,
	} = scope;
	return (
		<div
			className={cn("relative min-h-0", className)}
			data-slot="message-scroller"
			{...props}
		>
			{navigation === "rail" ? (
				<PreviewRail
					activeId={activeRailId}
					className="h-full min-h-0 overflow-hidden"
					highlightActive
					itemSize={14}
					items={railCollapsed ? [] : railOverflowing ? railItems : []}
					label={navigationLabel}
					onItemSelect={scrollToRailItem}
					previewClassName={
						renderPreview
							? "ml-1 w-72 max-w-full"
							: "ml-1 w-64 max-w-full [&_[data-slot=preview-rail-card]]:h-20 [&_[data-slot=preview-rail-card]]:overflow-hidden [&_[data-slot=preview-rail-card]]:p-3 [&_[data-slot=preview-rail-title]]:line-clamp-1 [&_[data-slot=preview-rail-title]]:text-xs [&_[data-slot=preview-rail-title]]:leading-4 [&_[data-slot=preview-rail-description]]:line-clamp-2 [&_[data-slot=preview-rail-description]]:text-xs [&_[data-slot=preview-rail-description]]:leading-4"
					}
					previewContainerClassName="right-3 left-8"
					previewSide="after"
					railClassName={cn(
						"absolute inset-y-3 left-1 w-7 content-center py-1 [&_[data-slot=preview-rail-item]]:w-7 [&_[data-slot=preview-rail-item]]:justify-start [&_[data-slot=preview-rail-tick]]:h-px [&_[data-slot=preview-rail-tick]]:w-4 [&_[data-slot=preview-rail-tick]]:origin-left",
						railOverflowing
							? "pointer-events-auto opacity-100"
							: "pointer-events-none opacity-0",
						railClassName
					)}
					renderPreview={renderPreview}
					showPreview={!railCollapsed}
				>
					{viewport}
					{railCollapsed ? (
						<CollapsedMessageRail
							activeId={activeRailId}
							items={railItems}
							onItemSelect={scrollToRailItem}
						/>
					) : null}
				</PreviewRail>
			) : (
				viewport
			)}
			{showScrollToLatest && !following ? (
				<Button
					aria-label={
						newMessageCount > 0
							? tl("{count} new messages. Scroll to latest", {
									count: String(newMessageCount),
								})
							: "Scroll to latest message"
					}
					className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2 gap-1.5 rounded-full border border-primary/30 bg-background/95 px-3 shadow-lg backdrop-blur-md"
					data-new-message-count={newMessageCount}
					data-slot="message-scroll-to-bottom"
					onClick={() => scrollToEnd(reduce || !smooth ? "auto" : "smooth")}
					size="sm"
					variant="secondary"
				>
					<HugeiconsIcon icon={ArrowDown02Icon} size={15} strokeWidth={2} />
					<span>
						{newMessageCount > 0
							? tl("{count} new messages", {
									count: newMessageCount > 99 ? "99+" : String(newMessageCount),
								})
							: "Latest messages"}
					</span>
				</Button>
			) : null}
		</div>
	);
}
