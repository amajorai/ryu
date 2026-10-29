import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import { useMemo } from "react";
import {
	buildGlanceAgents,
	buildGlanceFlow,
	GLANCE_AGENT_STATE_LABELS,
	GLANCE_NEEDS_YOU_LABEL,
	GLANCE_TILE_LIMIT,
	type GlanceAgentState,
	type GlanceAgentTile,
	type GlanceDistance,
	type GlanceFlowBlob,
	glanceClock,
	glanceListWindow,
	glanceRunWhen,
	glanceSharedGroup,
	glanceThreadTitle,
	glanceTileColumns,
	glanceUpcoming,
	glanceWaitingLine,
	glanceWaitingOnYou,
	glanceWorkingLine,
} from "./glance-model.ts";
import {
	GLANCE_INK_SECONDARY,
	GLANCE_STATE_TEXT,
	GlanceAvatar,
	GlanceMark,
	glanceThreadState,
} from "./glance-parts.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Type scale, in units of the display's own width (`cqw`) so a face reads the
 * same on a 7-inch square or a full window; clamps keep the small end legible.
 */
export const GLANCE_TYPE = {
	/** Far clock digits. */
	clock: "text-[25cqw] leading-[0.9] tracking-[-0.045em]",
	/** Near clock and flow digits. */
	clockNear: "text-[13cqw] leading-[0.9] tracking-[-0.04em]",
	/** Far captions: the one line under the clock. */
	lead: "text-[clamp(1rem,4.4cqw,2.125rem)] leading-tight tracking-[-0.01em]",
	/** Near rows: thread titles. */
	body: "text-[clamp(0.875rem,2.9cqw,1.375rem)] leading-snug tracking-[-0.005em]",
	/** Near secondary lines. */
	detail: "text-[clamp(0.75rem,2.3cqw,1.0625rem)] leading-snug",
} as const;

export interface GlanceFaceProps {
	distance: GlanceDistance;
	loading: boolean;
	now: number;
	onOpenThread: (threadId: string) => void;
	onStartWithAgent: (agentId: string) => void;
	snapshot: InterfaceSnapshot;
}

