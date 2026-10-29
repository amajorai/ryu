import { useLiteralMessages } from "@ryu/i18n/react";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowUpLeft } from "lucide-react";
import type { KeyboardEvent } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { MOMENTS_FOCUS, MOMENTS_KBD, MomentsGlyph } from "./moments-glyph.tsx";
import {
	type MomentsDay,
	type MomentsFlow,
	type MomentsModule,
	type MomentsSegment,
	momentsFlowSummary,
	momentsUpdatedLabel,
} from "./moments-model.ts";

/** Attribute the home timeline uses to find flow cards for arrow keys. */
export const MOMENTS_FLOW_ATTRIBUTE = "data-moments-flow";

const GLYPH_LIMIT = 5;
const STACK_LIMIT = 3;

/**
 * A day heading in light display type with a small arrow, its flow count,
 * and a hairline running out to the edge so each day reads as a section.
 */
function DayHeading({
	count,
	id,
	label,
}: {
	count?: number;
	id: string;
	label: string;
}) {
	return (
		<div className="flex items-center gap-3">
			<h2
				className="flex shrink-0 items-center gap-1.5 font-light text-3xl text-foreground tracking-tight"
				id={id}
			>
				{label}
				<ArrowUpLeft
					aria-hidden="true"
					className="mt-1 size-5 text-muted-foreground"
					strokeWidth={1.5}
				/>
			</h2>
			{count === undefined ? null : (
				<span className="shrink-0 pt-1.5 text-muted-foreground text-sm tabular-nums">
					{count} {count === 1 ? "flow" : "flows"}
				</span>
			)}
			<span
				aria-hidden="true"
				className="mt-1.5 h-px flex-1 bg-foreground/10"
			/>
		</div>
	);
}

/** One module as a miniature: who, what, and the latest line. */
function MiniModule({ item }: { item: MomentsModule }) {
	return (
		<span className="flex size-full flex-col overflow-hidden rounded-lg bg-card p-3 text-card-foreground">
			<span className="flex h-4 items-center gap-1.5 text-card-foreground/70 text-xs leading-4">
				<BoardStatusDot className="size-1.5" status={item.status} />
				<span className="truncate">{item.lead?.name ?? "No agent"}</span>
			</span>
			<span className="mt-2 line-clamp-2 font-medium text-[13px] leading-[18px]">
				{item.thread.title}
			</span>
			{item.thread.lastMessage ? (
				<span className="mt-1 line-clamp-2 text-card-foreground/70 text-xs leading-4 max-sm:hidden">
					{item.thread.lastMessage}
				</span>
			) : null}
		</span>
	);
}

/** Shared frame for every sheet in a stack. */
const SHEET =
	"absolute inset-0 origin-center rounded-lg transition-transform duration-300 ease-out motion-reduce:transition-none";

/**
 * Back sheets fan out to the left like a hand of cards, far enough that each
 * one's edge reads; they are blank, so nothing clipped peeks out. Hover opens
 * the fan a little further.
 */
const SHEET_DEPTH = [
	"z-30 shadow-foreground/10 shadow-md",
	"z-20 -translate-x-4 -rotate-4 bg-card/80 shadow-foreground/5 shadow-sm group-hover:-translate-x-5 group-hover:-rotate-5",
	"z-10 -translate-x-8 -rotate-8 bg-card/60 shadow-foreground/5 shadow-sm group-hover:-translate-x-10 group-hover:-rotate-10",
] as const;

/**
 * The fanned stack on the right of a flow card: its front module as a
 * miniature, with one blank sheet behind it for each further module (up to
 * two). Below 640px the stack shrinks to its front sheet and one behind it.
 */
function ModuleStack({ modules }: { modules: MomentsModule[] }) {
	const front = modules[0];
	if (!front) {
		return null;
	}
	const backs = Math.min(modules.length, STACK_LIMIT) - 1;
	return (
		<span
			aria-hidden="true"
			className="relative my-4 mr-4 ml-4 w-28 shrink-0 sm:my-5 sm:mr-5 sm:ml-8 sm:w-40"
		>
			{backs >= 2 ? (
				<span className={cn(SHEET, SHEET_DEPTH[2], "max-sm:hidden")} />
			) : null}
			{backs >= 1 ? <span className={cn(SHEET, SHEET_DEPTH[1])} /> : null}
			<span className={cn(SHEET, SHEET_DEPTH[0])}>
				<MiniModule item={front} />
			</span>
		</span>
	);
}

/** The featured flow lays its first modules out side by side instead. */
function ModuleRow({ modules }: { modules: MomentsModule[] }) {
	return (
		<span
			aria-hidden="true"
			className="my-5 mr-5 ml-8 flex shrink-0 gap-3 max-[1099px]:hidden"
		>
			{modules.slice(0, STACK_LIMIT).map((item) => (
				<span
					className="w-44 shrink-0 rounded-lg shadow-foreground/10 shadow-md"
					key={item.thread.id}
				>
					<MiniModule item={item} />
				</span>
			))}
		</span>
	);
}

function FlowGlyphs({ flow }: { flow: MomentsFlow }) {
	if (flow.agents.length === 0) {
		return null;
	}
	return (
		<span aria-hidden="true" className="flex items-center gap-1.5">
			{flow.agents.slice(0, GLYPH_LIMIT).map((agent) => (
				<MomentsGlyph agent={agent} key={agent.id} size="lg" />
			))}
		</span>
	);
}

