import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { createContext, type KeyboardEvent, useContext, useRef } from "react";
import { agentById, compactAge } from "./interface-renderer.ts";
import {
	claimableCount,
	formatXp,
	type LobbyQuest,
	QUEST_KIND_DESCRIPTIONS,
	QUEST_KIND_LABELS,
	QUEST_KINDS,
	type QuestAction,
	type QuestBoard,
	type QuestKind,
	type SquadState,
	STATUS_SQUAD_STATE,
} from "./lobby-model.ts";
import {
	ChunkyButton,
	DISPLAY,
	LobbyHead,
	LobbyProgress,
	LobbyXpChip,
	STATUS_DOT,
} from "./lobby-parts.tsx";

const EMPTY_COPY: Record<QuestKind, { description: string; title: string }> = {
	daily: {
		description:
			"When an agent replies or a run fails, the conversation shows up here to claim.",
		title: "Nothing is waiting on you",
	},
	milestone: {
		description:
			"Add an agent and every message you trade counts toward a tier.",
		title: "No milestones yet",
	},
	weekly: {
		description:
			"Create a team or a project and its threads count toward a weekly quest.",
		title: "No teams or projects yet",
	},
};

function questTabId(kind: QuestKind): string {
	return `lobby-quests-tab-${kind}`;
}

const STEP: Record<string, number> = {
	ArrowDown: 1,
	ArrowLeft: -1,
	ArrowRight: 1,
	ArrowUp: -1,
};

/**
 * The leading media: one face, or up to three overlapped faces for a group,
 * in a slot three faces wide so titles line up down the section.
 */
const MEDIA_SLOT = "flex shrink-0";

/**
 * With the act layer, each agent's face from its act (asking, working,
 * downed), in place of its latest thread's status.
 */
export const LobbyActFaces = createContext<ReadonlyMap<
	string,
	SquadState
> | null>(null);

function QuestFaces({
	quest,
	snapshot,
}: {
	quest: LobbyQuest;
	snapshot: InterfaceSnapshot;
}) {
	const actFaces = useContext(LobbyActFaces);
	if (quest.kind === "weekly") {
		const group = snapshot.groups.find((entry) => entry.id === quest.groupId);
		const members = (group?.memberAgentIds ?? [])
			.map((id) => agentById(snapshot, id))
			.filter((agent) => agent !== undefined)
			.slice(0, 3);
		return (
			<span aria-hidden="true" className={cn(MEDIA_SLOT, "w-24 -space-x-3")}>
				{members.map((agent) => (
					<LobbyHead
						agent={agent}
						className="size-10 ring-(--gk-plate) ring-2"
						key={agent.id}
					/>
				))}
			</span>
		);
	}
	const agent = agentById(snapshot, quest.agentId);
	const thread =
		quest.action.kind === "open"
			? snapshot.threads.find(
					(entry) =>
						quest.action.kind === "open" && entry.id === quest.action.threadId
				)
			: undefined;
	let state: SquadState =
		quest.kind === "daily" && thread
			? STATUS_SQUAD_STATE[threadStatus(thread)]
			: "ready";
	if (actFaces) {
		state = (agent && actFaces.get(agent.id)) || "ready";
	}
	return (
		<span aria-hidden="true" className={MEDIA_SLOT}>
			{agent ? (
				<LobbyHead agent={agent} className="size-10" state={state} />
			) : null}
		</span>
	);
}

function actionLabel(action: QuestAction, complete: boolean): string {
	if (complete) {
		return "Claim";
	}
	return action.kind === "open" ? "Open" : "Start";
}

/** A daily's line: where the conversation stands and how long ago it moved. */
function DailyDetail({
	now,
	quest,
	snapshot,
}: {
	now: number;
	quest: LobbyQuest;
	snapshot: InterfaceSnapshot;
}) {
	const thread =
		quest.action.kind === "open"
			? snapshot.threads.find(
					(entry) =>
						quest.action.kind === "open" && entry.id === quest.action.threadId
				)
			: undefined;
	const status = thread ? threadStatus(thread) : "quiet";
	const age = quest.updatedAt ? compactAge(quest.updatedAt, now) : "";
	// With the act layer a thread's legacy status dot would contradict it.
	const acted = snapshot.asks !== undefined;
	return (
		<span className="flex min-w-0 items-center gap-2 text-(--gk-ink-muted)">
			{acted ? null : (
				<span
					aria-hidden="true"
					className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])}
				/>
			)}
			<span className="truncate">{quest.detail}</span>
			{age ? (
				<>
					<span aria-hidden="true">·</span>
					<span className="shrink-0 tabular-nums">{age}</span>
				</>
			) : null}
		</span>
	);
}

