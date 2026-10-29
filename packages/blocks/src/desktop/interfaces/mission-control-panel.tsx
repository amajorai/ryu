import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { MessageSquareDashed, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, Ref } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";
import { missionThreadTitle } from "./mission-control-model.ts";
import {
	Lamp,
	type LampState,
	STATUS_TONE,
	TONE_TEXT,
} from "./mission-control-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const EASE = [0.2, 0, 0, 1] as const;

const STATUS_LAMP: Record<ReturnType<typeof threadStatus>, LampState> = {
	attention: "alert",
	quiet: "idle",
	waiting: "waiting",
	working: "working",
	"your-turn": "your-turn",
};

/** The wall's one word for a failed thread, as on the stations and alerts. */
const STATUS_LABELS: Record<ThreadStatus, string> = {
	...THREAD_STATUS_LABELS,
	attention: "Failed",
};

/**
 * Dims the wall behind the slide-over; clicking it closes the thread. It
 * takes the design system's own dialog overlay tint (without its blur), so it
 * matches every other modal surface in light and dark themes.
 */
export function MissionScrim({ onClose }: { onClose: () => void }) {
	const reduceMotion = useReducedMotion();
	return (
		<motion.button
			animate={{ opacity: 1 }}
			aria-label="Dismiss thread panel"
			className="absolute inset-0 z-20 cursor-default bg-(--ryu-dialog-overlay-background)"
			exit={{ opacity: 0 }}
			initial={reduceMotion ? false : { opacity: 0 }}
			onClick={onClose}
			tabIndex={-1}
			transition={{ duration: 0.18 }}
			type="button"
		/>
	);
}

/**
 * The open thread as a slide-over from the right edge of the wall: who, what,
 * and where it stands, over the host's real conversation surface.
 */
export function MissionThreadPanel({
	headingRef,
	now,
	onClose,
	snapshot,
	thread,
	threadView,
}: {
	headingRef: Ref<HTMLHeadingElement>;
	now: number;
	onClose: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const title = thread ? missionThreadTitle(thread) : "New thread";
	const agents = (thread?.agentIds ?? [])
		.map((id) => agentById(snapshot, id))
		.filter((agent) => agent !== undefined);
	const lead = agents[0];
	const status = thread ? threadStatus(thread) : null;
	const age = thread ? compactAge(thread.updatedAt, now) : "";
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {title}", { title })}
			className="absolute inset-y-0 right-0 z-30 flex @min-[720px]:w-[min(760px,58%)] w-full flex-col border-border @min-[720px]:border-l bg-background"
			data-testid="mission-thread-panel"
			exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 48 }}
			initial={reduceMotion ? false : { opacity: 0, x: 48 }}
			transition={{ duration: 0.22, ease: EASE }}
		>
			<header className="flex min-h-14 shrink-0 items-center gap-3 border-border border-b px-3 py-2">
				{lead ? (
					<BoardAvatar agent={lead} name={lead.name} size={28} />
				) : (
					<span
						aria-hidden="true"
						className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
					>
						<MessageSquareDashed className="size-3.5" />
					</span>
				)}
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2
						className="truncate rounded-sm font-medium text-[13px] text-foreground leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-4">
						{status ? (
							<span
								className={cn(
									"inline-flex shrink-0 items-center gap-1.5 font-medium",
									TONE_TEXT[STATUS_TONE[status]]
								)}
							>
								<Lamp size="sm" state={STATUS_LAMP[status]} />
								{STATUS_LABELS[status]}
							</span>
						) : null}
						{status ? <span aria-hidden="true">·</span> : null}
						<span className="truncate">
							{agents.length > 0
								? agents.map((agent) => agent.name).join(", ")
								: "No agent assigned"}
							{age ? ` · ${age === "now" ? "just now" : `${age} ago`}` : ""}
						</span>
					</p>
				</div>
				<Button
					aria-label="Close thread"
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
