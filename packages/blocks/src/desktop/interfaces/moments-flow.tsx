import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeft } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { ExpandedCard, FocusCard } from "./moments-flow-cards.tsx";
import { ModuleList, ModuleStrip } from "./moments-flow-modules.tsx";
import { MOMENTS_FOCUS } from "./moments-glyph.tsx";
import type { MomentsFlow, MomentsModule } from "./moments-model.ts";

/** Attribute the module list uses to find its rows for arrow keys. */
export const MOMENTS_MODULE_ATTRIBUTE = "data-moments-module";

/** Marks the host's conversation view; keys pressed inside it are its own. */
export const MOMENTS_THREAD_VIEW_ATTRIBUTE = "data-moments-thread-view";
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
