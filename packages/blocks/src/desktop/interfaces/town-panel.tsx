import { useLiteralMessages } from "@ryu/i18n/react";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgentAct,
	type InterfaceEvent,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { createContext, type ReactNode, type Ref, useContext } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import { GameSheet } from "./game-shell.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";
import { compactAge } from "./interface-renderer.ts";
import { useNow } from "./town-hooks.ts";
import {
	BUILDING_NAMES,
	eventWhen,
	plural,
	spokenAge,
	type TownBuilding,
} from "./town-model.ts";

/**
 * The side sheet (the game kit's GameSheet). A building's card shows its agent, district and every
 * conversation, its scheduled runs, and Commission work (a composer that
 * starts a conversation with that agent). A heard petition is the host's
 * own conversation surface under a council-record header, with a way back
 * to the building it came from.
 */

export type TownPanelView =
	| {
			building: TownBuilding;
			districtName: string;
			kind: "building";
			schedule: { recent: InterfaceEvent[]; upcoming: InterfaceEvent[] };
	  }
	| {
			building: TownBuilding | undefined;
			districtName: string | undefined;
			kind: "thread";
			thread: InterfaceThread | undefined;
	  };

export function TownPanel({
	headingRef,
	onBack,
	onClose,
	onCommission,
	onOpen,
	threadView,
	view,
}: {
	headingRef: Ref<HTMLHeadingElement>;
	onBack: () => void;
	onClose: () => void;
	onCommission: (input: { agentId: string; prompt: string }) => void;
	onOpen: (threadId: string) => void;
	threadView: ReactNode;
	view: TownPanelView;
}) {
	if (view.kind === "building") {
		return (
			<BuildingCard
				building={view.building}
				districtName={view.districtName}
				headingRef={headingRef}
				onClose={onClose}
				onCommission={onCommission}
				onOpen={onOpen}
				schedule={view.schedule}
			/>
		);
	}
	return (
		<CouncilRecord
			building={view.building}
			districtName={view.districtName}
			headingRef={headingRef}
			onBack={onBack}
			onClose={onClose}
			thread={view.thread}
			threadView={threadView}
		/>
	);
}

/**
 * With acts, each agent's act (by agent id): the building card says the
 * act, and no row or figure shows a last-update age.
 */
export const TownPanelActs = createContext<ReadonlyMap<
	string,
	InterfaceAgentAct
> | null>(null);

/** One line on what the building is doing, most urgent first. */
function BuildingStatus({ building }: { building: TownBuilding }) {
	const tl = useLiteralMessages();
	const acts = useContext(TownPanelActs);
	const act = acts?.get(building.agent.id);
	if (acts) {
		return (
			<p className="text-pretty font-medium text-foreground text-sm">
				{act?.ariaLabel ?? "Quiet: nothing running or waiting"}
			</p>
		);
	}
	let status: ThreadStatus = "quiet";
	let text = "Quiet: nothing running or waiting";
	if (building.alert) {
		status = "attention";
		text = `${plural(building.counts.attention, "run")} failed`;
	} else if (building.replied) {
		status = "your-turn";
		text = tl(
			"{count, plural, one {# reply} other {# replies}} waiting on you",
			{ count: building.counts["your-turn"] }
		);
	} else if (building.working) {
		status = "working";
		text = "Under construction: a run is live";
	}
	return (
		<p
			className={cn(
				"flex items-center gap-2 font-medium text-sm",
				status === "attention" && "text-destructive",
				status === "your-turn" && "text-primary",
				status === "working" && "text-success",
				status === "quiet" && "text-muted-foreground"
			)}
		>
			<BoardStatusDot status={status} />
			{text}
		</p>
	);
}

function Figure({ label, value }: { label: string; value: number | string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-[12px] text-muted-foreground">{label}</dt>
			<dd className="font-semibold text-foreground text-lg tabular-nums leading-6">
				{value}
			</dd>
		</div>
	);
}

function SectionTitle({ children }: { children: ReactNode }) {
	return (
		<h3 className="px-2 font-semibold text-[13px] text-muted-foreground leading-6">
			{children}
		</h3>
	);
}

