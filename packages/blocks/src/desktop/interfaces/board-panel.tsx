import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusText } from "./board-card.tsx";
import { agentById } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * The open thread beside the board: a slim header (who, what, where it stands,
 * close) over the host's real conversation surface, which fills the rest.
 */
export function BoardThreadPanel({
	onClose,
	snapshot,
	thread,
	threadView,
}: {
	onClose: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const title = thread
		? thread.title.trim() || "Untitled thread"
		: "New thread";
	const lead = agentById(snapshot, thread?.agentIds[0]);
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	return (
		<motion.aside
			// A transform (not `x`) runs on the compositor, so the slide stays
			// smooth while the host's conversation mounts.
			animate={{ opacity: 1, transform: "translateX(0px)" }}
			aria-label={tl("Thread: {title}", { title })}
			className="flex min-h-0 w-[clamp(360px,45%,880px)] shrink-0 flex-col border-border border-l bg-background max-md:absolute max-md:inset-0 max-md:z-20 max-md:w-full max-md:border-l-0"
			data-testid="board-thread-panel"
			initial={
				reduceMotion ? false : { opacity: 0, transform: "translateX(16px)" }
			}
			transition={
				reduceMotion
					? { duration: 0 }
					: { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
			}
		>
			{/* Escape closes from the header only; the host chat keeps its own. */}
			<header
				className="flex h-12 shrink-0 items-center gap-2.5 border-border border-b pr-3 pl-4"
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
					}
				}}
			>
				{lead ? <BoardAvatar agent={lead} name={lead.name} size={20} /> : null}
				<div className="flex min-w-0 flex-1 flex-col">
					<h2 className="truncate font-medium text-[13px] text-foreground leading-4">
						{title}
					</h2>
					{thread ? (
						<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-4">
							<BoardStatusText status={threadStatus(thread)} />
							{lead ? (
								<>
									<span aria-hidden="true">·</span>
									<span className="truncate">{lead.name}</span>
								</>
							) : null}
						</span>
					) : null}
				</div>
				<Button
					aria-label="Close thread"
					className="text-muted-foreground"
					onClick={onClose}
					size="icon-sm"
					title="Close thread (Esc)"
					type="button"
					variant="ghost"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</motion.aside>
	);
}
