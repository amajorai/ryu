import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { keepsActOverlay } from "./act-settings.ts";
import { GAME_PLATE } from "./game-hud.tsx";
import { GameHudSlot, GameShell, gameSheetCover } from "./game-shell.tsx";
import {
	actOverlays,
	actSummaryLine,
	actTotals,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	IsoStage,
	IsoZoomControls,
	useGameNight,
	useIsoView,
	useReducedMotion,
} from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
	ActAgentList,
	ActAnnouncer,
	ActStatus,
	AskQueueList,
	askOwners,
	BlindSpotCaption,
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { type LobbyActView, lobbyYouSpot } from "./lobby-acts.tsx";
import { useAnsweredToday } from "./lobby-answers.ts";
import { LobbyDiorama } from "./lobby-diorama.tsx";
import { LobbyEmpty } from "./lobby-empty.tsx";
import { ensureLobbyDisplayFont } from "./lobby-font.ts";
import { LobbyList } from "./lobby-list.tsx";
import {
	addToSquad,
	buildMembers,
	buildQuestBoard,
	claimableCount,
	type LobbyTab,
	lobbyLevel,
	newsItems,
	QUEST_KINDS,
	type QuestAction,
	type QuestKind,
	resolveSquad,
	type SquadState,
	totalMessages,
} from "./lobby-model.ts";
import { LobbyNav, lobbyPanelId, lobbyTabId } from "./lobby-nav.tsx";
import { LobbyNews } from "./lobby-news.tsx";
import {
	LOBBY_SCENE_MODE,
	LOBBY_SCENE_VARS,
	STAGE_BACKGROUND,
	STAGE_RAYS,
} from "./lobby-palette.ts";
import { LobbyThreadPanel } from "./lobby-panel.tsx";
import { LobbyPlay, type LobbyStartInput } from "./lobby-play.tsx";
import { LobbyActFaces, LobbyQuests } from "./lobby-quests.tsx";
import { LobbyRoster } from "./lobby-roster.tsx";
import { layoutLobbyWorld, squadThreads } from "./lobby-world.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

/** Escape inside a text field belongs to the field (or the host's composer). */
function isEditable(target: EventTarget): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("input, textarea, select, [contenteditable='true']") !==
				null)
	);
}

/** A focus move the lobby asked for, kept briefly while the host responds. */
const FOCUS_REQUEST_TTL_MS = 2000;

/** Below this stage width the HUD plates go compact. */
const COMPACT_BELOW = 760;

/** The island's rim round the plaza, for the woods and the shore. */
const ISLAND_RIM = 3;
/** World units kept round the plates when the act layer frames the plaza. */
const LOBBY_ACT_PLATE_FIT = { above: 1.8, below: 1.4, max: 2.6, side: 1.2 };
/** Room round the ready-check pad's farthest slot. */
const YOU_SPOT_ROOM = 0.6;

/**
 * Lobby: a game menu over the same agents and threads, on the shared game
 * kits (game-shell.tsx, game3d-stage.tsx): the menu tabs and level sit in
 * the HUD. LOBBY is a plaza diorama (lobby-diorama.tsx) with up to four
 * agents as a squad on a lit podium, the quest board, a play portal and the
 * recent-matches board, and a PLAY plate that briefs the selected one; QUESTS turns what is waiting on you into claimable
 * quests; SQUAD is the roster; NEWS is the latest activity. Opening anything
 * shows the host's real conversation in the kit's side sheet.
 */