function BuildingCard({
	building,
	districtName,
	headingRef,
	onClose,
	onCommission,
	onOpen,
	schedule,
}: {
	building: TownBuilding;
	districtName: string;
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	onCommission: (input: { agentId: string; prompt: string }) => void;
	onOpen: (threadId: string) => void;
	schedule: { recent: InterfaceEvent[]; upcoming: InterfaceEvent[] };
}) {
	const tl = useLiteralMessages();
	const now = useNow();
	const actMode = useContext(TownPanelActs) !== null;
	const { agent } = building;
	const lastActive = building.threads.reduce<string | null>(
		(latest, thread) =>
			latest === null || Date.parse(thread.updatedAt) > Date.parse(latest)
				? thread.updatedAt
				: latest,
		null
	);
	return (
		<GameSheet
			data-town-panel="building"
			footer={
				<section aria-label="Commission work" className="flex flex-col gap-2">
					<h3 className="font-semibold text-[13px] text-muted-foreground leading-5">
						Commission work
					</h3>
					<InterfaceComposer
						defaultAgentId={agent.id}
						label={tl("Commission work from {agentName}", {
							agentName: agent.name,
						})}
						onSubmit={(input) =>
							onCommission({ agentId: agent.id, prompt: input.prompt })
						}
						placeholder={tl("Describe the work for {agentName}", {
							agentName: agent.name,
						})}
						submitLabel="Commission"
					/>
				</section>
			}
			headingRef={headingRef}
			label={`${agent.name}'s ${BUILDING_NAMES[building.kind].toLowerCase()}`}
			leading={
				<span className="grid size-10 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk)">
					<BoardAvatar agent={agent} name={agent.name} size={28} />
				</span>
			}
			onClose={onClose}
			sheetKey={`building:${agent.id}`}
			subtitle={`${BUILDING_NAMES[building.kind]} · ${districtName}`}
			title={agent.name}
		>
			<ScrollArea className="min-h-0 flex-1">
				<div className="flex flex-col gap-6 px-4 pt-4 pb-6">
					<div className="flex flex-col gap-2">
						<BuildingStatus building={building} />
						{agent.description ? (
							<p className="text-pretty text-foreground/80 text-sm leading-5">
								{agent.description}
							</p>
						) : null}
					</div>
					<dl className="grid grid-cols-3 gap-4">
						<Figure label="Conversations" value={building.threads.length} />
						<Figure label="Messages" value={building.messages} />
						{actMode ? null : (
							<Figure
								label="Last active"
								value={lastActive ? compactAge(lastActive, now) : "None"}
							/>
						)}
					</dl>
					<section aria-label="Conversations" className="-mx-2 flex flex-col">
						<SectionTitle>Conversations</SectionTitle>
						{building.threads.length === 0 ? (
							<p className="px-2 text-muted-foreground text-sm">
								{tl("No conversations with {agentName} yet.", {
									agentName: agent.name,
								})}
							</p>
						) : (
							<ul className="flex flex-col">
								{building.threads.map((thread) => (
									<ThreadRow
										key={thread.id}
										now={now}
										onOpen={onOpen}
										thread={thread}
									/>
								))}
							</ul>
						)}
					</section>
					{schedule.upcoming.length + schedule.recent.length > 0 ? (
						<section aria-label="Schedule" className="-mx-2 flex flex-col">
							<SectionTitle>Schedule</SectionTitle>
							<ul className="flex flex-col">
								{[...schedule.upcoming, ...schedule.recent].map((event) => (
									<ScheduleRow event={event} key={event.id} now={now} />
								))}
							</ul>
						</section>
					) : null}
				</div>
			</ScrollArea>
		</GameSheet>
	);
}