function FlowCard({
	featured = false,
	flow,
	index,
	now,
	onOpen,
	selected,
}: {
	/** The day's lead flow: full width, larger type, modules side by side. */
	featured?: boolean;
	flow: MomentsSegment;
	index: number;
	now: number;
	onOpen: (flow: MomentsSegment) => void;
	selected: boolean;
}) {
	const tl = useLiteralMessages();
	const running = flow.modules.filter(
		(item) => item.status === "working"
	).length;
	const updated = momentsUpdatedLabel(flow.latestAt, now);
	return (
		<button
			className={cn(
				"group relative flex w-full rounded-xl bg-card/50 text-left transition-colors duration-200 hover:bg-card/75 active:bg-card/90",
				featured
					? "h-40 bg-card/70 shadow-foreground/5 shadow-sm sm:h-56"
					: "h-36 sm:h-44",
				MOMENTS_FOCUS
			)}
			data-moments-flow={index}
			onClick={() => onOpen(flow)}
			tabIndex={selected ? 0 : -1}
			type="button"
		>
			<span
				className={cn(
					"flex min-w-0 flex-1 flex-col p-4 sm:p-5",
					featured && "sm:p-7"
				)}
			>
				{featured ? (
					<span className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">
						Latest
					</span>
				) : null}
				<span
					className={cn(
						"truncate text-foreground",
						featured
							? "font-light text-xl tracking-tight sm:text-3xl"
							: "font-medium text-base leading-6"
					)}
				>
					{flow.name}
				</span>
				<span className="mt-1 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[13px] text-muted-foreground leading-5">
					{updated}
					{running > 0 ? (
						<>
							<span aria-hidden="true">·</span>
							<span className="inline-flex items-center gap-1.5">
								<BoardStatusDot className="size-1.5" status="working" />
								{tl("{running} running", { running })}
							</span>
						</>
					) : null}
				</span>
				<span className="mt-auto flex flex-col gap-2.5">
					<FlowGlyphs flow={flow} />
					<span className="truncate text-[13px] text-muted-foreground leading-5">
						{momentsFlowSummary(flow)}
					</span>
				</span>
			</span>
			{featured ? (
				<>
					<ModuleRow modules={flow.preview} />
					<span className="flex min-[1100px]:hidden">
						<ModuleStack modules={flow.preview} />
					</span>
				</>
			) : (
				<ModuleStack modules={flow.preview} />
			)}
		</button>
	);
}

/** Placeholder timeline while the host's first snapshot loads. */
export function MomentsHomeSkeleton() {
	return (
		<div
			aria-busy="true"
			className="flex flex-col gap-10"
			data-testid="moments-loading"
			role="status"
		>
			<span className="sr-only">Loading flows</span>
			{["today", "earlier"].map((key) => (
				<div className="flex flex-col gap-4" key={key}>
					<Skeleton className="h-7 w-28 bg-foreground/5" radius="dense" />
					<div className="grid grid-cols-1 gap-4 min-[1100px]:grid-cols-2">
						<Skeleton className="h-40 bg-card/50" radius="panel" />
						<Skeleton className="h-40 bg-card/50" radius="panel" />
					</div>
				</div>
			))}
		</div>
	);
}

/** What the timeline says before there is anything on it. */
export function MomentsHomeEmpty({ hasAgents }: { hasAgents: boolean }) {
	return (
		<section
			aria-labelledby="moments-empty-day"
			className="flex flex-col gap-4"
		>
			<DayHeading id="moments-empty-day" label="Today" />
			<div
				className="flex h-40 flex-col justify-center gap-2 rounded-xl bg-card/50 px-5"
				data-testid="moments-empty"
			>
				<p className="text-[15px] text-foreground leading-5">
					{hasAgents ? "Nothing in motion yet" : "No agents yet"}
				</p>
				<p className="max-w-md text-muted-foreground text-sm leading-5">
					{hasAgents ? (
						<>
							Type what you would like to do above. Start with{" "}
							<Kbd className={MOMENTS_KBD}>@</Kbd> to choose the agent.
							Conversations gather here as flows.
						</>
					) : (
						"Add an agent to start a conversation. Conversations gather here as flows, by project, team, and agent."
					)}
				</p>
			</div>
		</section>
	);
}

/**
 * The home timeline: day headings with their flows, newest first. Arrow keys
 * move between flows; Enter opens one.
 */
export function MomentsHome({
	days,
	now,
	onKeyDown,
	onOpen,
	selectedId,
}: {
	days: MomentsDay[];
	now: number;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
	onOpen: (flow: MomentsSegment) => void;
	selectedId: string | null;
}) {
	let index = 0;
	return (
		<div
			aria-label="Flows"
			className="flex flex-col gap-10"
			onKeyDown={onKeyDown}
			role="group"
		>
			{days.map((day) => {
				const headingId = `moments-day-${day.key}`;
				return (
					<section
						aria-labelledby={headingId}
						className="flex flex-col gap-4"
						key={day.key}
					>
						<DayHeading
							count={day.flows.length}
							id={headingId}
							label={day.label}
						/>
						<ul className="grid grid-cols-1 gap-4 min-[1100px]:grid-cols-2">
							{day.flows.map((flow) => {
								const position = index;
								index += 1;
								// The newest flow leads the timeline at full width.
								const featured = position === 0;
								return (
									<li
										className={cn(featured && "min-[1100px]:col-span-2")}
										key={flow.id}
									>
										<FlowCard
											featured={featured}
											flow={flow}
											index={position}
											now={now}
											onOpen={onOpen}
											selected={
												selectedId ? flow.id === selectedId : position === 0
											}
										/>
									</li>
								);
							})}
						</ul>
					</section>
				);
			})}
		</div>
	);
}
