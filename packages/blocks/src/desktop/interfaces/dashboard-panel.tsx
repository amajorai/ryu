import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, Ref } from "react";
import { BoardStatusLabel } from "./board-status.tsx";
import { threadTitle } from "./dashboard-model.ts";
import { agentById, compactAge } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const EASE = [0.2, 0, 0, 1] as const;

/** Dims the dashboard behind the slide-over; clicking it closes the thread. */
export function DashboardScrim({ onClose }: { onClose: () => void }) {
	const reduceMotion = useReducedMotion();
	return (
		<motion.button
			animate={{ opacity: 1 }}
			aria-label="Dismiss thread panel"
			className="absolute inset-0 z-20 cursor-default bg-background/50"
			exit={{ opacity: 0 }}
			initial={reduceMotion ? false : { opacity: 0 }}
			onClick={onClose}
			tabIndex={-1}
			transition={{ duration: 0.16 }}
			type="button"
		/>
	);
}

/**
 * The open thread as a slide-over from the right: a one-line header (title,
 * status, agents) over the host's own conversation surface.
 */
export function DashboardThreadPanel({
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
	const title = thread ? threadTitle(thread) : "New thread";
	const names = (thread?.agentIds ?? [])
		.map((id) => agentById(snapshot, id)?.name)
		.filter((name) => name !== undefined);
	const age = thread ? compactAge(thread.updatedAt, now) : "";
	const ageText = age === "now" ? "just now" : `${age} ago`;
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {title}", { title })}
			className="absolute inset-y-0 right-0 z-30 flex @min-[760px]/dash:w-[min(720px,56%)] w-full flex-col border-border @min-[760px]/dash:border-l bg-background shadow-2xl shadow-foreground/10"
			data-testid="dashboard-thread-panel"
			exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 40 }}
			initial={reduceMotion ? false : { opacity: 0, x: 40 }}
			transition={{ duration: 0.2, ease: EASE }}
		>
			<header className="flex h-12 shrink-0 items-center gap-3 border-border border-b ps-4 pe-2">
				<div className="flex min-w-0 flex-1 items-baseline gap-3">
					<h2
						className="min-w-0 truncate rounded-sm font-medium text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					{thread ? (
						<span className="flex min-w-0 shrink items-center gap-2 text-muted-foreground text-xs">
							<BoardStatusLabel status={threadStatus(thread)} />
							<span className="truncate max-sm:hidden">
								{names.length > 0 ? names.join(", ") : "No agent"}
								{age ? ` · ${ageText}` : ""}
							</span>
						</span>
					) : null}
				</div>
				<Kbd aria-hidden="true" className="max-sm:hidden">
					Esc
				</Kbd>
				<Button
					aria-label="Close thread"
					onClick={onClose}
					size="icon-sm"
					title="Close (Esc)"
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