export function LobbyInterface({
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
	const queueOpener = useRef<(() => void) | null>(null);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				onStage.map((act) => act.agentId)
			),
		[acts, onStage, unowned]
	);
	const totals = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	// The kit settings (overlay density, work bubbles) for its own pieces too.
	const kitSettings = useGameKitSettings();
	const budget = overlayBudget(stageWidth > 0 ? stageWidth : 1280, {
		domTargets: true,
	});
	const shownKey = withActs
		? [
				...budget.fill(
					actOverlays(
						onStage,
						slots,
						offStage,
						onStage.find((act) => act.act === "working")?.agentId ?? null,
						{ reduced: reduceMotion }
					).filter((item) => keepsActOverlay(item, kitSettings))
				),
			]
				.sort()
				.join("|")
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	// The plaza and, with acts, the ready-check pad in front of it: no more.
	const stageBounds = useMemo(() => {
		const bounds = { ...world.bounds, top: 4.4 };
		if (!withActs) {
			return bounds;
		}
		for (const [x, , z] of Object.values(
			lobbyYouSpot(budget.iconOnly).points
		)) {
			bounds.minX = Math.min(bounds.minX, x - YOU_SPOT_ROOM);
			bounds.maxX = Math.max(bounds.maxX, x + YOU_SPOT_ROOM);
			bounds.minZ = Math.min(bounds.minZ, z - YOU_SPOT_ROOM);
			bounds.maxZ = Math.max(bounds.maxZ, z + YOU_SPOT_ROOM);
		}
		return bounds;
	}, [budget.iconOnly, withActs, world.bounds]);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const actView: LobbyActView | null = withActs
		? {
				acts,
				clock,
				iconOnly: budget.iconOnly,
				nowMs,
				offStage,
				onAsk: (askId) => cards.openAsk(askId),
				onBlocker: (threadId, agentName) =>
					cards.openBlocker(threadId, agentName),
				onQueue: () => openQueue(queueOpener),
				owners,
				privacy,
				shown,
				slots,
				snapshot,
			}
		: null;
	const offStageActs = useMemo(() => {
		const staged = new Set(onStage.map((act) => act.agentId));
		return new Map([...acts].filter(([id]) => !staged.has(id)));
	}, [acts, onStage]);
	const statusOf = (agentId: string) => {
		const act = acts.get(agentId);
		return act
			? {
					label: act.ariaLabel,
					status: (
						<ActStatus
							act={act}
							clock={clock}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							snapshot={snapshot}
						/>
					),
				}
			: null;
	};
	const actButtons = (
		<>
			<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={totals} />
			<QueueButton
				acts={acts}
				clock={clock}
				narrow={compact}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				openRef={queueOpener}
				snapshot={snapshot}
				totals={totals}
				unowned={unowned}
			/>
		</>
	);
	const openerRef = useRef<HTMLElement | null>(null);
	const focusRequestRef = useRef<number | null>(null);
	const wasOpenRef = useRef(panelOpen);

	const rememberOpener = () => {
		const active = document.activeElement;
		openerRef.current =
			active instanceof HTMLElement && rootRef.current?.contains(active)
				? active
				: null;
		focusRequestRef.current = Date.now();
	};
	const openThread = (threadId: string) => {
		rememberOpener();
		port.openThread(threadId);
	};
	const closeThread = () => {
		port.closeThread();
	};
	const pick = (agentId: string) => {
		setPickedSquad(addToSquad(squadIds, agentId, squadSize));
		setSelectedId(agentId);
	};
	const pickFromRoster = (agentId: string) => {
		pick(agentId);
		setTab("lobby");
	};
	const runQuest = (action: QuestAction) => {
		if (action.kind === "open") {
			openThread(action.threadId);
			return;
		}
		rememberOpener();
		port.startThread({
			agentId: action.agentId,
			projectId: action.projectId,
			teamId: action.teamId,
		});
	};
	const startWith = (agentId: string) => {
		rememberOpener();
		port.startThread({ agentId });
	};
	const startPrompt = (input: LobbyStartInput) => {
		rememberOpener();
		port.startThread(input);
	};

	// Focus follows the panel: into its heading when the lobby opened it, and
	// back to the control that opened it when it closes.
	useLayoutEffect(() => {
		const wasOpen = wasOpenRef.current;
		wasOpenRef.current = panelOpen;
		const requestedAt = focusRequestRef.current;
		const fresh =
			requestedAt !== null && Date.now() - requestedAt < FOCUS_REQUEST_TTL_MS;
		if (panelOpen && !wasOpen && fresh) {
			focusRequestRef.current = null;
			headingRef.current?.focus();
			return;
		}
		if (wasOpen && !panelOpen) {
			const active = document.activeElement;
			const lost =
				active === null ||
				active === document.body ||
				!rootRef.current?.contains(active);
			const opener = openerRef.current;
			if (lost && opener?.isConnected) {
				opener.focus();
			}
		}
	}, [panelOpen]);

	// Escape with focus nowhere (after clicking plain text) still closes.
	useEffect(() => {
		if (!panelOpen) {
			return;
		}
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				event.target === document.body &&
				!isInterfaceCovered(rootRef.current)
			) {
				event.preventDefault();
				port.closeThread();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, [panelOpen, port]);

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key === "Escape" &&
			panelOpen &&
			!event.defaultPrevented &&
			!isEditable(event.target)
		) {
			event.preventDefault();
			closeThread();
		}
	};

	const dailiesReady = claimableCount(board.daily);
	const showQuests = () => {
		setQuestKind("daily");
		setTab("quests");
	};
	let body = loading ? (
		<div
			aria-busy="true"
			className="absolute inset-0 flex items-center justify-center"
		>
			<Skeleton className="aspect-[3/2] w-[min(60%,560px)] rounded-[40px]" />
		</div>
	) : (
		<div className="absolute inset-0">
			<IsoStage
				bounds={stageBounds}
				fallback={
					<LobbyList
						activeThreadId={openThreadId}
						acts={
							withActs
								? {
										top: actHudBottom,
										offStage:
											offStageActs.size > 0 ? (
												<section
													aria-label="Off the podium"
													className={cn(GAME_PLATE, "p-3")}
												>
													<ActAgentList
														acts={offStageActs}
														clock={clock}
														nowMs={nowMs}
														onAsk={onAsk}
														onBlocker={onBlocker}
														onOpenThread={openThread}
														snapshot={snapshot}
													/>
												</section>
											) : null,
										row: statusOf,
									}
								: undefined
						}
						members={members}
						now={now}
						onInvite={() => setTab("squad")}
						onOpen={openThread}
						onSelect={setSelectedId}
						onShowQuests={showQuests}
						ready={dailiesReady}
						selected={selected}
						size={squadSize}
						squad={squad}
						threads={matches.slice(0, world.matches.threads.length)}
						waiting={waiting}
					/>
				}
				fitPlates={withActs ? LOBBY_ACT_PLATE_FIT : undefined}
				insets={insets}
				label={`Lobby plaza: your squad on the podium, the quest board, the play portal${withActs && budget.iconOnly ? "" : " and the recent-matches board"}. Tab or the arrow keys move between them; drag to pan, plus and minus to zoom.`}
				night={night}
				reducedMotion={reduceMotion}
				view={isoView}
			>
				{({ quality, theme }) => (
					<LobbyDiorama
						activeThreadId={openThreadId}
						acts={actView ? { onStage, view: actView } : null}
						looks={looks}
						members={members}
						night={night}
						now={now}
						onInvite={() => setTab("squad")}
						onOpen={openThread}
						onSelect={setSelectedId}
						onShowQuests={showQuests}
						onStart={startWith}
						quality={quality}
						ready={dailiesReady}
						reducedMotion={reduceMotion}
						selected={selected}
						shape={shape}
						theme={theme}
						waiting={waiting}
						world={world}
					/>
				)}
			</IsoStage>
		</div>
	);
	if (tab === "quests") {
		body = (
			<LobbyActFaces.Provider value={withActs ? actFaces : null}>
				<LobbyQuests
					activeThreadId={openThreadId}
					board={board}
					kind={questKind}
					loading={loading}
					now={now}
					onAction={runQuest}
					onKind={setQuestKind}
					snapshot={snapshot}
				/>
			</LobbyActFaces.Provider>
		);
	} else if (tab === "squad") {
		body = (
			<LobbyRoster
				acts={
					withActs
						? {
								labelOf: (agentId) => acts.get(agentId)?.ariaLabel,
								working: totals.working,
							}
						: undefined
				}
				loading={loading}
				members={members}
				onPick={pickFromRoster}
				selectedId={selected?.agent.id}
				squadIds={squadIds}
			/>
		);
	} else if (tab === "news") {
		body = (
			<LobbyNews
				acted={withActs}
				activeThreadId={openThreadId}
				index={Math.min(newsIndex, Math.max(0, news.length - 1))}
				items={news}
				loading={loading}
				now={now}
				onIndex={setNewsIndex}
				onOpen={openThread}
			/>
		);
	}

	return (
		<GameShell
			accent="sky"
			busy={loading}
			hud={
				<>
					<LobbyNav
						badges={{ quests: loading ? 0 : readyToClaim }}
						compact={compact}
						level={level}
						loading={loading}
						onTab={setTab}
						tab={tab}
					/>
					{withActs ? (
						<GameHudSlot
							at="top-left"
							className="@min-[672px]/game:top-[76px] top-[60px] max-w-full flex-col items-start"
						>
							<div
								className="flex max-w-full flex-col items-start gap-2"
								ref={actHudRef}
							>
								<p
									className={cn(
										GAME_PLATE,
										"pointer-events-auto w-fit max-w-full truncate rounded-xl px-3 py-1.5 font-semibold text-[13px]"
									)}
									data-act-summary=""
								>
									{actSummaryLine(totals)}
								</p>
								<BlindSpotCaption snapshot={snapshot} />
								<div className="flex gap-2">{actButtons}</div>
							</div>
						</GameHudSlot>
					) : null}
					{tab === "lobby" && !loading && !isEmpty ? (
						<>
							<GameHudSlot at="bottom-left">
								<IsoZoomControls view={isoView} />
							</GameHudSlot>
							<GameHudSlot
								at="bottom-right"
								className="@max-[559px]/game:left-16"
							>
								<LobbyPlay
									acted={withActs}
									members={members}
									onPick={pick}
									onStart={startPrompt}
									selected={selected?.agent}
									squadIds={squadIds}
								/>
							</GameHudSlot>
						</>
					) : null}
				</>
			}
			label="Lobby"
			onKeyDown={onRootKeyDown}
			rootRef={rootRef}
			sheet={
				panelOpen ? (
					<LobbyThreadPanel
						headingRef={headingRef}
						onClose={closeThread}
						snapshot={snapshot}
						thread={activeThread}
						threadView={threadView}
					/>
				) : null
			}
			stageRef={stageRef}
			testId="interface-lobby"
		>
			{withActs ? (
				<>
					<h1 className="sr-only" ref={lobbyHeadingRef} tabIndex={-1}>
						Lobby
					</h1>
					<AskQueueList
						acts={acts}
						clock={clock}
						fallbackFocus={lobbyHeadingRef}
						nowMs={nowMs}
						onAsk={onAsk}
						onBlocker={onBlocker}
						snapshot={snapshot}
						unowned={unowned}
					/>
				</>
			) : null}
			<div
				className={cn(
					"absolute inset-0 flex flex-col text-(--gk-ink)",
					LOBBY_SCENE_MODE,
					panelOpen &&
						tab !== "lobby" &&
						"@min-[672px]/game:pe-[calc(min(440px,100%-24px)+24px)]"
				)}
				style={{ ...LOBBY_SCENE_VARS, backgroundImage: STAGE_BACKGROUND }}
			>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0"
					style={STAGE_RAYS}
				/>
				<motion.div
					animate={{ opacity: 1 }}
					aria-labelledby={lobbyTabId(tab)}
					className="relative flex min-h-0 min-w-0 flex-1 flex-col @max-[759px]/game:pt-[68px] pt-[88px]"
					id={lobbyPanelId(tab)}
					initial={reduceMotion ? false : { opacity: 0.4 }}
					key={tab}
					role="tabpanel"
					// With acts, every tab's content starts below the act HUD.
					style={
						withActs && tab !== "lobby" && actHudBottom > 0
							? { paddingTop: actHudBottom + 12 }
							: undefined
					}
					transition={{ duration: 0.16, ease: "easeOut" }}
				>
					{isEmpty ? (
						<LobbyEmpty onStart={() => port.startThread({})} size={squadSize} />
					) : null}
					{isEmpty ? null : body}
				</motion.div>
			</div>
			{withActs ? <ActAnnouncer sentence={sentence} /> : null}
			{cards.element}
		</GameShell>
	);
}
