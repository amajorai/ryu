import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ArrowLeft, X } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, type Ref, useId } from "react";
import { InterfaceComposer } from "./interface-composer.tsx";
import {
	PLANET_KIND_LABELS,
	type Planet,
	type PlanetSystem,
	plural,
	sectionThreads,
	threadsWaitingOnYou,
} from "./planets-model.ts";
import {
	type PlanetsPalette,
	planetLookIn,
	teamColor,
} from "./planets-palette.ts";
import {
	PlanetSwatch,
	PlanetsStatusDot,
	STATUS_TONE,
	SunSwatch,
	TeamMark,
	ThreadSections,
	threadTitle,
} from "./planets-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export type PlanetsPanelView =
	| { kind: "planet"; planet: Planet }
	| { kind: "star" }
	| {
			kind: "thread";
			planet: Planet | undefined;
			thread: InterfaceThread | undefined;
	  };

const HEADING =
	"truncate font-heading font-semibold text-foreground leading-tight outline-none";
/** The list fades out above the composer instead of being cut flat. */
const SCROLL_FADE =
	"min-h-0 flex-1 [mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]";

/**
 * The side panel. A planet shows its agent (who they are, their threads by
 * status, and a composer that messages them); the star shows what is waiting
 * on you and the threads no agent is on; an open thread is the host's own
 * conversation surface, with a way back to its planet.
 */
export function PlanetsPanel({
	activeThreadId,
	headingRef,
	id,
	now,
	onBack,
	onClose,
	onMessage,
	onOpen,
	palette,
	snapshot,
	system,
	threadView,
	view,
}: {
	activeThreadId: string | null;
	headingRef: Ref<HTMLHeadingElement>;
	id: string;
	now: number;
	onBack: () => void;
	onClose: () => void;
	onMessage: (input: { agentId?: string; prompt: string }) => void;
	onOpen: (threadId: string) => void;
	palette: PlanetsPalette;
	snapshot: InterfaceSnapshot;
	system: PlanetSystem;
	threadView: ReactNode;
	view: PlanetsPanelView;
}) {
	const reduceMotion = useReducedMotion();
	let label = "You";
	if (view.kind === "planet") {
		label = view.planet.name;
	} else if (view.kind === "thread") {
		label = `Thread: ${threadTitle(view.thread)}`;
	}
	return (
		<motion.aside
			animate={{ opacity: 1, transform: "translateX(0px)" }}
			aria-label={label}
			className={cn(
				"relative z-30 flex min-h-0 shrink-0 flex-col border-border border-l bg-background shadow-[-24px_0_48px_-36px] shadow-foreground/40",
				// Widening for a thread glides rather than jumps.
				"transition-[width] duration-300 ease-out motion-reduce:transition-none",
				view.kind === "thread"
					? "w-[clamp(420px,40%,640px)]"
					: "w-[360px] xl:w-[384px]",
				"max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:w-full max-md:min-w-0 max-md:max-w-none max-md:border-l-0"
			)}
			data-testid="planets-panel"
			data-view={view.kind}
			id={id}
			initial={
				reduceMotion ? false : { opacity: 0, transform: "translateX(28px)" }
			}
			transition={
				reduceMotion
					? { duration: 0 }
					: { duration: 0.24, ease: [0.22, 1, 0.36, 1] }
			}
		>
			{view.kind === "thread" ? (
				<ThreadPane
					headingRef={headingRef}
					onBack={onBack}
					onClose={onClose}
					planet={view.planet}
					system={system}
					thread={view.thread}
					threadView={threadView}
				/>
			) : null}
			{view.kind === "planet" ? (
				<PlanetPane
					activeThreadId={activeThreadId}
					headingRef={headingRef}
					now={now}
					onClose={onClose}
					onMessage={onMessage}
					onOpen={onOpen}
					palette={palette}
					planet={view.planet}
					snapshot={snapshot}
					system={system}
				/>
			) : null}
			{view.kind === "star" ? (
				<StarPane
					activeThreadId={activeThreadId}
					headingRef={headingRef}
					now={now}
					onClose={onClose}
					onMessage={onMessage}
					onOpen={onOpen}
					palette={palette}
					snapshot={snapshot}
					system={system}
				/>
			) : null}
		</motion.aside>
	);
}

function CloseButton({
	label,
	onClose,
}: {
	label: string;
	onClose: () => void;
}) {
	return (
		<div className="flex shrink-0 items-center gap-1.5">
			<Kbd className="border border-border bg-transparent text-muted-foreground max-sm:hidden">
				Esc
			</Kbd>
			<Button
				aria-label={label}
				onClick={onClose}
				size="icon-sm"
				title={`${label} (Esc)`}
				type="button"
				variant="ghost"
			>
				<X aria-hidden="true" />
			</Button>
		</div>
	);
}

