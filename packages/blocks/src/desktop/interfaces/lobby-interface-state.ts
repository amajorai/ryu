import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { gameSheetCover } from "./game-shell.tsx";
import { stageAgents } from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { useGameNight, useIsoView, useReducedMotion } from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import { useActCards } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useAnsweredToday } from "./lobby-answers.ts";
import { ensureLobbyDisplayFont } from "./lobby-font.ts";
import { COMPACT_BELOW, ISLAND_RIM } from "./lobby-interface-constants.ts";
import {
	buildMembers,
	buildQuestBoard,
	claimableCount,
	type LobbyTab,
	lobbyLevel,
	newsItems,
	QUEST_KINDS,
	type QuestKind,
	resolveSquad,
	type SquadState,
	totalMessages,
} from "./lobby-model.ts";
import { layoutLobbyWorld, squadThreads } from "./lobby-world.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

/** The lobby's state, derived data and stage measurements. */
export function useLobbyInterfaceState({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["lobby"]>) {
	const reduceMotion = useReducedMotion();
	// The live settings (a bare `{}` resolves to the defaults).
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	const { openOn, squadSize } = resolveInterfaceParams(
		"lobby",
		params
	) as Required<InterfaceParamsByRenderer["lobby"]>;
	const [tab, setTabState] = useState<LobbyTab>(openOn);
	// "Opens on" changed in Settings: follow it.
	useEffect(() => {
		setTabState(openOn);
	}, [openOn]);
	// Switching tabs keeps the last one ("Opens on").
	const setTab = (next: LobbyTab) => {
		setTabState(next);
		if (next !== openOn) {
			port.updateSettings?.({ openOn: next });
		}
	};
	const [questKind, setQuestKind] = useState<QuestKind>("daily");
	const [newsIndex, setNewsIndex] = useState(0);
	const [pickedSquad, setPickedSquad] = useState<string[] | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const members = useMemo(() => buildMembers(snapshot), [snapshot]);
	const actsView = useActs(snapshot);
	const { acts, enabled: withActs, nowMs, privacy, unowned } = actsView;
	// With acts the squad is the most urgent agents (asking first); a pick
	// only reorders agents within the same act, never pushing a more urgent
	// one off the podium. A benched pick still leads the next match (PLAY).
	const { offStage, onStage } = useMemo(
		() => stageAgents(acts, squadSize, pickedSquad ?? []),
		[acts, pickedSquad, squadSize]
	);
	const squad = useMemo(() => {
		if (!withActs) {
			return resolveSquad(members, pickedSquad, squadSize);
		}
		const byId = new Map(members.map((member) => [member.agent.id, member]));
		return onStage
			.map((act) => byId.get(act.agentId))
			.filter((member) => member !== undefined);
	}, [members, onStage, pickedSquad, squadSize, withActs]);
	const squadIds = squad.map((member) => member.agent.id);
	const selected =
		(withActs ? members : squad).find(
			(member) => member.agent.id === selectedId
		) ?? squad[0];
	// Blocking asks answered today through the ask card (lobby-answers.ts).
	const { answered, answerPort, pending } = useAnsweredToday(
		snapshot,
		port,
		nowMs
	);
	// An answer on its way is not waiting any more.
	const blocking = (snapshot.asks ?? []).filter(
		(ask) => ask.blocking && !pending.has(ask.id)
	);
	// Each agent's face from its act, for the quests' heads.
	const actFaces = useMemo(() => {
		const faces = new Map<string, SquadState>();
		for (const act of acts.values()) {
			let face: SquadState = "ready";
			if (act.act === "asking") {
				face = "needs-you";
			} else if (act.act === "waiting") {
				face = "waiting";
			} else if (act.act === "working") {
				face = "in-match";
			} else if (
				act.act === "blocked" &&
				act.blockers[0]?.kind !== "interrupted"
			) {
				face = "downed";
			}
			faces.set(act.agentId, face);
		}
		return faces;
	}, [acts]);
	const firstAskThread =
		blocking.find((ask) => ask.threadId !== null)?.threadId ?? null;
	const board = useMemo(
		() =>
			buildQuestBoard(
				snapshot,
				members,
				withActs
					? {
							answered,
							firstThreadId: firstAskThread,
							waiting: blocking.length,
						}
					: undefined,
				nowMs
			),
		// biome-ignore lint/correctness/useExhaustiveDependencies: the tally is keyed by its counts.
		[
			snapshot,
			members,
			withActs,
			answered,
			firstAskThread,
			blocking.length,
			nowMs,
		]
	);
	const news = useMemo(() => newsItems(snapshot), [snapshot]);
	const level = useMemo(
		() => lobbyLevel(totalMessages(snapshot.threads)),
		[snapshot.threads]
	);
	const readyToClaim = QUEST_KINDS.reduce(
		(sum, kind) => sum + claimableCount(board[kind]),
		0
	);
	const now = Date.now();
	const panelOpen = threadView !== null;
	const openThreadId = panelOpen ? activeThreadId : null;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const isEmpty =
		!loading && snapshot.agents.length === 0 && snapshot.threads.length === 0;

	useLayoutEffect(() => {
		ensureLobbyDisplayFont();
	}, []);

	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLElement>(null);
	const [stageWidth, setStageWidth] = useState(0);
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				setStageWidth(entry.contentRect.width);
			}
		});
		observer.observe(stage);
		return () => observer.disconnect();
	}, []);
	const compact = stageWidth > 0 && stageWidth < COMPACT_BELOW;
	const night = useGameNight(rootRef);
	const isoView = useIsoView();
	const world = useMemo(
		() => layoutLobbyWorld(squad, true, squadSize),
		[squad, squadSize]
	);
	const shape = useMemo(
		() =>
			islandFor(
				world.bounds.maxX - world.bounds.minX,
				world.bounds.maxZ - world.bounds.minZ,
				ISLAND_RIM
			),
		[world]
	);
	const agentIds = useMemo(
		() => snapshot.agents.map((agent) => agent.id),
		[snapshot.agents]
	);
	const { looks } = useVillagerLooks(agentIds, night);
	const matches = squadThreads(squad);
	const waiting = matches.filter((thread) => {
		const status = threadStatus(thread);
		return status === "your-turn" || status === "attention";
	}).length;
	// The sheet floats over the right; the plaza refits beside it (on a
	// narrow stage the sheet covers it all).
	const cover = panelOpen && stageWidth > 0 ? gameSheetCover(stageWidth) : 0;
	const sheetCover = cover < stageWidth ? cover : 0;
	const insets = useMemo(
		() => ({
			bottom: compact ? 150 : 110,
			left: 16,
			right: 16 + sheetCover,
			top: compact ? 64 : 88,
		}),
		[compact, sheetCover]
	);
	// Where the act HUD ends, so tab content (and the no-WebGL list) starts below it.
	const actHudRef = useRef<HTMLDivElement>(null);
	const [actHudBottom, setActHudBottom] = useState(0);
	useEffect(() => {
		const hud = actHudRef.current;
		const root = rootRef.current;
		if (!(withActs && hud && root) || typeof ResizeObserver === "undefined") {
			return;
		}
		const measure = () =>
			setActHudBottom(
				Math.round(
					hud.getBoundingClientRect().bottom - root.getBoundingClientRect().top
				)
			);
		measure();
		const observer = new ResizeObserver(measure);
		// The HUD moves at the stage's breakpoints too, not only when it resizes.
		observer.observe(hud);
		observer.observe(root);
		return () => observer.disconnect();
	}, [withActs]);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const lobbyHeadingRef = useRef<HTMLHeadingElement>(null);
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: lobbyHeadingRef,
		nowMs,
		port: answerPort,
		snapshot,
	});
	return {
		actFaces,
		actHudBottom,
		actHudRef,
		activeThread,
		acts,
		board,
		cards,
		clock,
		compact,
		headingRef,
		insets,
		isEmpty,
		isoView,
		level,
		lobbyHeadingRef,
		looks,
		matches,
		members,
		news,
		newsIndex,
		night,
		now,
		nowMs,
		offStage,
		onStage,
		openThreadId,
		panelOpen,
		privacy,
		questKind,
		readyToClaim,
		reduceMotion,
		rootRef,
		selected,
		selectedId,
		sentence,
		setNewsIndex,
		setPickedSquad,
		setQuestKind,
		setSelectedId,
		setTab,
		shape,
		squad,
		squadIds,
		squadSize,
		stageRef,
		stageWidth,
		tab,
		unowned,
		waiting,
		withActs,
		world,
	};
}

export type LobbyInterfaceState = ReturnType<typeof useLobbyInterfaceState>;
