import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import { GAME_PLATE } from "./game-hud.tsx";
import { GameHudSlot, GameShell } from "./game-shell.tsx";
import { actSummaryLine } from "./game3d-acts.ts";
import { IsoStage, IsoZoomControls } from "./game3d-stage.tsx";
import {
	ActAgentList,
	ActAnnouncer,
	AskQueueList,
	BlindSpotCaption,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { LobbyDiorama } from "./lobby-diorama.tsx";
import { LobbyEmpty } from "./lobby-empty.tsx";
import { useLobbyActLayer } from "./lobby-interface-act-layer.tsx";
import { LOBBY_ACT_PLATE_FIT } from "./lobby-interface-constants.ts";
import { useLobbyThreadFocus } from "./lobby-interface-focus.ts";
import { useLobbyInterfaceState } from "./lobby-interface-state.ts";
import { LobbyList } from "./lobby-list.tsx";
import { addToSquad, claimableCount, type QuestAction } from "./lobby-model.ts";
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

/**
 * Lobby: a game menu over the same agents and threads, on the shared game
 * kits (game-shell.tsx, game3d-stage.tsx): the menu tabs and level sit in
 * the HUD. LOBBY is a plaza diorama (lobby-diorama.tsx) with up to four
 * agents as a squad on a lit podium, the quest board, a play portal and the
 * recent-matches board, and a PLAY plate that briefs the selected one; QUESTS turns what is waiting on you into claimable
 * quests; SQUAD is the roster; NEWS is the latest activity. Opening anything
 * shows the host's real conversation in the kit's side sheet.
 */
export function LobbyInterface(
	props: InterfaceRendererProps<InterfaceParamsByRenderer["lobby"]>
) {
	const tl = useLiteralMessages();
	const { loading, port, snapshot, threadView } = props;
	const state = useLobbyInterfaceState(props);
	const {
		reduceMotion,
		squadSize,
		tab,
		setTab,
		questKind,
		setQuestKind,
		newsIndex,
		setNewsIndex,
		setPickedSquad,
		setSelectedId,
		members,
		acts,
		withActs,
		nowMs,
		unowned,
		onStage,
		squad,
		squadIds,
		selected,
		actFaces,
		board,
		news,
		level,
		readyToClaim,
		now,
		panelOpen,
		openThreadId,
		activeThread,
		isEmpty,
		rootRef,
		stageRef,
		compact,
		night,
		isoView,
		world,
		shape,
		looks,
		matches,
		waiting,
		insets,
		actHudRef,
		actHudBottom,
		headingRef,
		lobbyHeadingRef,
		sentence,
		clock,
		cards,
	} = state;
	const {
		actButtons,
		actView,
		budget,
		offStageActs,
		onAsk,
		onBlocker,
		stageBounds,
		statusOf,
		totals,
	} = useLobbyActLayer(snapshot, state);
	const { closeThread, onRootKeyDown, rememberOpener } = useLobbyThreadFocus({
		headingRef,
		panelOpen,
		port,
		rootRef,
	});
	const openThread = (threadId: string) => {
		rememberOpener();
		port.openThread(threadId);
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
				label={
					withActs && budget.iconOnly
						? tl(
								"Lobby plaza: your squad on the podium, the quest board, the play portal. Tab or the arrow keys move between them; drag to pan, plus and minus to zoom."
							)
						: tl(
								"Lobby plaza: your squad on the podium, the quest board, the play portal and the recent-matches board. Tab or the arrow keys move between them; drag to pan, plus and minus to zoom."
							)
				}
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
