import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, Ref } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusLabel } from "./board-status.tsx";
import { agentById } from "./interface-renderer.ts";
import { MINDMAP_EASE } from "./mindmap-node.tsx";

/** Kbd inverts inside tooltips; keep it legible on the tooltip surface. */
export const MINDMAP_TOOLTIP_KBD =
	"in-data-[slot=tooltip-content]:bg-background/70 in-data-[slot=tooltip-content]:text-muted-foreground dark:in-data-[slot=tooltip-content]:bg-background/70";

function people(snapshot: InterfaceSnapshot, thread: InterfaceThread): string {
	const names: string[] = [];
	for (const id of thread.agentIds) {
		const name = agentById(snapshot, id)?.name;
		if (name) {
			names.push(name);
		}
	}
	if (names.length === 0) {
		return "No agent";
	}
	return names.length > 3
		? `${names.slice(0, 3).join(", ")} +${names.length - 3}`
		: names.join(", ");
}

/**
 * The open thread, docked beside the map: a slim header (close, title, who,
 * status) above the host's own conversation surface. Below 768px it covers
 * the map instead of squeezing it.
 */
export function MindmapThreadPanel({
	animate,
	branchLabel,
	headingRef,
	onClose,
	snapshot,
	thread,
	threadView,
}: {
	animate: boolean;
	/** The branch the thread sits on, for the subtitle. */
	branchLabel: string | null;
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const title = thread
		? thread.title.trim() || "Untitled thread"
		: "New thread";
	const lead = agentById(snapshot, thread?.agentIds[0]);
	const subtitle = thread
		? [people(snapshot, thread), branchLabel].filter(Boolean).join(" · ")
		: "New conversation";
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {title}", { title })}
			className="@max-[767px]:absolute @max-[767px]:inset-0 @max-[767px]:z-20 flex min-h-0 @max-[767px]:w-full w-[min(560px,48%)] @max-[767px]:min-w-0 min-w-[380px] shrink-0 flex-col border-border border-l @max-[767px]:border-l-0 bg-background"
			data-testid="mindmap-thread-panel"
			initial={animate ? { opacity: 0, x: 16 } : false}
			transition={{ duration: animate ? 0.2 : 0, ease: MINDMAP_EASE }}
		>
			<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b pr-2 pl-4">
				{lead ? <BoardAvatar agent={lead} name={lead.name} size={28} /> : null}
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2
						className="truncate font-semibold text-foreground text-sm leading-5 outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					<p className="truncate text-muted-foreground text-xs leading-4">
						{subtitle}
					</p>
				</div>
				{thread ? <BoardStatusLabel status={threadStatus(thread)} /> : null}
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
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
					<TooltipContent align="end" side="bottom">
						Back to the map <Kbd className={MINDMAP_TOOLTIP_KBD}>Esc</Kbd>
					</TooltipContent>
				</Tooltip>
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</motion.aside>
	);
}