function Stat({
	label,
	tone,
	value,
}: {
	label: string;
	tone?: "attention" | "working" | "your-turn";
	value: number;
}) {
	return (
		<div className="flex flex-col gap-0.5 px-3 py-2.5">
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd
				className={cn(
					"font-heading font-semibold text-foreground text-lg tabular-nums leading-tight",
					tone ? STATUS_TONE[tone] : null
				)}
			>
				{value}
			</dd>
		</div>
	);
}

function EmptyNote({ children }: { children: ReactNode }) {
	return (
		<p className="rounded-xl border border-border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
			{children}
		</p>
	);
}

function PlanetPane({
	activeThreadId,
	headingRef,
	now,
	onClose,
	onMessage,
	onOpen,
	palette,
	planet,
	snapshot,
	system,
}: {
	activeThreadId: string | null;
	headingRef: Ref<HTMLHeadingElement>;
	now: number;
	onClose: () => void;
	onMessage: (input: { agentId?: string; prompt: string }) => void;
	onOpen: (threadId: string) => void;
	palette: PlanetsPalette;
	planet: Planet;
	snapshot: InterfaceSnapshot;
	system: PlanetSystem;
}) {
	const { agent } = planet;
	const sections = sectionThreads(planet.threads);
	const needsYou = planet.counts.attention + planet.counts["your-turn"];
	const teams = system.teams.filter((team) =>
		team.memberIds.includes(agent.id)
	);
	let needsTone: "attention" | "your-turn" | undefined;
	if (planet.counts.attention > 0) {
		needsTone = "attention";
	} else if (needsYou > 0) {
		needsTone = "your-turn";
	}
	return (
		<>
			<header className="flex shrink-0 items-start gap-3 border-border border-b p-4">
				<PlanetSwatch
					className={cn(
						"mt-0.5 size-11",
						// A ring overhangs the disc; keep it clear of the name.
						planet.kind === "ringed" && "mx-1.5"
					)}
					look={planetLookIn(system, planet.id)}
					planet={planet}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
					<h2
						className={cn(HEADING, "text-base")}
						ref={headingRef}
						tabIndex={-1}
					>
						{agent.name}
					</h2>
					<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
						{planet.working ? (
							<>
								<PlanetsStatusDot className="size-1.5" status="working" />
								<span className="text-status-success">Working</span>
							</>
						) : (
							<>
								<span
									aria-hidden="true"
									className="size-1.5 rounded-full bg-muted-foreground/50"
								/>
								<span>Idle</span>
							</>
						)}
						<span aria-hidden="true">·</span>
						<span className="truncate">{PLANET_KIND_LABELS[planet.kind]}</span>
						<span aria-hidden="true">·</span>
						<span className="shrink-0">Orbit {planet.index + 1}</span>
					</p>
				</div>
				<CloseButton label="Close panel" onClose={onClose} />
			</header>
			<ScrollArea className={SCROLL_FADE}>
				<div className="flex flex-col gap-5 p-4 pb-7">
					{agent.description || teams.length > 0 ? (
						<div className="flex flex-col gap-3">
							{agent.description ? (
								<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
									{agent.description}
								</p>
							) : null}
							{teams.length > 0 ? (
								<ul aria-label="Teams" className="flex flex-wrap gap-1.5">
									{teams.map((team) => (
										<li key={team.id}>
											<Badge variant="outline">
												<TeamMark color={teamColor(palette, team.colorIndex)} />
												{team.name}
											</Badge>
										</li>
									))}
								</ul>
							) : null}
						</div>
					) : null}
					<dl className="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-xl border border-border bg-card">
						<Stat label="Moons" value={planet.threadCount} />
						<Stat label="Waiting on you" tone={needsTone} value={needsYou} />
						<Stat
							label="Working"
							tone={planet.counts.working > 0 ? "working" : undefined}
							value={planet.counts.working}
						/>
					</dl>
					{sections.length === 0 ? (
						<EmptyNote>
							No threads with {agent.name} yet. Say hello below.
						</EmptyNote>
					) : (
						<ThreadSections
							activeThreadId={activeThreadId}
							now={now}
							onOpen={onOpen}
							sections={sections}
							snapshot={snapshot}
							viewerId={agent.id}
						/>
					)}
					{planet.overflow > 0 ? (
						<p className="px-2 text-muted-foreground text-xs">
							{plural(planet.overflow, "thread")} beyond the first eight are
							listed here but not drawn as moons.
						</p>
					) : null}
				</div>
			</ScrollArea>
			<div
				className="shrink-0 border-border border-t bg-background p-3"
				data-planets-composer=""
			>
				<InterfaceComposer
					label={`Message ${agent.name}`}
					onSubmit={({ prompt }) => onMessage({ agentId: agent.id, prompt })}
					placeholder={`Message ${agent.name}…`}
					submitLabel="Send"
				/>
			</div>
		</>
	);
}

