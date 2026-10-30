import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { MOMENTS_FOCUS, MomentsGlyph } from "./moments-glyph.tsx";
import { type MomentsModule, momentsAge } from "./moments-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Where Reply puts the caret inside the host's conversation view. */
const COMPOSER_SELECTOR = [
	"[data-moments-thread-view] textarea:not([disabled])",
	"[data-moments-thread-view] [contenteditable='true']",
	"[data-moments-thread-view] input[type='text']:not([disabled])",
].join(", ");

/** Per-thread, so two cards swapping in the list never share a layout box. */
function focusLayoutId(threadId: string): string {
	return `moments-focus-${threadId}`;
}

/** A short slide in the direction of travel; `custom` is the direction. */
const FOCUS_VARIANTS = {
	enter: (direction: number) => ({ opacity: 0, x: 24 * direction }),
	exit: (direction: number) => ({ opacity: 0, x: -24 * direction }),
	shown: { opacity: 1, x: 0 },
};

const TEXT_BUTTON = cn(
	"inline-flex h-7 items-center rounded-md px-2.5 text-xs transition-colors",
	MOMENTS_FOCUS
);
/** Who and where a module is from, as one quiet line. */
function ModuleSource({
	context,
	item,
	trailing,
}: {
	context: string;
	item: MomentsModule;
	trailing: ReactNode;
}) {
	return (
		<div className="flex h-5 min-w-0 items-center gap-2 text-xs">
			<MomentsGlyph agent={item.lead} />
			<span className="truncate text-foreground">
				{item.lead?.name ?? "No agent"}
			</span>
			<span className="truncate text-muted-foreground">{context}</span>
			<span className="ml-auto flex shrink-0 items-center gap-2">
				{trailing}
			</span>
		</div>
	);
}

/** The focused module: agent, title, status, latest message, quick actions. */
export function FocusCard({
	context,
	count,
	direction,
	index,
	item,
	now,
	onNext,
	onOpen,
	onReply,
}: {
	context: string;
	count: number;
	direction: number;
	index: number;
	item: MomentsModule;
	now: number;
	onNext: () => void;
	onOpen: () => void;
	onReply: () => void;
}) {
	const reduceMotion = useReducedMotion();
	// The outgoing card of a switch is on its way out: keep it out of reach.
	const present = useIsPresent();
	const titleId = useId();
	const reply = item.status === "your-turn" || item.status === "attention";
	const messages = item.thread.messageCount;
	const quiet =
		"text-foreground/70 hover:bg-foreground/5 hover:text-foreground";
	const primary = "font-medium text-foreground hover:bg-foreground/5";
	return (
		<motion.article
			animate="shown"
			aria-hidden={present ? undefined : true}
			aria-labelledby={titleId}
			className="self-center-safe col-start-1 row-start-1 flex w-full max-w-xl flex-col justify-self-center rounded-xl bg-card p-6 text-card-foreground shadow-foreground/[0.06] shadow-xl max-[899px]:self-start sm:p-8"
			custom={reduceMotion ? 0 : direction}
			data-testid="moments-focus"
			exit="exit"
			inert={!present}
			initial="enter"
			layoutId={reduceMotion ? undefined : focusLayoutId(item.thread.id)}
			transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE }}
			variants={FOCUS_VARIANTS}
		>
			<ModuleSource
				context={context}
				item={item}
				trailing={
					<span className="text-muted-foreground tabular-nums">
						{momentsAge(item.thread.updatedAt, now)}
					</span>
				}
			/>
			<h2
				className="mt-8 font-light text-2xl text-foreground leading-8 tracking-tight"
				id={titleId}
			>
				{item.thread.title}
			</h2>
			<p className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs leading-5">
				<BoardStatusDot className="size-1.5" status={item.status} />
				{THREAD_STATUS_LABELS[item.status]}
				<span aria-hidden="true">·</span>
				{messages} {messages === 1 ? "message" : "messages"}
			</p>
			<p className="mt-5 line-clamp-8 text-base text-foreground/80 leading-7">
				{item.thread.lastMessage ?? "No messages yet."}
			</p>
			<div className="mt-8 -ml-2.5 flex items-center gap-1">
				<button
					className={cn(TEXT_BUTTON, reply ? quiet : primary)}
					onClick={onOpen}
					type="button"
				>
					Open
				</button>
				<button
					className={cn(TEXT_BUTTON, reply ? primary : quiet)}
					onClick={onReply}
					type="button"
				>
					Reply
				</button>
				{count > 1 ? (
					<button
						className={cn(TEXT_BUTTON, quiet)}
						onClick={onNext}
						type="button"
					>
						Next
					</button>
				) : null}
				{count > 1 ? (
					<span className="ml-auto text-muted-foreground text-xs tabular-nums">
						{index + 1} of {count}
					</span>
				) : null}
			</div>
		</motion.article>
	);
}

/** The focused card opened up around the host's own conversation view. */
export function ExpandedCard({
	composeOnOpen,
	context,
	item,
	onClose,
	threadView,
	title,
}: {
	/** Opened with Reply: hand focus to the host's composer when it has one. */
	composeOnOpen: boolean;
	context: string;
	item: MomentsModule | undefined;
	onClose: () => void;
	threadView: ReactNode;
	title: string;
}) {
	const reduceMotion = useReducedMotion();
	const sectionRef = useRef<HTMLElement>(null);

	// The Open button that had focus is gone now. Unless the host's view took
	// focus for itself (its composer), hold it here so Esc still zooms out.
	useEffect(() => {
		const section = sectionRef.current;
		const composer = composeOnOpen
			? section?.querySelector<HTMLElement>(COMPOSER_SELECTOR)
			: null;
		if (composer) {
			composer.focus({ preventScroll: true });
			return;
		}
		const active = document.activeElement;
		if (!active || active === document.body || !active.isConnected) {
			section?.focus({ preventScroll: true });
		}
	}, [composeOnOpen]);

	return (
		<motion.section
			animate={{ opacity: 1 }}
			aria-label={title}
			className="flex size-full max-w-3xl flex-col overflow-hidden rounded-xl bg-card text-card-foreground shadow-foreground/[0.06] shadow-xl outline-none ring-1 ring-foreground/[0.04]"
			data-testid="moments-expanded"
			initial={{ opacity: reduceMotion ? 1 : 0.6 }}
			layoutId={
				reduceMotion || !item ? undefined : focusLayoutId(item.thread.id)
			}
			ref={sectionRef}
			tabIndex={-1}
			transition={{ duration: reduceMotion ? 0 : 0.32, ease: EASE }}
		>
			<header className="flex h-12 shrink-0 items-center gap-3 border-border/60 border-b pr-2 pl-4">
				<div className="min-w-0 flex-1">
					{item ? (
						<ModuleSource context={context} item={item} trailing={null} />
					) : (
						<span className="truncate text-foreground text-xs">{title}</span>
					)}
				</div>
				<button
					aria-label="Close conversation"
					className={cn(
						"inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground",
						MOMENTS_FOCUS
					)}
					onClick={onClose}
					type="button"
				>
					<X aria-hidden="true" className="size-4" strokeWidth={1.5} />
				</button>
			</header>
			<div className="min-h-0 flex-1" data-moments-thread-view="">
				{threadView}
			</div>
		</motion.section>
	);
}