function agentNames(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string {
	const names = thread.agentIds
		.map((id) => agentById(snapshot, id)?.name)
		.filter((name): name is string => Boolean(name));
	return names.length > 0 ? names.join(", ") : "No agent";
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function ClockDigits({
	near,
	now,
	onArt = false,
}: {
	near: boolean;
	now: number;
	/** Over the flow art the date needs more ink than muted text gives. */
	onArt?: boolean;
}) {
	const date = new Date(now);
	const clock = glanceClock(date);
	return (
		<time
			className={cn("flex flex-col", near ? "gap-[1.4cqw]" : "gap-[2cqw]")}
			dateTime={date.toISOString()}
		>
			<span
				className={cn(
					"font-medium",
					onArt ? "text-foreground/75" : GLANCE_INK_SECONDARY,
					near ? GLANCE_TYPE.detail : GLANCE_TYPE.lead
				)}
			>
				{clock.date}
			</span>
			<span
				className={cn(
					"font-semibold text-foreground tabular-nums",
					near ? GLANCE_TYPE.clockNear : GLANCE_TYPE.clock
				)}
			>
				{clock.time}
				{clock.period ? <span className="sr-only"> {clock.period}</span> : null}
			</span>
		</time>
	);
}

function ThreadRow({
	now,
	onOpen,
	snapshot,
	thread,
}: {
	now: number;
	onOpen: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const state = glanceThreadState(thread);
	const title = glanceThreadTitle(thread);
	return (
		<li>
			<button
				aria-label={`Open ${title}, ${GLANCE_AGENT_STATE_LABELS[state]}`}
				className="group corner-squircle -mx-[2.4cqw] grid w-[calc(100%+4.8cqw)] grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-[2cqw] rounded-[2.4cqw] px-[2.4cqw] py-[1.6cqw] text-left outline-none transition-colors hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/[0.08]"
				onClick={onOpen}
				type="button"
			>
				<GlanceMark className="-translate-y-[0.2em]" state={state} />
				<span className="flex min-w-0 flex-col gap-[0.4cqw]">
					<span
						className={cn(
							"truncate font-semibold text-foreground",
							GLANCE_TYPE.body
						)}
					>
						{title}
					</span>
					<span
						className={cn("truncate", GLANCE_INK_SECONDARY, GLANCE_TYPE.detail)}
					>
						<span className="font-medium text-foreground/80">
							{agentNames(snapshot, thread)}
						</span>
						{thread.lastMessage ? ` · ${thread.lastMessage}` : null}
					</span>
				</span>
				<span
					className={cn(
						"tabular-nums",
						GLANCE_INK_SECONDARY,
						GLANCE_TYPE.detail
					)}
				>
					{compactAge(thread.updatedAt, now)}
				</span>
			</button>
		</li>
	);
}

/** The clock face: the time, the date, and how much is waiting on you. */
export function GlanceClockFace({
	distance,
	loading,
	now,
	onOpenThread,
	onShowAll,
	snapshot,
}: GlanceFaceProps & { onShowAll: () => void }) {
	const waiting = useMemo(() => glanceWaitingOnYou(snapshot), [snapshot]);
	const next = useMemo(() => glanceUpcoming(snapshot, now)[0], [snapshot, now]);
	const first = waiting[0];

	if (distance === "far") {
		return (
			<div className="flex size-full flex-col items-center justify-center gap-[4cqw] p-[7cqw] text-center">
				<ClockDigits near={false} now={now} />
				{loading ? (
					<Skeleton className="h-[4.4cqw] w-[36cqw] rounded-full" />
				) : (
					<button
						aria-label={
							first
								? `${glanceWaitingLine(waiting.length)}. Open ${glanceThreadTitle(first)}`
								: glanceWaitingLine(0)
						}
						className={cn(
							"inline-flex items-center gap-[1.8cqw] rounded-full px-[2.4cqw] py-[1cqw] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
							GLANCE_TYPE.lead,
							first
								? "text-foreground hover:bg-foreground/[0.05] active:bg-foreground/[0.08]"
								: cn("cursor-default", GLANCE_INK_SECONDARY)
						)}
						disabled={!first}
						onClick={first ? () => onOpenThread(first.id) : undefined}
						type="button"
					>
						<GlanceMark
							className="size-[1.6cqw]"
							state={first ? "your-turn" : "idle"}
						/>
						{glanceWaitingLine(waiting.length)}
					</button>
				)}
			</div>
		);
	}

	const list = glanceListWindow(waiting.length, 5);
	const shown = waiting.slice(0, list.shown);
	const nextAgent = next ? agentById(snapshot, next.agentId) : undefined;
	return (
		<div className="flex size-full flex-col p-[7cqw]">
			<ClockDigits near now={now} />
			<section
				aria-label={GLANCE_NEEDS_YOU_LABEL}
				className="mt-[7cqw] flex min-h-0 flex-col gap-[1.6cqw]"
			>
				<h3
					className={cn(
						"flex items-baseline justify-between font-semibold text-foreground",
						GLANCE_TYPE.detail
					)}
				>
					{GLANCE_NEEDS_YOU_LABEL}
					<span
						className={cn("font-medium tabular-nums", GLANCE_INK_SECONDARY)}
					>
						{loading ? null : waiting.length}
					</span>
				</h3>
				{!loading && waiting.length === 0 ? (
					<p className={cn(GLANCE_INK_SECONDARY, GLANCE_TYPE.body)}>
						{glanceWaitingLine(0)}
					</p>
				) : null}
				{loading ? (
					<div className="flex flex-col gap-[3cqw] pt-[1.6cqw]">
						<Skeleton className="h-[3cqw] w-3/4 rounded-full" />
						<Skeleton className="h-[3cqw] w-2/3 rounded-full" />
						<Skeleton className="h-[3cqw] w-1/2 rounded-full" />
					</div>
				) : null}
				{!loading && shown.length > 0 ? (
					<ul className="flex flex-col">
						{shown.map((thread) => (
							<ThreadRow
								key={thread.id}
								now={now}
								onOpen={() => onOpenThread(thread.id)}
								snapshot={snapshot}
								thread={thread}
							/>
						))}
					</ul>
				) : null}
				{!loading && list.hidden > 0 ? (
					<button
						className={cn(
							"corner-squircle -mx-[2.4cqw] self-start rounded-[2.4cqw] px-[2.4cqw] py-[1cqw] font-medium outline-none transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/[0.08]",
							GLANCE_INK_SECONDARY,
							GLANCE_TYPE.detail
						)}
						onClick={onShowAll}
						type="button"
					>
						{list.hidden} more on the Home Screen
					</button>
				) : null}
			</section>
			{next ? (
				<p
					className={cn(
						"mt-auto flex min-w-0 items-baseline gap-[1.6cqw] pt-[4cqw]",
						GLANCE_INK_SECONDARY,
						GLANCE_TYPE.detail
					)}
				>
					<span className="shrink-0 font-semibold">Next run</span>
					<span className="truncate">
						<span className="font-medium text-foreground">{next.title}</span>
						{nextAgent ? ` · ${nextAgent.name}` : null}
					</span>
					<span className="ml-auto shrink-0 tabular-nums">
						{glanceRunWhen(next.start, now)}
					</span>
				</p>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Agents (modular tiles)
// ---------------------------------------------------------------------------

function tileLabel(tile: GlanceAgentTile): string {
	const state = GLANCE_AGENT_STATE_LABELS[tile.state];
	if (tile.thread) {
		return `${tile.agent.name}, ${state}. Open ${glanceThreadTitle(tile.thread)}`;
	}
	return `${tile.agent.name}, ${state}. Start a thread`;
}

/** A tile's state: the mark carries the hue, the word names it. */
function TileStatus({
	near,
	state,
}: {
	near: boolean;
	state: GlanceAgentState;
}) {
	return (
		<span
			className={cn(
				"flex min-w-0 items-center font-semibold",
				near
					? cn("gap-[1.2cqw]", GLANCE_TYPE.detail)
					: "gap-[1.6cqw] text-[clamp(0.9375rem,3.4cqw,1.625rem)] leading-tight tracking-[-0.01em]"
			)}
		>
			<GlanceMark
				className={
					near
						? "size-[1.2cqw] min-h-1.5 min-w-1.5"
						: "size-[1.6cqw] min-h-2 min-w-2"
				}
				state={state}
			/>
			<span className={cn("truncate", GLANCE_STATE_TEXT[state])}>
				{GLANCE_AGENT_STATE_LABELS[state]}
			</span>
		</span>
	);
}

function AgentTile({
	near,
	onOpen,
	snapshot,
	tile,
}: {
	near: boolean;
	onOpen: () => void;
	snapshot: InterfaceSnapshot;
	tile: GlanceAgentTile;
}) {
	const { agent, state, thread } = tile;
	const group = thread ? glanceSharedGroup(snapshot, thread) : null;
	const name = (
		<span
			className={cn(
				"truncate font-semibold text-foreground",
				near
					? "text-[clamp(0.9375rem,3.3cqw,1.5rem)] leading-tight tracking-[-0.01em]"
					: "text-[clamp(1.125rem,5.2cqw,2.5rem)] leading-[1.1] tracking-[-0.025em]"
			)}
		>
			{agent.name}
		</span>
	);
	return (
		<button
			aria-label={tileLabel(tile)}
			className="corner-squircle flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[4.4cqw] bg-muted p-[3.6cqw] text-left outline-none transition-[background-color,scale] duration-200 hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:active:scale-100"
			data-agent-id={agent.id}
			data-state={state}
			onClick={onOpen}
			type="button"
		>
			{near ? (
				<>
					<span className="flex min-w-0 items-center gap-[2.4cqw]">
						<GlanceAvatar
							agent={agent}
							className={cn("size-[7cqw]", !tile.active && "opacity-70")}
						/>
						<span className="flex min-w-0 flex-col gap-[0.4cqw]">
							{name}
							<TileStatus near state={state} />
						</span>
					</span>
					<span className="mt-auto flex min-w-0 flex-col gap-[0.6cqw] pt-[2cqw]">
						{thread ? (
							<>
								<span
									className={cn(
										"truncate font-medium text-foreground",
										GLANCE_TYPE.detail
									)}
								>
									{group ? (
										<span className={GLANCE_INK_SECONDARY}>{group} · </span>
									) : null}
									{glanceThreadTitle(thread)}
								</span>
								<span
									className={cn(
										"line-clamp-2",
										GLANCE_INK_SECONDARY,
										GLANCE_TYPE.detail
									)}
								>
									{thread.lastMessage ?? "No messages yet"}
								</span>
							</>
						) : (
							<span className={cn(GLANCE_INK_SECONDARY, GLANCE_TYPE.detail)}>
								No threads yet
							</span>
						)}
					</span>
				</>
			) : (
				<>
					<GlanceAvatar
						agent={agent}
						className={cn("size-[9cqw]", !tile.active && "opacity-70")}
					/>
					{/* Far reads across a room: who, and where they stand. */}
					<span className="mt-auto flex min-w-0 flex-col gap-[1cqw] pt-[2cqw]">
						{name}
						<TileStatus near={false} state={state} />
					</span>
				</>
			)}
		</button>
	);
}

const SKELETON_TILES = ["a", "b", "c", "d", "e", "f"] as const;

/** The agents face: one large tile per agent, like Home's modular face. */
export function GlanceAgentsFace({
	distance,
	loading,
	onOpenThread,
	onShowAll,
	onStartThread,
	onStartWithAgent,
	snapshot,
}: GlanceFaceProps & { onShowAll: () => void; onStartThread: () => void }) {
	const tiles = useMemo(() => buildGlanceAgents(snapshot), [snapshot]);
	const near = distance === "near";

	if (loading) {
		// The same grid six loaded tiles take, so nothing jumps when data lands.
		const skeletonColumns = glanceTileColumns(SKELETON_TILES.length);
		return (
			<div
				className="grid size-full gap-[2.8cqw] p-[4.4cqw]"
				style={{
					gridTemplateColumns: `repeat(${skeletonColumns}, minmax(0, 1fr))`,
					gridTemplateRows: `repeat(${Math.ceil(SKELETON_TILES.length / skeletonColumns)}, minmax(0, 1fr))`,
				}}
			>
				{SKELETON_TILES.map((key) => (
					<Skeleton
						className="corner-squircle rounded-[4.4cqw] bg-muted"
						key={key}
					/>
				))}
			</div>
		);
	}

	if (tiles.length === 0) {
		return (
			<div className="flex size-full flex-col items-center justify-center gap-[2.4cqw] p-[8cqw] text-center">
				<h3 className={cn("font-semibold text-foreground", GLANCE_TYPE.lead)}>
					No agents yet
				</h3>
				<p
					className={cn(
						"max-w-[56cqw]",
						GLANCE_INK_SECONDARY,
						GLANCE_TYPE.body
					)}
				>
					Agents you add appear here.
				</p>
				<Button
					className="mt-[1.6cqw]"
					onClick={onStartThread}
					type="button"
					variant="secondary"
				>
					New thread
				</Button>
			</div>
		);
	}

	const overflow = tiles.length > GLANCE_TILE_LIMIT;
	const shown = overflow ? tiles.slice(0, GLANCE_TILE_LIMIT - 1) : tiles;
	const cells = shown.length + (overflow ? 1 : 0);
	const columns = glanceTileColumns(cells);
	const rows = Math.ceil(cells / columns);
	return (
		<ul
			aria-label="Agents"
			className="grid size-full gap-[2.8cqw] p-[4.4cqw]"
			style={{
				gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
				gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
			}}
		>
			{shown.map((tile) => (
				<li className="flex min-h-0 min-w-0 *:flex-1" key={tile.agent.id}>
					<AgentTile
						near={near}
						onOpen={() =>
							tile.thread
								? onOpenThread(tile.thread.id)
								: onStartWithAgent(tile.agent.id)
						}
						snapshot={snapshot}
						tile={tile}
					/>
				</li>
			))}
			{overflow ? (
				<li className="flex min-h-0 min-w-0 *:flex-1">
					<button
						className={cn(
							"corner-squircle flex flex-col justify-end rounded-[4.4cqw] bg-muted p-[3.6cqw] text-left font-semibold text-foreground outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring",
							GLANCE_TYPE.lead
						)}
						onClick={onShowAll}
						type="button"
					>
						{tiles.length - shown.length} more
					</button>
				</li>
			) : null}
		</ul>
	);
}

// ---------------------------------------------------------------------------
// Flow (ambient art)
// ---------------------------------------------------------------------------

/** A soft light: full strength at the centre, eased out to nothing at the edge. */
function flowGradient(blob: GlanceFlowBlob): string {
	const ink = (share: number) =>
		`color-mix(in oklab, var(--${blob.tone}) ${Math.round(blob.strength * share * 100)}%, transparent)`;
	return `radial-gradient(closest-side, ${ink(1)} 0%, ${ink(0.72)} 30%, ${ink(0.32)} 60%, ${ink(0.08)} 85%, transparent 100%)`;
}

function FlowBlob({
	animate,
	blob,
}: {
	animate: boolean;
	blob: GlanceFlowBlob;
}) {
	const reach = `${blob.reach * 100}%`;
	const back = `${-blob.reach * 70}%`;
	return (
		<motion.div
			animate={
				animate
					? {
							scale: [1, blob.working ? 1.18 : 1.06, 0.96, 1],
							x: ["0%", reach, back, "0%"],
							y: ["0%", back, reach, "0%"],
						}
					: undefined
			}
			className="absolute rounded-full"
			data-flow-blob={blob.id}
			style={{
				background: flowGradient(blob),
				height: `${blob.size * 100}%`,
				left: `${(blob.x - blob.size / 2) * 100}%`,
				top: `${(blob.y - blob.size / 2) * 100}%`,
				width: `${blob.size * 100}%`,
			}}
			transition={{
				duration: blob.duration,
				ease: "easeInOut",
				repeat: Number.POSITIVE_INFINITY,
			}}
		/>
	);
}

/**
 * The flow face: soft light that drifts with the work. Each agent is a glow
 * placed by its id; live runs glow larger and move faster. Static when the
 * viewer prefers reduced motion.
 */
export function GlanceFlowFace({
	distance,
	loading,
	now,
	onOpenThread,
	snapshot,
}: GlanceFaceProps) {
	const reduceMotion = useReducedMotion();
	const blobs = useMemo(() => buildGlanceFlow(snapshot), [snapshot]);
	// Every coloured light in the art has a row that names it: agents that
	// need attention first, then the ones at work.
	const lit = useMemo(
		() =>
			buildGlanceAgents(snapshot)
				.filter(
					(tile) =>
						tile.thread !== null &&
						(tile.state === "attention" || tile.state === "working")
				)
				.sort(
					(a, b) =>
						Number(b.state === "attention") - Number(a.state === "attention")
				),
		[snapshot]
	);
	const workingAgents = snapshot.agents.filter(
		(agent) => agent.status === "working"
	).length;
	const near = distance === "near";
	return (
		<div className="relative size-full overflow-hidden">
			<div aria-hidden="true" className="absolute inset-0">
				{blobs.map((blob) => (
					<FlowBlob animate={!reduceMotion} blob={blob} key={blob.id} />
				))}
			</div>
			<div className="relative flex size-full flex-col p-[7cqw]">
				<ClockDigits near={near} now={now} onArt />
				<div className="mt-auto flex flex-col gap-[2.4cqw]">
					{loading ? (
						<Skeleton className="h-[4.4cqw] w-[40cqw] rounded-full" />
					) : (
						<p
							className={cn("font-semibold text-foreground", GLANCE_TYPE.lead)}
						>
							{glanceWorkingLine(workingAgents)}
						</p>
					)}
					{near && !loading && lit.length > 0 ? (
						<ul className="flex flex-col">
							{lit.slice(0, 3).map(({ agent, state, thread }) =>
								thread ? (
									<li key={agent.id}>
										<button
											aria-label={`Open ${glanceThreadTitle(thread)}, ${agent.name}, ${GLANCE_AGENT_STATE_LABELS[state]}`}
											className={cn(
												"corner-squircle -mx-[2.4cqw] grid w-[calc(100%+4.8cqw)] min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-[1.8cqw] rounded-[2.4cqw] px-[2.4cqw] py-[1.2cqw] text-left outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring",
												GLANCE_TYPE.body
											)}
											onClick={() => onOpenThread(thread.id)}
											type="button"
										>
											<GlanceMark
												className="-translate-y-[0.15em]"
												state={state}
											/>
											<span className="font-semibold text-foreground">
												{agent.name}
											</span>
											<span className="truncate text-foreground/75">
												{state === "attention" ? (
													<span className="font-medium text-destructive">
														{GLANCE_AGENT_STATE_LABELS[state]}
														{" · "}
													</span>
												) : null}
												{glanceThreadTitle(thread)}
											</span>
										</button>
									</li>
								) : null
							)}
						</ul>
					) : null}
				</div>
			</div>
		</div>
	);
}