function QuestRow({
	activeThreadId,
	now,
	onAction,
	quest,
	snapshot,
}: {
	activeThreadId: string | null;
	now: number;
	onAction: (action: QuestAction) => void;
	quest: LobbyQuest;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const label = actionLabel(quest.action, quest.complete);
	const target =
		quest.action.kind === "open" ? "open the conversation" : "start a thread";
	const open =
		quest.action.kind === "open" && quest.action.threadId === activeThreadId;
	return (
		<li
			aria-current={open ? "true" : undefined}
			className={cn(
				"relative flex items-center gap-4 py-4 ps-5 pe-5 transition-colors max-sm:flex-wrap max-sm:gap-3",
				"overflow-hidden rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) shadow-[0_3px_0_var(--gk-edge)]",
				open ? "bg-(--gk-plate-sunk)" : "hover:bg-(--gk-plate-sunk)"
			)}
			data-complete={quest.complete || undefined}
			data-open={open || undefined}
			data-quest-id={quest.id}
		>
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-y-0 start-0 w-[3px]",
					quest.complete || open ? "bg-primary" : "bg-transparent"
				)}
			/>
			<QuestFaces quest={quest} snapshot={snapshot} />
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex min-w-0 items-center gap-3">
					<h3 className="truncate font-semibold! text-(--gk-ink) text-[15px] leading-5">
						{quest.title}
					</h3>
					<LobbyXpChip xp={formatXp(quest.xp)} />
				</div>
				<p className="flex min-w-0 items-baseline justify-between gap-4 text-[13px] leading-5">
					{quest.kind === "daily" ? (
						<DailyDetail now={now} quest={quest} snapshot={snapshot} />
					) : (
						<span className="truncate text-(--gk-ink-muted)">
							{quest.detail}
						</span>
					)}
					<span className="shrink-0 font-semibold text-(--gk-ink) tabular-nums">
						{quest.metric}
					</span>
				</p>
				{quest.kind === "daily" ? null : (
					<LobbyProgress
						className="mt-1"
						complete={quest.complete}
						goal={quest.goal}
						label={tl("{title} progress: {metric}", {
							title: quest.title,
							metric: quest.metric,
						})}
						value={quest.progress}
					/>
				)}
			</div>
			<ChunkyButton
				aria-label={`${label}: ${quest.title}, ${target}`}
				className="ms-4 w-28 max-sm:ms-0"
				onClick={() => onAction(quest.action)}
				tone={quest.complete ? "primary" : "secondary"}
			>
				{label}
			</ChunkyButton>
		</li>
	);
}

function QuestSkeletons() {
	return (
		<ul
			aria-busy="true"
			aria-label="Loading quests"
			className="flex flex-col gap-2"
		>
			{[0, 1, 2, 3].map((index) => (
				<li
					className="flex items-center gap-4 rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) py-4 ps-5 pe-5 shadow-[0_3px_0_var(--gk-edge)]"
					key={index}
				>
					<span className={MEDIA_SLOT}>
						<Skeleton className="size-10 rounded-none" />
					</span>
					<div className="flex flex-1 flex-col gap-2">
						<Skeleton className="h-4 w-56 rounded-none" />
						<Skeleton className="h-3 w-40 rounded-none" />
						<Skeleton className="h-2 w-full -skew-x-12 rounded-none" />
					</div>
					<Skeleton className="ms-4 h-9 w-28 -skew-x-12 rounded-none" />
				</li>
			))}
		</ul>
	);
}

/**
 * QUESTS tab: categories down the left with how many are ready to claim, and
 * the chosen category's quests as rows with XP, progress, and CLAIM.
 */