function ThreadRow({
	now,
	onOpen,
	thread,
}: {
	now: number;
	onOpen: (threadId: string) => void;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	const actMode = useContext(TownPanelActs) !== null;
	return (
		<li>
			<button
				// With acts a row says only its title: the card's act sentence says
				// what the agent is doing, and a thread status would contradict it.
				aria-label={
					actMode
						? thread.title
						: `${thread.title}. ${THREAD_STATUS_LABELS[status]}, ${spokenAge(thread.updatedAt, now)}`
				}
				className="flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				{actMode ? null : <BoardStatusDot status={status} />}
				<span className="min-w-0 flex-1 truncate text-foreground text-sm">
					{thread.title}
				</span>
				<span
					className={cn(
						actMode && "hidden",
						"shrink-0 text-[13px]",
						status === "attention" && "font-medium text-destructive",
						status === "your-turn" && "font-medium text-primary",
						(status === "working" ||
							status === "waiting" ||
							status === "quiet") &&
							"text-muted-foreground"
					)}
				>
					{THREAD_STATUS_LABELS[status]}
				</span>
				<span className="w-8 shrink-0 text-right text-[13px] text-muted-foreground tabular-nums">
					{actMode ? null : compactAge(thread.updatedAt, now)}
				</span>
			</button>
		</li>
	);
}

function ScheduleRow({ event, now }: { event: InterfaceEvent; now: number }) {
	let outcome: ReactNode = null;
	if (event.kind === "past") {
		outcome =
			event.outcome === "failure" ? (
				<span className="font-medium text-destructive">Failed</span>
			) : (
				<span>Ran</span>
			);
	}
	return (
		<li className="flex items-baseline gap-2.5 px-2 py-1.5 text-sm">
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-foreground">
					{event.title}
					{event.count && event.count > 1 ? (
						<span className="text-muted-foreground"> ×{event.count}</span>
					) : null}
				</span>
				{event.label ? (
					<span className="truncate text-[13px] text-muted-foreground">
						{event.label}
					</span>
				) : null}
			</span>
			<span className="flex w-20 shrink-0 justify-end gap-1 text-[13px] text-muted-foreground tabular-nums">
				{outcome}
				{event.kind === "past" ? null : eventWhen(event, now)}
				{event.kind === "past" ? (
					<span className="sr-only">{eventWhen(event, now)}</span>
				) : null}
			</span>
		</li>
	);
}

function CouncilRecord({
	building,
	districtName,
	headingRef,
	onBack,
	onClose,
	thread,
	threadView,
}: {
	building: TownBuilding | undefined;
	districtName: string | undefined;
	headingRef: Ref<HTMLHeadingElement>;
	onBack: () => void;
	onClose: () => void;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const now = useNow();
	const actMode = useContext(TownPanelActs) !== null;
	const status = thread ? threadStatus(thread) : null;
	const petition =
		!actMode && (status === "attention" || status === "your-turn");
	const record = [
		petition ? "Petition" : "Council record",
		districtName ?? null,
		thread && !actMode
			? `filed ${compactAge(thread.updatedAt, now)} ago`
			: null,
	].filter(Boolean);
	const backLabel = building
		? tl("Back to {agentName}'s {buildingName}", {
				agentName: building.agent.name,
				buildingName: BUILDING_NAMES[building.kind].toLowerCase(),
			})
		: "Back to the town";
	const meta = [
		building ? `From ${building.agent.name}` : null,
		thread ? plural(thread.messageCount, "message") : null,
	].filter(Boolean);
	return (
		<GameSheet
			backLabel={backLabel}
			closeLabel="Close the record"
			data-town-panel="thread"
			eyebrow={record.join(" · ")}
			headingRef={headingRef}
			label={tl("Council record: {threadTitle}", {
				threadTitle: thread?.title ?? "Conversation",
			})}
			onBack={onBack}
			onClose={onClose}
			sheetKey={`thread:${thread?.id ?? ""}`}
			subtitle={
				<>
					{status && !actMode ? <BoardStatusDot status={status} /> : null}
					{actMode && status ? null : (
						<span
							className={cn(
								"shrink-0",
								status === "attention" && "text-(--gk-bad)"
							)}
						>
							{status ? THREAD_STATUS_LABELS[status] : "Starting"}
						</span>
					)}
					{meta.length > 0 ? (
						<span className="truncate">
							{actMode && status ? "" : "· "}
							{meta.join(" · ")}
						</span>
					) : null}
				</>
			}
			title={thread?.title.trim() || "New conversation"}
		>
			<div className="min-h-0 flex-1">{threadView}</div>
		</GameSheet>
	);
}
