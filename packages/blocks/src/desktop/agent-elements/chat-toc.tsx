"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import { cn } from "@ryu/ui/lib/utils";
import { motion, useReducedMotion } from "motion/react";
import { memo, type ReactNode, useEffect, useState } from "react";
import { FileTypeIcon } from "./file-type-icon.tsx";
import type { TranscriptScrollEvent } from "./utils/transcript-scroll-event.ts";

export interface ChatTocFileChange {
	/** Basename or relative path shown in the popover. */
	name: string;
	/** Optional add/remove summary (e.g. "+12 −3"). */
	stats?: string;
}

export interface ChatTocItem {
	/** Agent mark shown beside the reply. */
	agentAvatar?: ReactNode;
	agentName?: string;
	/** Assistant reply excerpt (description). */
	description?: string;
	/** Files touched in this turn; popover shows a short prefix. */
	files?: ChatTocFileChange[];
	id: string;
	/** User message (title). */
	title: string;
}

/** No tick is hovered — every line rests at its resting width. */
const NO_HOVER = -1;

const RESTING_WIDTH = 16;
const PEAK_WIDTH = 28;

/**
 * Line widths by distance from the hovered tick. The pointer lifts its own
 * marker to the peak and its neighbours partway there, so the rail ripples into
 * a pyramid instead of a single tick popping out on its own.
 */
const WIDTH_BY_DISTANCE = [PEAK_WIDTH, 24, 20] as const;

function getLineWidth(distance: number, isActive: boolean) {
	if (distance !== NO_HOVER) {
		return WIDTH_BY_DISTANCE[distance] ?? RESTING_WIDTH;
	}
	return isActive ? PEAK_WIDTH : RESTING_WIDTH;
}

const MAX_PREVIEW_FILES = 4;

/**
 * Notion-style table of contents for the chat. Renders one marker per user
 * message down the left gutter of the message list. Collapsed to bare lines by
 * default; hovering a marker opens a preview popover (user prompt, agent reply,
 * files changed). Clicking scrolls that turn into view.
 *
 * Scroll state is a PROP, not a hook: the message list owns the scroller and
 * hands `currentAnchorId` + `onScrollToMessage` down, so this stays
 * presentational and renderable in isolation.
 */
export const ChatToc = memo(function ChatToc({
	items,
	currentAnchorId,
	onScrollToMessage,
	className,
}: {
	items: ChatTocItem[];
	currentAnchorId?: string | null;
	onScrollToMessage?: (messageId: string) => void;
	className?: string;
}) {
	const tl = useLiteralMessages();
	const [hoveredIndex, setHoveredIndex] = useState(NO_HOVER);
	const reduceMotion = useReducedMotion();

	// Sidebar / deep-link jump: ChatPage dispatches this once messages hydrate.
	useEffect(() => {
		const onJump = (event: TranscriptScrollEvent) => {
			const messageId = event.detail?.messageId;
			if (messageId) {
				onScrollToMessage?.(messageId);
			}
		};
		window.addEventListener("ryu:scroll-to-message", onJump);
		return () => window.removeEventListener("ryu:scroll-to-message", onJump);
	}, [onScrollToMessage]);

	// Nothing worth navigating with a single turn.
	if (items.length < 2) {
		return null;
	}

	return (
		<nav
			aria-label="Message navigation"
			className={cn(
				"scroll-fade group/toc no-scrollbar pointer-events-auto absolute inset-s-2 top-1/2 z-20 hidden max-h-[70%] -translate-y-1/2 flex-col gap-2 overflow-y-auto py-2 lg:flex",
				className
			)}
			onMouseLeave={() => setHoveredIndex(NO_HOVER)}
		>
			{items.map((item, index) => {
				const isActive = item.id === currentAnchorId;
				const extraFiles = (item.files?.length ?? 0) - MAX_PREVIEW_FILES;
				const distance =
					hoveredIndex === NO_HOVER ? NO_HOVER : Math.abs(index - hoveredIndex);

				return (
					<HoverCard key={item.id}>
						<HoverCardTrigger
							appearance="chat-navigation"
							aria-current={isActive ? "true" : undefined}
							closeDelay={0}
							delay={0}
							onBlur={() => setHoveredIndex(NO_HOVER)}
							onClick={() => onScrollToMessage?.(item.id)}
							onFocus={() => setHoveredIndex(index)}
							onMouseEnter={() => setHoveredIndex(index)}
						>
							<motion.span
								animate={{ width: getLineWidth(distance, isActive) }}
								className="block h-px shrink-0 origin-left rounded-full bg-foreground/25 transition-colors group-hover/toc-item:bg-foreground group-hover/toc:bg-foreground/40 group-aria-[current=true]/toc-item:bg-foreground"
								initial={false}
								transition={
									reduceMotion
										? { duration: 0 }
										: { type: "spring", stiffness: 200, damping: 20 }
								}
							/>
							<span className="max-w-[220px] truncate whitespace-nowrap text-muted-foreground text-xs opacity-0 transition-opacity duration-200 group-hover/toc-item:text-foreground group-hover/toc:opacity-100 group-has-focus-visible/toc:opacity-100 group-aria-[current=true]/toc-item:text-foreground">
								{item.title}
							</span>
						</HoverCardTrigger>
						<HoverCardContent
							align="start"
							className="w-72 max-w-[min(18rem,calc(100vw-2rem))]"
							side="right"
							sideOffset={10}
							spacing="rail"
						>
							<div className="flex flex-col gap-2">
								<p className="font-medium text-sm leading-snug">{item.title}</p>
								{(item.description || item.agentAvatar) && (
									<div className="flex items-start gap-2">
										{item.agentAvatar ? (
											<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
												{item.agentAvatar}
											</span>
										) : null}
										<div className="min-w-0 flex-1">
											{item.agentName ? (
												<p className="type-caption mb-0.5 text-muted-foreground">
													{item.agentName}
												</p>
											) : null}
											{item.description ? (
												<p className="line-clamp-4 text-muted-foreground text-xs leading-relaxed">
													{item.description}
												</p>
											) : null}
										</div>
									</div>
								)}
								{item.files && item.files.length > 0 ? (
									<div className="border-border/60 border-t pt-2">
										<p className="type-caption mb-1.5 text-muted-foreground">
											Files changed
										</p>
										<ul className="flex flex-col gap-1">
											{item.files.slice(0, MAX_PREVIEW_FILES).map((file) => (
												<li
													className="flex min-w-0 items-baseline justify-between gap-2 text-xs"
													key={file.name}
												>
													<span className="type-caption flex min-w-0 items-center gap-1.5 truncate font-mono">
														<FileTypeIcon
															className="size-3.5"
															path={file.name}
														/>
														{file.name}
													</span>
													{file.stats ? (
														<span className="type-compact shrink-0 text-muted-foreground tabular-nums">
															{file.stats}
														</span>
													) : null}
												</li>
											))}
										</ul>
										{extraFiles > 0 ? (
											<p className="type-compact mt-1 text-muted-foreground">
												{tl("+{extraFiles} more", {
													extraFiles: String(extraFiles),
												})}
											</p>
										) : null}
									</div>
								) : null}
							</div>
						</HoverCardContent>
					</HoverCard>
				);
			})}
		</nav>
	);
});