export function LobbyQuests({
	activeThreadId,
	board,
	kind,
	loading,
	now,
	onAction,
	onKind,
	snapshot,
}: {
	activeThreadId: string | null;
	board: QuestBoard;
	kind: QuestKind;
	loading: boolean;
	now: number;
	onAction: (action: QuestAction) => void;
	onKind: (kind: QuestKind) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const listRef = useRef<HTMLDivElement>(null);
	const quests = board[kind];
	const ready = claimableCount(quests);
	const totalReady = QUEST_KINDS.reduce(
		(sum, option) => sum + claimableCount(board[option]),
		0
	);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = STEP[event.key];
		if (step === undefined) {
			return;
		}
		event.preventDefault();
		const index = QUEST_KINDS.indexOf(kind);
		const next =
			QUEST_KINDS[(index + step + QUEST_KINDS.length) % QUEST_KINDS.length];
		if (next) {
			onKind(next);
			listRef.current
				?.querySelector<HTMLElement>(`#${questTabId(next)}`)
				?.focus();
		}
	};
	return (
		<div className="@container flex min-h-0 flex-1">
			<div className="flex min-h-0 flex-1 @max-3xl:flex-col">
				<nav
					aria-label="Quest categories"
					className="m-4 @max-3xl:mb-0 flex @max-3xl:w-full w-72 shrink-0 flex-col @max-3xl:gap-4 gap-6 self-start @max-3xl:self-stretch rounded-[22px] border-(--gk-edge) border-2 bg-(--gk-plate) @max-3xl:px-4 px-5 @max-3xl:py-3 py-6 shadow-(--gk-lip)"
				>
					<div className="flex @max-3xl:flex-row flex-col @max-3xl:items-baseline @max-3xl:gap-3 gap-2">
						<h2
							className={cn(
								DISPLAY,
								"@max-3xl:text-[24px] text-(--gk-ink) text-[32px]"
							)}
						>
							Quest board
						</h2>
						<p className="text-(--gk-ink-muted) text-[13px] tabular-nums">
							{loading
								? "Loading quests"
								: tl("{totalReady} ready to claim", {
										totalReady: String(totalReady),
									})}
						</p>
					</div>
					<div
						aria-orientation="vertical"
						className="flex @max-3xl:flex-row flex-col gap-1 @max-3xl:overflow-x-auto"
						onKeyDown={onKeyDown}
						ref={listRef}
						role="tablist"
					>
						{QUEST_KINDS.map((option) => {
							const list = board[option];
							const claimable = claimableCount(list);
							const selected = option === kind;
							return (
								<button
									aria-controls="lobby-quest-list"
									aria-selected={selected}
									className="group/kind relative flex @max-3xl:min-w-44 shrink-0 flex-col gap-1 py-3 ps-4 pe-3 text-start outline-none"
									id={questTabId(option)}
									key={option}
									onClick={() => onKind(option)}
									role="tab"
									tabIndex={selected ? 0 : -1}
									type="button"
								>
									<span
										aria-hidden="true"
										className={cn(
											"absolute inset-0 -skew-x-12 transition-colors group-focus-visible/kind:ring-3 group-focus-visible/kind:ring-ring",
											selected
												? "bg-primary"
												: "bg-transparent group-hover/kind:bg-foreground/[0.06]"
										)}
									/>
									<span
										className={cn(
											DISPLAY,
											"relative text-[20px]",
											selected
												? "text-primary-foreground"
												: "text-(--gk-ink-muted) group-hover/kind:text-(--gk-ink)"
										)}
									>
										{QUEST_KIND_LABELS[option]}
									</span>
									<span
										className={cn(
											"relative text-[11px] tabular-nums leading-4",
											selected
												? "text-primary-foreground/85"
												: "text-(--gk-ink-muted)"
										)}
									>
										{loading
											? "–"
											: tl("{claimable} of {total} ready to claim", {
													claimable: String(claimable),
													total: String(list.length),
												})}
									</span>
								</button>
							);
						})}
					</div>
				</nav>
				<section
					aria-labelledby={questTabId(kind)}
					className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto @max-3xl:px-4 px-8 @max-3xl:py-4 py-8"
					id="lobby-quest-list"
					role="tabpanel"
				>
					<header className="flex min-w-0 flex-col gap-2">
						<div className="flex min-w-0 items-baseline gap-4">
							<h2
								className={cn(
									DISPLAY,
									"@max-3xl:text-[32px] text-(--gk-ink) text-[44px]"
								)}
							>
								{QUEST_KIND_LABELS[kind]}
							</h2>
							{loading ? null : (
								<p
									className={cn(
										DISPLAY,
										"shrink-0 @max-3xl:text-[20px] text-(--gk-ink-muted) text-[26px] tabular-nums"
									)}
								>
									<span className="text-(--gk-ink)">{ready}</span>/
									{quests.length}
									<span className="sr-only"> ready to claim</span>
								</p>
							)}
						</div>
						<p className="text-(--gk-ink-muted) text-[13px]">
							{QUEST_KIND_DESCRIPTIONS[kind]}
						</p>
					</header>
					{loading ? <QuestSkeletons /> : null}
					{!loading && quests.length === 0 ? (
						<div className="flex flex-col items-start gap-1 rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) px-5 py-6 shadow-[0_3px_0_var(--gk-edge)]">
							<h3 className="font-semibold! text-(--gk-ink) text-[15px]">
								{EMPTY_COPY[kind].title}
							</h3>
							<p className="text-(--gk-ink-muted) text-[13px]">
								{EMPTY_COPY[kind].description}
							</p>
						</div>
					) : null}
					{!loading && quests.length > 0 ? (
						<ul
							aria-label={QUEST_KIND_LABELS[kind]}
							className="flex flex-col gap-2"
						>
							{quests.map((quest) => (
								<QuestRow
									activeThreadId={activeThreadId}
									key={quest.id}
									now={now}
									onAction={onAction}
									quest={quest}
									snapshot={snapshot}
								/>
							))}
						</ul>
					) : null}
				</section>
			</div>
		</div>
	);
}
