import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { ArrowLeft, Plus, X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { MOMENTS_FOCUS, MomentsGlyph } from "./moments-glyph.tsx";
import {
	type MomentsFlow,
	type MomentsModule,
	momentsAge,
} from "./moments-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** Attribute the module list uses to find its rows for arrow keys. */
export const MOMENTS_MODULE_ATTRIBUTE = "data-moments-module";

/** Marks the host's conversation view; keys pressed inside it are its own. */
export const MOMENTS_THREAD_VIEW_ATTRIBUTE = "data-moments-thread-view";

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

function flagged(item: MomentsModule): boolean {
	return (
		item.status === "attention" ||
		item.status === "your-turn" ||
		item.status === "working"
	);
}

function ModuleRow({
	active,
	index,
	item,
	onSelect,
	showAgent,
}: {
	active: boolean;
	index: number;
	item: MomentsModule;
	onSelect: (index: number) => void;
	showAgent: boolean;
}) {
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				className={cn(
					"flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors",
					MOMENTS_FOCUS,
					active
						? "bg-card text-foreground shadow-foreground/5 shadow-sm"
						: "text-foreground/70 hover:bg-card/50 hover:text-foreground"
				)}
				data-moments-module={index}
				onClick={() => onSelect(index)}
				tabIndex={active ? 0 : -1}
				type="button"
			>
				<MomentsGlyph agent={item.lead} />
				<span className="min-w-0 flex-1 truncate">{item.thread.title}</span>
				{showAgent && item.lead ? (
					<span className="shrink-0 text-muted-foreground text-xs">
						{item.lead.name}
					</span>
				) : null}
				<span className="flex w-1.5 shrink-0 justify-center">
					{flagged(item) ? (
						<BoardStatusDot className="size-1.5" status={item.status} />
					) : null}
				</span>
			</button>
		</li>
	);
}

/** The flow's conversations down the left, as MercuryOS lists modules. */
function ModuleList({
	flow,
	focusIndex,
	onKeyDown,
	onNewThread,
	onSelect,
}: {
	flow: MomentsFlow;
	focusIndex: number;
	onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	onNewThread: () => void;
	onSelect: (index: number) => void;
}) {
	return (
		<nav
			aria-label={`${flow.name} conversations`}
			className="hidden w-64 shrink-0 flex-col gap-1 min-[900px]:flex min-[1200px]:w-72"
			onKeyDown={onKeyDown}
		>
			<ul className="flex flex-col gap-1">
				{flow.modules.map((item, index) => (
					<ModuleRow
						active={index === focusIndex}
						index={index}
						item={item}
						key={item.thread.id}
						onSelect={onSelect}
						showAgent={flow.kind !== "agent"}
					/>
				))}
			</ul>
			<button
				className={cn(
					"mt-2 flex h-8 items-center gap-2.5 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-card/50 hover:text-foreground",
					MOMENTS_FOCUS
				)}
				onClick={onNewThread}
				type="button"
			>
				<span className="flex size-4 items-center justify-center">
					<Plus aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
				</span>
				New thread
			</button>
		</nav>
	);
}

