"use client";

import {
	useMessageScroller,
	useMessageScrollerVisibility,
} from "@ryu/ui/components/message-scroller";
import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import { memo } from "react";

export interface ChatTocItem {
	id: string;
	title: string;
}

const lineVariants = {
	normal: { width: 16 },
	active: { width: 28 },
	hover: { width: 28 },
};

/**
 * Notion-style table of contents for the chat. Renders one marker per user
 * message down the left gutter of the message list. Collapsed to bare lines by
 * default; hovering the rail reveals each message's text. Clicking a marker
 * scrolls its turn into view. The marker of the turn currently at the top of
 * the viewport is highlighted.
 */
export const ChatToc = memo(function ChatToc({
	items,
	className,
}: {
	items: ChatTocItem[];
	className?: string;
}) {
	const { scrollToMessage } = useMessageScroller();
	const { currentAnchorId } = useMessageScrollerVisibility();

	// Nothing worth navigating with a single turn.
	if (items.length < 2) {
		return null;
	}

	return (
		<nav
			aria-label="Message navigation"
			className={cn(
				"group/toc no-scrollbar pointer-events-auto absolute inset-s-2 top-1/2 z-20 hidden max-h-[70%] -translate-y-1/2 flex-col gap-2 overflow-y-auto py-2 lg:flex",
				className
			)}
		>
			{items.map((item) => {
				const isActive = item.id === currentAnchorId;

				return (
					<button
						aria-current={isActive ? "true" : undefined}
						className="group/toc-item relative flex h-4 items-center gap-2 text-left"
						key={item.id}
						onClick={() => scrollToMessage(item.id, { align: "start" })}
						type="button"
					>
						<motion.span
							animate={isActive ? "active" : "normal"}
							className="block h-px shrink-0 rounded-full bg-foreground/25 transition-colors group-hover/toc-item:bg-foreground group-hover/toc:bg-foreground/40 group-aria-[current=true]/toc-item:bg-foreground"
							initial={false}
							transition={{ type: "spring", stiffness: 200, damping: 20 }}
							variants={lineVariants}
							whileHover="hover"
						/>
						<span className="max-w-[220px] truncate whitespace-nowrap text-muted-foreground text-xs opacity-0 transition-opacity duration-200 group-hover/toc-item:text-foreground group-hover/toc:opacity-100 group-aria-[current=true]/toc-item:text-foreground">
							{item.title}
						</span>
					</button>
				);
			})}
		</nav>
	);
});
