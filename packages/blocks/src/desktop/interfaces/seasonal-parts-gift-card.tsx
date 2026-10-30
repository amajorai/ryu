import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { Undo2, X } from "lucide-react";
import { motion } from "motion/react";
import { forwardRef, type KeyboardEvent } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusLabel } from "./board-status.tsx";
import { compactAge } from "./interface-renderer.ts";
import {
	latestLine,
	type SeasonCopy,
	type SeasonDoor,
} from "./seasonal-model.ts";

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Faces and names of the agents in a conversation, on the popover surface. */
function GiftAgents({ agents }: { agents: SeasonDoor["agents"] }) {
	if (agents.length === 0) {
		return (
			<span className="text-muted-foreground text-xs leading-4">
				No agent assigned
			</span>
		);
	}
	return (
		<span className="flex min-w-0 items-center gap-2">
			<span className="flex shrink-0 -space-x-1.5">
				{agents.slice(0, 3).map((agent) => (
					<BoardAvatar
						agent={agent}
						className="ring-2 ring-popover"
						key={agent.id}
						name={agent.name}
						size={20}
					/>
				))}
			</span>
			<span className="truncate text-muted-foreground text-xs leading-4">
				{agents.map((agent) => agent.name).join(", ")}
			</span>
		</span>
	);
}

/**
 * The note inside an opened door: what the conversation is, where it stands,
 * who is in it, the latest line, and the way into it. Non-modal: focus is
 * free to leave, and closing it hands focus back to its door.
 */
export const GiftCard = forwardRef<
	HTMLDivElement,
	{
		/**
		 * The act layer is on: no "Mark unopened" (opened follows the
		 * thread's unread answers) and no last-activity age.
		 */
		acts?: boolean;
		copy: SeasonCopy;
		door: SeasonDoor;
		id: string;
		now: number;
		onClose: () => void;
		onOpen: () => void;
		onReclose: () => void;
		position: { left: number; top: number; width: number };
		reduceMotion: boolean;
	}
>(function GiftCard(
	{
		acts = false,
		copy,
		door,
		id,
		now,
		onClose,
		onOpen,
		onReclose,
		position,
		reduceMotion,
	},
	ref
) {
	const thread = door.thread;
	if (!thread) {
		return null;
	}
	const latest = latestLine(thread);
	const age = acts ? null : compactAge(thread.updatedAt, now);
	const name = `${capitalize(copy.door)} ${door.number}`;
	const title = thread.title || "Untitled";
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			onClose();
		}
	};
	return (
		<motion.div
			animate={{ opacity: 1, scale: 1, y: 0 }}
			aria-describedby={`${id}-meta`}
			aria-labelledby={`${id}-title`}
			className="absolute z-30 flex flex-col gap-3 rounded-lg border border-border bg-popover pt-3 pb-4 text-popover-foreground shadow-md"
			data-seasonal-gift=""
			id={id}
			initial={reduceMotion ? false : { opacity: 0, scale: 0.97, y: 4 }}
			onKeyDown={onKeyDown}
			ref={ref}
			role="dialog"
			style={{ left: position.left, top: position.top, width: position.width }}
			transition={
				reduceMotion
					? { duration: 0 }
					: { delay: 0.18, duration: 0.18, ease: [0.22, 1, 0.36, 1] }
			}
		>
			<div className="flex items-start gap-2 ps-4 pe-2">
				<div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
					<h2
						className="line-clamp-2 font-semibold text-sm leading-5"
						id={`${id}-title`}
					>
						<span className="sr-only">{name}: </span>
						{title}
					</h2>
					<p
						className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs tabular-nums leading-4"
						id={`${id}-meta`}
					>
						<span className="shrink-0">{name}</span>
						{acts && door.actWords ? (
							<>
								<span aria-hidden="true">·</span>
								<span className="truncate" data-act-words="">
									{door.actWords}
								</span>
							</>
						) : null}
						{!acts && door.status ? (
							<>
								<span aria-hidden="true">·</span>
								<BoardStatusLabel status={door.status} />
							</>
						) : null}
						{age ? (
							<>
								<span aria-hidden="true">·</span>
								<span className="shrink-0">{age}</span>
							</>
						) : null}
					</p>
				</div>
				<div className="flex shrink-0 items-center">
					{acts ? null : (
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										aria-label="Mark unopened"
										onClick={onReclose}
										size="icon-sm"
										type="button"
										variant="ghost"
									/>
								}
							>
								<Undo2 aria-hidden="true" className="size-4" />
							</TooltipTrigger>
							<TooltipContent side="bottom">Mark unopened</TooltipContent>
						</Tooltip>
					)}
					<Button
						aria-label="Close"
						onClick={onClose}
						size="icon-sm"
						type="button"
						variant="ghost"
					>
						<X aria-hidden="true" className="size-4" />
					</Button>
				</div>
			</div>
			<div className="flex flex-col gap-3 px-4">
				<GiftAgents agents={door.agents} />
				{latest ? (
					<p className="line-clamp-3 text-foreground/80 text-sm leading-5">
						{latest}
					</p>
				) : null}
				<Button
					autoFocus
					className="mt-1 self-start"
					onClick={onOpen}
					size="sm"
				>
					Open conversation
				</Button>
			</div>
		</motion.div>
	);
});
