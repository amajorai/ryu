import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, Ref } from "react";
import { useReducedMotion } from "./reduced-motion.ts";
import type { TickerQuote } from "./ticker-model.ts";
import { STATUS_TEXT, SYMBOL_TEXT } from "./ticker-parts.tsx";

/**
 * The open thread beside the watchlist: the ticker it belongs to, its title
 * and status, and a close control, over the host's real conversation surface.
 * Below `xl` it covers the detail pane rather than squeezing it.
 */
export function TickerThreadPanel({
	headingRef,
	onClose,
	quote,
	thread,
	threadView,
}: {
	/**
	 * Focus lands here when a thread opens from the interface. It is only a
	 * focus target (tabIndex -1), so it draws no ring over the subtitle.
	 */
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	quote: TickerQuote | undefined;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const title = thread
		? thread.title.trim() || "Untitled thread"
		: "New thread";
	const status = thread ? threadStatus(thread) : null;
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {title}", { title })}
			className="absolute inset-0 z-20 flex min-h-0 flex-col border-border bg-background xl:static xl:w-[clamp(26rem,38vw,40rem)] xl:shrink-0 xl:border-l"
			data-testid="ticker-thread-panel"
			initial={reduceMotion ? false : { opacity: 0, x: 16 }}
			transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
		>
			<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4">
				{quote ? (
					<span className={cn(SYMBOL_TEXT, "shrink-0 text-sm")}>
						{quote.symbol}
					</span>
				) : null}
				<div className="flex min-w-0 flex-1 flex-col">
					<h2
						className="truncate font-medium text-foreground text-sm leading-tight outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					<p className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground text-xs leading-tight">
						<span className="truncate">
							{quote ? quote.agent.name : "No agent assigned"}
						</span>
						{status ? (
							<>
								<span aria-hidden="true">·</span>
								<span className={cn("shrink-0", STATUS_TEXT[status])}>
									{THREAD_STATUS_LABELS[status]}
								</span>
							</>
						) : null}
					</p>
				</div>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-keyshortcuts="Escape"
								aria-label="Close thread"
								onClick={onClose}
								size="icon-sm"
								type="button"
								variant="ghost"
							/>
						}
					>
						<X aria-hidden="true" />
					</TooltipTrigger>
					<TooltipContent side="bottom">
						Close <Kbd>Esc</Kbd>
					</TooltipContent>
				</Tooltip>
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</motion.aside>
	);
}
