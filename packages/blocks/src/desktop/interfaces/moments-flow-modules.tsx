import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { Plus } from "lucide-react";
import type { KeyboardEvent } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { MOMENTS_FOCUS, MomentsGlyph } from "./moments-glyph.tsx";
import type { MomentsFlow, MomentsModule } from "./moments-model.ts";

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
export function ModuleList({
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
	const tl = useLiteralMessages();
	return (
		<nav
			aria-label={tl("{name} conversations", { name: flow.name })}
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
export function ModuleStrip({
	flow,
	focusIndex,
	onSelect,
}: {
	flow: MomentsFlow;
	focusIndex: number;
	onSelect: (index: number) => void;
}) {
	const tl = useLiteralMessages();
	if (flow.modules.length < 2) {
		return null;
	}
	return (
		<div
			aria-label={tl("{name} conversations", { name: flow.name })}
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
