import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { useId } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { compactAge } from "./interface-renderer.ts";
import {
	type Planet,
	planetVariant,
	type ThreadSection,
} from "./planets-model.ts";
import {
	cssColor,
	type PlanetLook,
	type PlanetsPalette,
	planetLook,
	planetSwatch,
	type Rgb,
	sunShadow,
	sunSwatch,
} from "./planets-palette.ts";

/** Frosted surface for HUD pieces floating over the scene. */
export const GLASS =
	"border border-border/60 bg-background/94 shadow-foreground/5 shadow-sm backdrop-blur-md supports-[backdrop-filter]:bg-background/90";

export const STATUS_TONE: Record<ThreadStatus, string> = {
	attention: "text-status-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-status-success",
	"your-turn": "text-(--planets-turn)",
};

/**
 * The Board's status mark, except that "your turn" takes the palette's own
 * color (`--planets-turn`): in a theme whose accent is the same green as
 * "working", the scene moves "your turn" to a clear hue, and so does this.
 */
export function PlanetsStatusDot({
	className,
	pulse,
	status,
}: {
	className?: string;
	pulse?: boolean;
	status: ThreadStatus;
}) {
	if (status === "your-turn") {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"relative inline-block size-2 shrink-0 rounded-full bg-(--planets-turn)",
					className
				)}
			/>
		);
	}
	return <BoardStatusDot className={className} pulse={pulse} status={status} />;
}

/** A planet as a small lit sphere, in the same colors as the scene. */
export function PlanetSwatch({
	className,
	look: given,
	planet,
}: {
	className?: string;
	/** The planet's look in its agent's colour (`planetLooks`). */
	look?: PlanetLook;
	planet: Pick<Planet, "id" | "kind" | "working">;
}) {
	const look = given ?? planetLook(planet.kind, planetVariant(planet.id, 3));
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-block shrink-0 rounded-full shadow-[inset_-2px_-2px_4px] shadow-foreground/25",
				className
			)}
			style={{ background: planetSwatch(look) }}
		>
			{planet.kind === "ringed" ? (
				<span className="absolute top-1/2 left-1/2 h-[28%] w-[160%] -translate-x-1/2 -translate-y-1/2 -rotate-12 rounded-[50%] border border-foreground/30" />
			) : null}
		</span>
	);
}

/** You, the star, as a small glowing disc. */
export function SunSwatch({
	className,
	palette,
}: {
	className?: string;
	palette: PlanetsPalette;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn("inline-block shrink-0 rounded-full", className)}
			style={{
				background: sunSwatch(palette.sun),
				boxShadow: sunShadow(palette.sun),
			}}
		/>
	);
}

/**
 * A team, drawn the way its orbit looks in the scene and the legend: a short
 * soft band with a bright line through it.
 */
export function TeamMark({
	className,
	color,
}: {
	className?: string;
	color: Rgb;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-block h-1.5 w-3 shrink-0 rounded-full",
				className
			)}
			style={{ background: cssColor(color, 0.35) }}
		>
			<span
				className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 rounded-full"
				style={{ background: cssColor(color) }}
			/>
		</span>
	);
}

export function threadTitle(thread: InterfaceThread | undefined): string {
	if (!thread) {
		return "New thread";
	}
	return thread.title.trim() || "Untitled thread";
}

/** Threads grouped under status headings, each row opening the thread. */
export function ThreadSections({
	activeThreadId,
	now,
	onOpen,
	sections,
	snapshot,
	viewerId,
}: {
	activeThreadId: string | null;
	now: number;
	onOpen: (threadId: string) => void;
	sections: readonly ThreadSection[];
	snapshot: InterfaceSnapshot;
	/** The agent whose panel this is; other participants are named. */
	viewerId?: string;
}) {
	return (
		<div className="flex flex-col gap-4">
			{sections.map((section) => (
				<ThreadGroup
					activeThreadId={activeThreadId}
					key={section.status}
					now={now}
					onOpen={onOpen}
					section={section}
					snapshot={snapshot}
					viewerId={viewerId}
				/>
			))}
		</div>
	);
}

function ThreadGroup({
	activeThreadId,
	now,
	onOpen,
	section,
	snapshot,
	viewerId,
}: {
	activeThreadId: string | null;
	now: number;
	onOpen: (threadId: string) => void;
	section: ThreadSection;
	snapshot: InterfaceSnapshot;
	viewerId?: string;
}) {
	const headingId = `${useId()}-${section.status}`;
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-1">
			<h3
				className={cn(
					"flex items-center gap-2 px-2 font-medium text-xs",
					STATUS_TONE[section.status]
				)}
				id={headingId}
			>
				<PlanetsStatusDot status={section.status} />
				{THREAD_STATUS_LABELS[section.status]}
				<span className="text-muted-foreground tabular-nums">
					{section.threads.length}
				</span>
			</h3>
			<ul className="flex flex-col">
				{section.threads.map((thread) => (
					<li key={thread.id}>
						<ThreadRow
							active={thread.id === activeThreadId}
							now={now}
							onOpen={onOpen}
							snapshot={snapshot}
							thread={thread}
							viewerId={viewerId}
						/>
					</li>
				))}
			</ul>
		</section>
	);
}

function ThreadRow({
	active,
	now,
	onOpen,
	snapshot,
	thread,
	viewerId,
}: {
	active: boolean;
	now: number;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
	viewerId?: string;
}) {
	const tl = useLiteralMessages();
	const title = threadTitle(thread);
	const others = thread.agentIds
		.filter((agentId) => agentId !== viewerId)
		.map(
			(agentId) => snapshot.agents.find((agent) => agent.id === agentId)?.name
		)
		.filter((name): name is string => Boolean(name));
	const age = compactAge(thread.updatedAt, now);
	return (
		<button
			aria-current={active ? "true" : undefined}
			aria-label={tl("Open {title}", { title })}
			className="group flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring active:bg-muted/80 aria-[current=true]:bg-muted"
			onClick={() => onOpen(thread.id)}
			type="button"
		>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="truncate font-medium text-foreground text-sm">
						{title}
					</span>
					{thread.pinned ? (
						<span className="shrink-0 text-[10px] text-muted-foreground uppercase tracking-wide">
							Pinned
						</span>
					) : null}
				</span>
				{thread.lastMessage ? (
					<span className="line-clamp-2 text-muted-foreground text-xs leading-snug">
						{thread.lastMessageRole === "user" ? "You: " : ""}
						{thread.lastMessage}
					</span>
				) : null}
				{others.length > 0 ? (
					<span className="truncate text-muted-foreground/80 text-xs">
						{viewerId ? "Also with " : "With "}
						{others.join(", ")}
					</span>
				) : null}
			</span>
			{age ? (
				<span className="shrink-0 pt-0.5 text-muted-foreground text-xs tabular-nums">
					{age}
				</span>
			) : null}
		</button>
	);
}