/** Below 900px the list folds into one scrolling row under the title. */
function ModuleStrip({
	flow,
	focusIndex,
	onSelect,
}: {
	flow: MomentsFlow;
	focusIndex: number;
	onSelect: (index: number) => void;
}) {
	if (flow.modules.length < 2) {
		return null;
	}
	return (
		<div
			aria-label={`${flow.name} conversations`}
			className="-mx-4 mt-6 flex shrink-0 gap-1 overflow-x-auto px-4 py-1 min-[900px]:hidden"
			role="group"
		>
			{flow.modules.map((item, index) => {
				const active = index === focusIndex;
				return (
					<button
						aria-pressed={active}
						className={cn(
							"flex h-8 max-w-56 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm transition-colors",
							MOMENTS_FOCUS,
							active
								? "bg-card text-foreground shadow-foreground/5 shadow-sm"
								: "text-foreground/70 hover:bg-card/50 hover:text-foreground"
						)}
						key={item.thread.id}
						onClick={() => onSelect(index)}
						type="button"
					>
						{flagged(item) ? (
							<BoardStatusDot className="size-1.5" status={item.status} />
						) : null}
						<span className="truncate">{item.thread.title}</span>
					</button>
				);
			})}
		</div>
	);
}

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
function FocusCard({
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
function ExpandedCard({
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

/**
 * Inside a flow: the huge faded flow name on its own row, its modules down
 * the left, and one focused card in the middle. Opening a module grows the
 * card around the host's conversation view.
 */
export function MomentsFlowView({
	contextFor,
	direction,
	flow,
	focusIndex,
	now,
	onBack,
	onClose,
	onListKeyDown,
	onNewThread,
	onOpenThread,
	onSelect,
	threadView,
}: {
	contextFor: (item: MomentsModule) => string;
	direction: number;
	/** Null for a brand-new thread that is not on the timeline yet. */
	flow: MomentsFlow | null;
	focusIndex: number;
	now: number;
	onBack: () => void;
	onClose: () => void;
	onListKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	onNewThread: () => void;
	onOpenThread: (threadId: string) => void;
	onSelect: (index: number) => void;
	threadView: ReactNode | null;
}) {
	const modules = flow?.modules ?? [];
	const item = modules[focusIndex];
	const [composeOnOpen, setComposeOnOpen] = useState(false);
	const title = flow?.name ?? "New thread";
	const count = modules.length;
	return (
		<div
			className="flex size-full flex-col px-4 pb-6 outline-none sm:px-10"
			data-testid="moments-flow"
			tabIndex={-1}
		>
			<div className="flex h-8 shrink-0 items-center">
				<button
					aria-keyshortcuts="Escape"
					className={cn(
						"-ml-2 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs transition-colors hover:bg-card/50 hover:text-foreground",
						MOMENTS_FOCUS
					)}
					onClick={onBack}
					title="Esc"
					type="button"
				>
					<ArrowLeft
						aria-hidden="true"
						className="size-3.5"
						strokeWidth={1.5}
					/>
					All flows
				</button>
			</div>
			<h1
				className={cn(
					"mt-4 line-clamp-2 shrink-0 text-balance break-normal font-light text-foreground/30 tracking-tight transition-[font-size] duration-300 motion-reduce:transition-none dark:text-foreground/35",
					threadView
						? "text-[clamp(2rem,4.5vw,3.5rem)] leading-[1.05]"
						: "text-[clamp(2.5rem,6vw,4.5rem)] leading-[1.05]"
				)}
			>
				{title}
			</h1>
			{flow ? (
				<ModuleStrip flow={flow} focusIndex={focusIndex} onSelect={onSelect} />
			) : null}
			<div className="mt-4 flex min-h-0 flex-1 gap-10 min-[900px]:mt-8">
				{flow ? (
					<ModuleList
						flow={flow}
						focusIndex={focusIndex}
						onKeyDown={onListKeyDown}
						onNewThread={onNewThread}
						onSelect={onSelect}
					/>
				) : null}
				<div
					className={cn(
						"grid min-w-0 flex-1 grid-rows-[minmax(0,1fr)]",
						threadView ? "justify-items-center" : "pb-[14vh] max-[899px]:pb-0"
					)}
				>
					{threadView ? (
						<ExpandedCard
							composeOnOpen={composeOnOpen}
							context={item ? contextFor(item) : ""}
							item={item}
							onClose={onClose}
							threadView={threadView}
							title={item?.thread.title ?? title}
						/>
					) : (
						<AnimatePresence custom={direction} initial={false}>
							{item ? (
								<FocusCard
									context={contextFor(item)}
									count={count}
									direction={direction}
									index={focusIndex}
									item={item}
									key={item.thread.id}
									now={now}
									onNext={() => onSelect((focusIndex + 1) % count)}
									onOpen={() => {
										setComposeOnOpen(false);
										onOpenThread(item.thread.id);
									}}
									onReply={() => {
										setComposeOnOpen(true);
										onOpenThread(item.thread.id);
									}}
								/>
							) : (
								<p className="col-start-1 row-start-1 self-start pt-10 text-muted-foreground text-sm">
									Nothing in this flow yet.
								</p>
							)}
						</AnimatePresence>
					)}
				</div>
			</div>
		</div>
	);
}
