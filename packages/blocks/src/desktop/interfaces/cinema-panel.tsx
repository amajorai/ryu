import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Info, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	type CinemaTitle,
	cinemaNames,
	cinemaStatusText,
} from "./cinema-model.ts";

export interface CinemaPanelProps {
	headingRef: RefObject<HTMLHeadingElement | null>;
	onClose: () => void;
	onMore: (threadId: string, opener: HTMLElement) => void;
	overlay: boolean;
	reduceMotion: boolean;
	threadView: ReactNode;
	title: CinemaTitle | null;
	width: number;
}

/**
 * The open title: the host's own conversation in a full-height panel beside
 * the catalogue (or over it on narrow frames), under a slim header with the
 * title, its state and agents, More info and Close.
 */
export function CinemaPanel({
	headingRef,
	onClose,
	onMore,
	overlay,
	reduceMotion,
	threadView,
	title,
	width,
}: CinemaPanelProps) {
	const tl = useLiteralMessages();
	const heading = title?.thread.title ?? "New thread";
	const names = title ? cinemaNames(title.agents) : "";
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {heading}", { heading })}
			className={cn(
				"flex h-full min-h-0 flex-col bg-background",
				overlay
					? "absolute inset-0 z-40"
					: "relative shrink-0 border-border border-l"
			)}
			data-testid="cinema-thread-panel"
			initial={reduceMotion ? false : { opacity: 0, x: 24 }}
			style={overlay ? undefined : { width }}
			transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
		>
			<header className="flex h-16 shrink-0 items-center gap-3 border-border border-b pr-3 pl-4">
				<div className="flex min-w-0 flex-1 flex-col">
					<h2
						className="truncate font-semibold text-foreground text-sm leading-5 outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{heading}
					</h2>
					{title ? (
						<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm leading-5">
							<BoardStatusDot status={title.status} />
							<span className="shrink-0">{cinemaStatusText(title)}</span>
							{names ? (
								<>
									<span aria-hidden="true">·</span>
									<span className="truncate">{names}</span>
								</>
							) : null}
						</p>
					) : null}
				</div>
				{title ? (
					<Button
						aria-label={tl("More info: {title}", { title: title.thread.title })}
						onClick={(event) => onMore(title.thread.id, event.currentTarget)}
						size="icon-sm"
						type="button"
						variant="ghost"
					>
						<Info aria-hidden="true" />
					</Button>
				) : null}
				<Button
					aria-label={tl("Close {heading}", { heading })}
					onClick={onClose}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="min-h-0 flex-1" data-cinema-thread-view="">
				{threadView}
			</div>
		</motion.aside>
	);
}
