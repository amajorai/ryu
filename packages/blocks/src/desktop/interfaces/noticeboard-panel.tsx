import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { compactAge } from "./interface-renderer.ts";
import { type NoticeboardNote, noteByline } from "./noticeboard-model.ts";
import { PinDot } from "./noticeboard-paper.tsx";

/**
 * The side panel the host's real conversation opens in. The header names the
 * note that was lifted off the board; everything below it is `threadView`.
 */
export function NoticeboardPanel({
	headingRef,
	note,
	now,
	onClose,
	overlay,
	reduceMotion,
	threadView,
	width,
}: {
	headingRef: RefObject<HTMLHeadingElement | null>;
	note: NoticeboardNote | null;
	now: number;
	onClose: () => void;
	/** Narrow frames: the panel covers the board instead of sitting beside it. */
	overlay: boolean;
	reduceMotion: boolean;
	threadView: ReactNode;
	width: number;
}) {
	const age = note ? compactAge(note.thread.updatedAt, now) : "";
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label="Conversation"
			className={cn(
				"flex min-h-0 flex-col border-border bg-background",
				overlay ? "absolute inset-0 z-30" : "relative shrink-0 border-s"
			)}
			data-testid="noticeboard-panel"
			initial={reduceMotion ? false : { opacity: 0, x: 12 }}
			style={overlay ? undefined : { width }}
			transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
		>
			<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b ps-4 pe-2">
				<div className="flex min-w-0 flex-1 flex-col">
					<h2
						className="truncate font-semibold text-foreground text-sm leading-5 outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{note?.thread.title || "New note"}
					</h2>
					{note ? (
						<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-4">
							<PinDot className="size-1.5" halo={false} status={note.status} />
							<span className="shrink-0">
								{THREAD_STATUS_LABELS[note.status]}
							</span>
							<span aria-hidden="true">·</span>
							<span className="truncate">{noteByline(note)}</span>
							{age ? (
								<>
									<span aria-hidden="true">·</span>
									<span className="shrink-0 tabular-nums">{age}</span>
								</>
							) : null}
						</p>
					) : null}
				</div>
				<Button
					aria-label="Close conversation"
					onClick={onClose}
					size="icon-sm"
					variant="ghost-muted"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="min-h-0 flex-1" data-testid="noticeboard-thread-view">
				{threadView}
			</div>
		</motion.aside>
	);
}
