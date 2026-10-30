import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { useMemo, useState } from "react";
import {
	type GlanceHomeProps,
	HeaderCount,
	names,
	Quiet,
	ROW_BUTTON,
	W,
	Widget,
} from "./glance-home-chrome.tsx";
import {
	GLANCE_AGENT_STATE_LABELS,
	GLANCE_NEEDS_YOU_LABEL,
	type GlanceDistance,
	glanceListWindow,
	glanceThreadTitle,
	glanceWaitingOnYou,
	glanceWorking,
} from "./glance-model.ts";
import {
	GLANCE_INK_SECONDARY,
	GlanceAvatar,
	GlanceMark,
	glanceThreadState,
} from "./glance-parts.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";

/**
 * Rows the "Needs you" widget holds before folding the rest into "N more":
 * one-line rows fill a large widget at six, two-line Near rows at four.
 */
const NEEDS_YOU_CAPACITY: Record<GlanceDistance, number> = {
	far: 6,
	near: 4,
};

export function NeedsYouWidget({
	distance,
	now,
	onOpenThread,
	snapshot,
}: GlanceHomeProps) {
	const tl = useLiteralMessages();
	const waiting = useMemo(() => glanceWaitingOnYou(snapshot), [snapshot]);
	const [expanded, setExpanded] = useState(false);
	const near = distance === "near";
	const list = glanceListWindow(waiting.length, NEEDS_YOU_CAPACITY[distance]);
	const shown = expanded ? waiting : waiting.slice(0, list.shown);
	return (
		<Widget
			accessory={<HeaderCount>{waiting.length}</HeaderCount>}
			label={GLANCE_NEEDS_YOU_LABEL}
			size="large"
			title={GLANCE_NEEDS_YOU_LABEL}
		>
			{shown.length === 0 ? (
				<Quiet>Nothing needs you.</Quiet>
			) : (
				<ul
					className={cn(
						"flex flex-col",
						expanded &&
							"-mx-[1.6cqw] min-h-0 flex-1 overflow-y-auto px-[1.6cqw] [scrollbar-width:none]"
					)}
				>
					{shown.map((thread) => {
						const state = glanceThreadState(thread);
						return (
							<li key={thread.id}>
								<button
									aria-label={tl("Open {title}, {state}", {
										state: GLANCE_AGENT_STATE_LABELS[state],
										title: glanceThreadTitle(thread),
									})}
									className={cn(
										ROW_BUTTON,
										"grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-[1.6cqw] py-[1cqw]"
									)}
									onClick={() => onOpenThread(thread.id)}
									type="button"
								>
									<GlanceMark className="-translate-y-[0.15em]" state={state} />
									<span className="flex min-w-0 flex-col">
										<span
											className={cn(
												"truncate font-medium text-foreground",
												W.row
											)}
										>
											{glanceThreadTitle(thread)}
										</span>
										{near ? (
											<span
												className={cn("truncate", GLANCE_INK_SECONDARY, W.sub)}
											>
												{names(snapshot, thread)}
												{thread.lastMessage ? ` · ${thread.lastMessage}` : ""}
											</span>
										) : null}
									</span>
									<span
										className={cn("tabular-nums", GLANCE_INK_SECONDARY, W.sub)}
									>
										{compactAge(thread.updatedAt, now)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
			{list.hidden > 0 ? (
				<button
					aria-expanded={expanded}
					className={cn(
						ROW_BUTTON,
						"mt-auto shrink-0 py-[1cqw] font-medium",
						GLANCE_INK_SECONDARY,
						W.sub
					)}
					onClick={() => setExpanded((open) => !open)}
					type="button"
				>
					{expanded
						? "Show fewer"
						: tl("{hidden} more", { hidden: String(list.hidden) })}
				</button>
			) : null}
		</Widget>
	);
}

export function WorkingWidget({
	distance,
	onOpenThread,
	snapshot,
}: GlanceHomeProps) {
	const tl = useLiteralMessages();
	const working = useMemo(() => glanceWorking(snapshot), [snapshot]);
	const near = distance === "near";
	// A medium widget holds two single-line rows, or one row with its latest line.
	const shown = working.slice(0, near ? 1 : 2);
	return (
		<Widget
			accessory={<HeaderCount>{working.length}</HeaderCount>}
			label="Working"
			size="medium"
			title="Working"
		>
			{shown.length === 0 ? (
				<Quiet>No agent is working.</Quiet>
			) : (
				<ul className="flex flex-col gap-[0.4cqw]">
					{shown.map((thread) => {
						const lead = agentById(snapshot, thread.agentIds[0]);
						return (
							<li key={thread.id}>
								<button
									aria-label={tl("Open {title}", {
										title: glanceThreadTitle(thread),
									})}
									className={cn(
										ROW_BUTTON,
										"gap-[1.6cqw] py-[1cqw]",
										near ? "items-start" : "items-center"
									)}
									onClick={() => onOpenThread(thread.id)}
									type="button"
								>
									{lead ? (
										<GlanceAvatar
											agent={lead}
											className="size-[clamp(1.25rem,3.4cqw,1.75rem)]"
										/>
									) : null}
									<span className="flex min-w-0 flex-1 flex-col">
										<span
											className={cn(
												"truncate font-medium text-foreground",
												W.row
											)}
										>
											{glanceThreadTitle(thread)}
										</span>
										{near ? (
											<span
												className={cn(
													"line-clamp-2",
													GLANCE_INK_SECONDARY,
													W.sub
												)}
											>
												{lead?.name ?? names(snapshot, thread)}
												{thread.lastMessage ? ` · ${thread.lastMessage}` : ""}
											</span>
										) : null}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</Widget>
	);
}
