import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, type Ref, useId } from "react";
import { holoThreadTitle, statusPhrase } from "./hologram-model.ts";
import { FRAME_TEXTURE } from "./hologram-palette.ts";
import {
	CornerBrackets,
	HUD_INTERACTIVE,
	HUD_LABEL,
	StatusMark,
} from "./hologram-parts.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const EASE = [0.2, 0, 0, 1] as const;

/**
 * Dims the HUD behind the thread frame (it stays visible, and inert, so the
 * frame reads as a panel projected over the deck). Pointer-only: clicking it
 * closes the thread; keyboard users have Esc and the frame's close button.
 */
export function FrameScrim({ onClose }: { onClose: () => void }) {
	const reduceMotion = useReducedMotion();
	return (
		<motion.button
			animate={{ opacity: 1 }}
			aria-hidden="true"
			className="absolute inset-0 z-30 cursor-default bg-(--holo-deck)/80"
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
 * The open thread inside a large holographic frame over the dimmed deck: a
 * scanlined HUD header with who, what and where it stands, over the host's
 * own conversation surface, set under a hairline (the chat keeps the
 * theme's tokens and reads exactly as it does everywhere).
 */
export function ThreadFrame({
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
	const reduceMotion = useReducedMotion();
	const titleId = useId();
	const title = thread ? holoThreadTitle(thread) : "New thread";
	const names = (thread?.agentIds ?? [])
		.map((id) => agentById(snapshot, id)?.name)
		.filter((name): name is string => name !== undefined);
	const status = thread ? threadStatus(thread) : null;
	const age = thread ? compactAge(thread.updatedAt, now) : "";
	const meta = [
		names.length > 0 ? names.join(", ") : "No agent",
		age ? (age === "now" ? "just now" : `${age} ago`) : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<motion.section
			animate={{ opacity: 1, scale: 1 }}
			aria-labelledby={titleId}
			aria-modal="true"
			className="absolute @min-[760px]/holo:inset-x-10 inset-x-3 @min-[760px]/holo:top-8 top-3 @min-[760px]/holo:bottom-8 bottom-3 z-40 mx-auto flex max-w-[1100px] flex-col border border-(--holo-line)"
			data-testid="hologram-thread-frame"
			exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.98 }}
			initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
			role="dialog"
			style={FRAME_TEXTURE}
			transition={{ duration: 0.2, ease: EASE }}
		>
			<CornerBrackets />
			<header className="flex min-h-14 shrink-0 items-center gap-3 px-4">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<p
						className={cn(
							HUD_LABEL,
							"flex items-center gap-2 text-(--holo-ink)"
						)}
					>
						{status && thread ? null : <span>Thread</span>}
						{status && thread ? (
							<span
								className={cn(
									"flex items-center gap-1.5",
									status === "attention" && "text-(--holo-alert)",
									status === "your-turn" && "text-(--holo-turn)",
									(status === "waiting" || status === "quiet") &&
										"text-(--holo-dim)"
								)}
							>
								<StatusMark status={status} />
								{statusPhrase(thread)}
							</span>
						) : null}
					</p>
					<h2
						className="truncate font-medium text-(--holo-text) text-[15px] leading-5 outline-none"
						id={titleId}
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
				</div>
				<span className="mr-1 @min-[760px]/holo:block hidden max-w-60 truncate font-mono text-(--holo-dim) text-[12px]">
					{meta}
				</span>
				<button
					aria-label="Close thread"
					className={cn(
						"flex size-8 items-center justify-center rounded-sm text-(--holo-dim) hover:text-(--holo-text)",
						HUD_INTERACTIVE
					)}
					onClick={onClose}
					title="Close thread (Esc)"
					type="button"
				>
					<X aria-hidden="true" className="size-4" />
				</button>
			</header>
			<div className="min-h-0 flex-1 overflow-hidden border-(--holo-line) border-t bg-background text-foreground">
				{threadView}
			</div>
		</motion.section>
	);
}