function StarPane({
	activeThreadId,
	headingRef,
	now,
	onClose,
	onMessage,
	onOpen,
	palette,
	snapshot,
	system,
}: {
	activeThreadId: string | null;
	headingRef: Ref<HTMLHeadingElement>;
	now: number;
	onClose: () => void;
	onMessage: (input: { agentId?: string; prompt: string }) => void;
	onOpen: (threadId: string) => void;
	palette: PlanetsPalette;
	snapshot: InterfaceSnapshot;
	system: PlanetSystem;
}) {
	const waitingId = useId();
	const orbitId = useId();
	const waiting = threadsWaitingOnYou(snapshot);
	const unassigned = sectionThreads(system.unassigned);
	const { summary } = system;
	return (
		<>
			<header className="flex shrink-0 items-start gap-3 border-border border-b p-4">
				<SunSwatch className="mt-0.5 size-11" palette={palette} />
				<div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
					<h2
						className={cn(HEADING, "text-base")}
						ref={headingRef}
						tabIndex={-1}
					>
						You
					</h2>
					<p className="truncate text-muted-foreground text-xs">
						The star of this system · {plural(summary.agents, "planet")}
					</p>
				</div>
				<CloseButton label="Close panel" onClose={onClose} />
			</header>
			<ScrollArea className={SCROLL_FADE}>
				<div className="flex flex-col gap-5 p-4 pb-7">
					<dl className="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-xl border border-border bg-card">
						<Stat label="Threads" value={summary.threads} />
						<Stat
							label="Waiting on you"
							tone={summary.attention > 0 ? "attention" : "your-turn"}
							value={summary.waitingOnYou}
						/>
						<Stat
							label="Working"
							tone={summary.working > 0 ? "working" : undefined}
							value={summary.working}
						/>
					</dl>
					<section aria-labelledby={waitingId} className="flex flex-col gap-2">
						<h3
							className="px-2 font-heading font-semibold text-foreground text-sm"
							id={waitingId}
						>
							Waiting on you
						</h3>
						{waiting.length === 0 ? (
							<EmptyNote>You're all caught up.</EmptyNote>
						) : (
							<ThreadSections
								activeThreadId={activeThreadId}
								now={now}
								onOpen={onOpen}
								sections={sectionThreads(waiting)}
								snapshot={snapshot}
							/>
						)}
					</section>
					{unassigned.length > 0 ? (
						<section aria-labelledby={orbitId} className="flex flex-col gap-2">
							<h3
								className="px-2 font-heading font-semibold text-foreground text-sm"
								id={orbitId}
							>
								Your own orbit
								<span className="ms-2 font-normal text-muted-foreground text-xs">
									Threads no agent is on
								</span>
							</h3>
							<ThreadSections
								activeThreadId={activeThreadId}
								now={now}
								onOpen={onOpen}
								sections={unassigned}
								snapshot={snapshot}
							/>
						</section>
					) : null}
				</div>
			</ScrollArea>
			{snapshot.agents.length > 0 ? (
				<div
					className="shrink-0 border-border border-t bg-background p-3"
					data-planets-composer=""
				>
					<InterfaceComposer
						agents={snapshot.agents}
						label="Start a thread"
						onSubmit={onMessage}
						placeholder="Ask any agent…"
						submitLabel="Send"
					/>
				</div>
			) : null}
		</>
	);
}

function ThreadPane({
	headingRef,
	onBack,
	onClose,
	planet,
	system,
	thread,
	threadView,
}: {
	headingRef: Ref<HTMLHeadingElement>;
	onBack: () => void;
	onClose: () => void;
	planet: Planet | undefined;
	system: PlanetSystem;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const title = threadTitle(thread);
	const status = thread ? threadStatus(thread) : null;
	const backLabel = planet ? `Back to ${planet.name}` : "Back to the system";
	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-2 border-border border-b ps-2 pe-3">
				<Button
					aria-label={backLabel}
					onClick={onBack}
					size="icon-sm"
					title={backLabel}
					type="button"
					variant="ghost"
				>
					<ArrowLeft aria-hidden="true" />
				</Button>
				{planet ? (
					<PlanetSwatch
						className="size-7"
						look={planetLookIn(system, planet.id)}
						planet={planet}
					/>
				) : null}
				<div className="flex min-w-0 flex-1 flex-col ps-1">
					<h2
						className={cn(HEADING, "font-medium text-sm")}
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					<p className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground text-xs leading-tight">
						<span className="truncate">
							{planet ? planet.name : "No agent"}
						</span>
						{status ? (
							<>
								<span aria-hidden="true">·</span>
								<span
									className={cn(
										"inline-flex shrink-0 items-center gap-1.5",
										STATUS_TONE[status]
									)}
								>
									<PlanetsStatusDot className="size-1.5" status={status} />
									{THREAD_STATUS_LABELS[status]}
								</span>
							</>
						) : null}
					</p>
				</div>
				<CloseButton label="Close thread" onClose={onClose} />
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</>
	);
}
