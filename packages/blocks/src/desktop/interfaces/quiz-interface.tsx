import {
	type InterfaceParamsByRenderer,
	type InterfaceThread,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { MessageCircleQuestion, RotateCcw, Trophy } from "lucide-react";
import { AnimatePresence, MotionConfig } from "motion/react";
import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { keepsActOverlay } from "./act-settings.ts";
import {
	GAME_PLATE,
	GameAction,
	GameIconButton,
	GameTitlePlate,
} from "./game-hud.tsx";
import { GameHudSlot, GameShell, gameSheetCover } from "./game-shell.tsx";
import {
	actHasBlocker,
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
import type { QuizActView } from "./quiz-acts.tsx";
import {
	focusTile,
	QuizBoardCells,
	QuizBoardFrame,
	QuizBoardSkeleton,
	revealTile,
	type TileHandlers,
} from "./quiz-board.tsx";
import { QuizAnswerBooth } from "./quiz-booth.tsx";
import {
	QuizClueCard,
	QuizEmptyCard,
	QuizFinalQuestion,
} from "./quiz-cards.tsx";
import { QuizContestants } from "./quiz-contestants.tsx";
import {
	boardTiles,
	buildContestants,
	buildQuizBoard,
	isBoardKey,
	isRevealed,
	moveOnBoard,
	parseRevealed,
	plural,
	pruneRevealed,
	QUIZ_PODIUMS,
	type QuizTile,
	REVEALED_STORAGE_KEY,
	type RevealedMap,
	tileAt,
	tilePosition,
} from "./quiz-model.ts";
import {
	BOARD_BEZEL,
	QUIZ_EFFECT_VARS,
	QUIZ_STAGE_VARS,
} from "./quiz-palette.ts";
import { AUDIENCE_IDS, HOST_ID, QuizStudio } from "./quiz-studio.tsx";
import { STUDIO_BOUNDS, STUDIO_TOP } from "./quiz-world.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

function readRevealed(): RevealedMap {
	try {
		return parseRevealed(
			globalThis.localStorage?.getItem(REVEALED_STORAGE_KEY)
		);
	} catch {
		return {};
	}
}

function writeRevealed(revealed: RevealedMap) {
	try {
		if (Object.keys(revealed).length === 0) {
			globalThis.localStorage?.removeItem(REVEALED_STORAGE_KEY);
		} else {
			globalThis.localStorage?.setItem(
				REVEALED_STORAGE_KEY,
				JSON.stringify(revealed)
			);
		}
	} catch {
		// Storage can be full or blocked; the board still plays for this visit.
	}
}

/** Escape inside a text field belongs to the field. */
function isEditable(target: EventTarget): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("input, textarea, select, [contenteditable='true']") !==
				null)
	);
}

type Overlay =
	| { kind: "clue"; threadId: string }
	| { agentId?: string; kind: "final" };

type FocusTarget =
	| { kind: "answer" }
	| { kind: "booth" }
	| { kind: "final" }
	| { kind: "restore" }
	| { kind: "tile"; threadId: string };

/** Below this stage width the HUD plates go compact. */
const COMPACT_BELOW = 720;
/** The island's rim round the studio. */
const ISLAND_RIM = 2.2;

/** A clue's status word from the act layer, for its tile's name. */
function clueWord(
	thread: InterfaceThread,
	state: {
		asked: Set<string>;
		blocking: Set<string>;
		stopped: Map<string, string>;
	},
	/** A delivered answer's headline: the flipped tile says it. */
	headline?: string
): string {
	if (state.blocking.has(thread.id)) {
		return "Needs you";
	}
	if ((thread.unread ?? 0) > 0) {
		return headline ? `Answer ready: ${headline}` : "Answer ready";
	}
	if (thread.running) {
		return "Working";
	}
	const stopped = state.stopped.get(thread.id);
	if (stopped) {
		return stopped;
	}
	return state.asked.has(thread.id) ? "Waiting on you" : "Done";
}

/** World units kept round the plates when the act layer frames the set. */
const QUIZ_ACT_PLATE_FIT = { above: 4.2, below: 1, max: 2.2, side: 1 };

/**
 * Quiz Show: the workspace as a TV quiz board in a studio, on the shared
 * game kits (game-shell.tsx, game3d-stage.tsx): an isometric studio
 * diorama (quiz-studio.tsx) whose back wall is the board. A fixed board of six categories (projects and
 * teams, then the busiest agents) by five values, 100 at the top to 500 at
 * the bottom. A column's conversations fill it from the bottom, the most
 * pressing on the 500 slot; the cheap slots above read as played. Picking a
 * tile grows it into the clue (the latest message); answering opens the
 * host's real conversation in the answer sheet. The contestants stand at
 * podiums in front of the wall with the host beside them; the HUD carries
 * the round, the final question and a fresh board.
 */
export function QuizInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["quiz"]>) {
	// The live settings (a bare `{}` resolves to the defaults).
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	const { audience, round } = resolveInterfaceParams(
		"quiz",
		params
	) as Required<InterfaceParamsByRenderer["quiz"]>;
	const reducedMotion = useReducedMotion();
	const animate = !reducedMotion;
	const actsView = useActs(snapshot);
	const { acts, enabled: withActs, nowMs, privacy, unowned } = actsView;
	// What the act layer says about each clue's thread: an open ask (a
	// blocking one lights the clue), a run, a counted stop, an answer to read.
	const clueState = useMemo(() => {
		// Only a blocking ask or an answer to read keeps a clue up; a
		// suggestion does not.
		const asked = new Set<string>();
		const blocking = new Set<string>();
		const stopped = new Map<string, string>();
		for (const ask of snapshot.asks ?? []) {
			if (ask.threadId && (ask.blocking || ask.kind === "reply")) {
				asked.add(ask.threadId);
				if (ask.blocking) {
					blocking.add(ask.threadId);
				}
			}
		}
		// A counted stop's word is its act's: sitting out, paused or stopped.
		for (const act of acts.values()) {
			for (const thread of snapshot.threads) {
				if (!(thread.blocker && actHasBlocker(act, thread))) {
					continue;
				}
				let word = "Stopped";
				if (act.act === "limited") {
					word = "Sitting out";
				} else if (thread.blocker.kind === "interrupted") {
					word = "Paused";
				}
				stopped.set(thread.id, word);
			}
			// A limit on the agent (not on a thread) sits out the clue it was
			// on; its played clues stay played.
			if (act.act === "limited" && act.threadId && !stopped.has(act.threadId)) {
				stopped.set(act.threadId, "Sitting out");
			}
		}
		return { asked, blocking, stopped };
	}, [acts, snapshot.asks, snapshot.threads]);
	// With acts, a delivered answer flips its clue to the answer's headline.
	const headlines = useMemo(() => {
		const out = new Map<string, string>();
		if (!withActs) {
			return out;
		}
		for (const act of acts.values()) {
			const thread = act.threadId
				? snapshot.threads.find((item) => item.id === act.threadId)
				: undefined;
			const headline = thread?.outcome?.headline;
			if (act.act === "delivering" && thread && headline) {
				out.set(thread.id, headline);
			}
		}
		return out;
	}, [acts, snapshot.threads, withActs]);
	const legacyBoard = useMemo(
		() => buildQuizBoard(snapshot, round),
		[round, snapshot]
	);
	// With acts a clue is lit (needs you) only while a blocking ask waits on it.
	const board = useMemo(
		() =>
			withActs
				? {
						...legacyBoard,
						columns: legacyBoard.columns.map((category) =>
							category
								? {
										...category,
										tiles: category.tiles.map((tile) => ({
											...tile,
											needsYou: clueState.blocking.has(tile.thread.id),
											statusWord: clueWord(
												tile.thread,
												clueState,
												headlines.get(tile.thread.id)
											),
										})),
									}
								: category
						),
					}
				: legacyBoard,
		[clueState, headlines, legacyBoard, withActs]
	);
	// With acts the podiums go to the most urgent agents (asking first), not
	// to the busiest ones.
	const { offStage, onStage } = useMemo(
		() => stageAgents(acts, QUIZ_PODIUMS),
		[acts]
	);
	const contestants = useMemo(() => {
		if (!withActs) {
			return buildContestants(snapshot);
		}
		const all = buildContestants(snapshot, Number.POSITIVE_INFINITY);
		const byId = new Map(all.map((entry) => [entry.agent.id, entry]));
		return onStage
			.map((act) => byId.get(act.agentId))
			.filter((entry) => entry !== undefined);
	}, [onStage, snapshot, withActs]);
	const tiles = useMemo(() => boardTiles(board), [board]);
	const [revealed, setRevealed] = useState<RevealedMap>(readRevealed);
	const [overlay, setOverlay] = useState<Overlay | null>(null);
	const [rovingId, setRovingId] = useState<string | null>(null);

	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLElement>(null);
	const [stageWidth, setStageWidth] = useState(0);
	const compact = stageWidth > 0 && stageWidth < COMPACT_BELOW;
	const night = useGameNight(rootRef);
	const isoView = useIsoView();
	const shape = useMemo(
		() =>
			islandFor(
				STUDIO_BOUNDS.maxX - STUDIO_BOUNDS.minX,
				STUDIO_BOUNDS.maxZ - STUDIO_BOUNDS.minZ,
				ISLAND_RIM
			),
		[]
	);
	const lookIds = useMemo(
		() => [
			...contestants.map((entry) => entry.agent.id),
			HOST_ID,
			...AUDIENCE_IDS,
		],
		[contestants]
	);
	const { looks } = useVillagerLooks(lookIds, night);
	const answerRef = useRef<HTMLButtonElement>(null);
	const finalFieldRef = useRef<HTMLTextAreaElement>(null);
	const quizHeadingRef = useRef<HTMLHeadingElement>(null);
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const actCards = useActCards({
		acts,
		clock,
		fallbackFocus: quizHeadingRef,
		nowMs,
		port,
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
	const boothHeadingRef = useRef<HTMLHeadingElement>(null);
	const restoreRef = useRef<HTMLElement | null>(null);
	const focusRef = useRef<FocusTarget | null>(null);

	const panelOpen = threadView !== null;
	// The booth floats over the right; the studio refits beside it (on a
	// narrow stage the booth covers it all).
	const cover = panelOpen && stageWidth > 0 ? gameSheetCover(stageWidth) : 0;
	const sheetCover = cover < stageWidth ? cover : 0;
	const insets = useMemo(
		() => ({
			bottom: compact ? 64 : 80,
			left: 16,
			right: 16 + sheetCover,
			top: (compact ? 64 : 88) + (withActs ? 112 : 0),
		}),
		[compact, sheetCover, withActs]
	);
	const tileFor = (threadId: string | null): QuizTile | undefined =>
		threadId ? tiles.find((tile) => tile.thread.id === threadId) : undefined;
	const clueTile =
		overlay?.kind === "clue" ? tileFor(overlay.threadId) : undefined;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const inPlayId = panelOpen ? activeThreadId : null;
	const tabStopId =
		[rovingId, inPlayId].find((id) => tileFor(id ?? null)) ??
		tiles[0]?.thread.id ??
		null;
	// With acts a clue is played once its answer is read and nothing is
	// left on it: no open ask, no run, no counted stop. Old hosts keep the
	// board's own reveals.
	const shown = (tile: QuizTile) =>
		withActs
			? (tile.thread.unread ?? 0) === 0 &&
				!tile.thread.running &&
				!clueState.asked.has(tile.thread.id) &&
				!clueState.stopped.has(tile.thread.id)
			: isRevealed(revealed, tile.thread);
	const left = tiles.filter((tile) => !shown(tile)).length;
	const isEmpty = !loading && snapshot.threads.length === 0;

	const commitRevealed = (next: RevealedMap) => {
		const pruned = pruneRevealed(next, snapshot.threads);
		setRevealed(pruned);
		writeRevealed(pruned);
	};

	const rememberOpener = () => {
		const active = document.activeElement;
		restoreRef.current = active instanceof HTMLElement ? active : null;
	};

	const pick = (threadId: string) => {
		const tile = tileFor(threadId);
		if (!tile) {
			return;
		}
		setRovingId(threadId);
		// With acts the act layer decides what is played; nothing is stored.
		if (!withActs) {
			commitRevealed({ ...revealed, [threadId]: tile.thread.updatedAt });
		}
		focusRef.current = { kind: "answer" };
		setOverlay({ kind: "clue", threadId });
	};
	const backToBoard = () => {
		focusRef.current =
			overlay?.kind === "clue"
				? { kind: "tile", threadId: overlay.threadId }
				: { kind: "restore" };
		setOverlay(null);
	};
	const answer = () => {
		if (overlay?.kind !== "clue") {
			return;
		}
		focusRef.current = { kind: "booth" };
		setOverlay(null);
		port.openThread(overlay.threadId);
	};
	const openFinal = (agentId?: string) => {
		rememberOpener();
		focusRef.current = { kind: "final" };
		setOverlay({ agentId, kind: "final" });
	};
	const submitFinal = (input: { agentId?: string; prompt: string }) => {
		focusRef.current = { kind: "booth" };
		setOverlay(null);
		port.startThread(input);
	};
	const closeBooth = () => {
		focusRef.current = activeThreadId
			? { kind: "tile", threadId: activeThreadId }
			: { kind: "restore" };
		port.closeThread();
	};
	const newGame = () => commitRevealed({});

	// Move focus with whatever just opened or closed, so it never drops to <body>.
	useLayoutEffect(() => {
		const target = focusRef.current;
		if (!target) {
			return;
		}
		if (target.kind === "booth" && !panelOpen) {
			return; // Wait for the host to open the thread.
		}
		focusRef.current = null;
		if (target.kind === "answer") {
			answerRef.current?.focus();
		} else if (target.kind === "final") {
			finalFieldRef.current?.focus();
		} else if (target.kind === "booth") {
			boothHeadingRef.current?.focus();
			// Keep the clue being answered in sight beside the booth.
			if (activeThreadId) {
				revealTile(rootRef.current, activeThreadId);
			}
		} else if (
			!(target.kind === "tile" && focusTile(rootRef.current, target.threadId))
		) {
			const opener = restoreRef.current;
			restoreRef.current = null;
			if (opener?.isConnected) {
				opener.focus();
			} else if (tabStopId) {
				focusTile(rootRef.current, tabStopId);
			}
		}
	});

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

	// A clue whose conversation left the board closes on its own.
	useEffect(() => {
		if (overlay?.kind === "clue" && !clueTile) {
			setOverlay(null);
		}
	}, [overlay, clueTile]);

	const stepBack = () => {
		if (overlay) {
			backToBoard();
			return true;
		}
		if (panelOpen) {
			closeBooth();
			return true;
		}
		return false;
	};
	const escapeRef = useRef(stepBack);
	escapeRef.current = stepBack;

	// Escape with focus nowhere (after clicking plain text) still steps back.
	const steppable = overlay !== null || panelOpen;
	useEffect(() => {
		if (!steppable) {
			return;
		}
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				event.target === document.body &&
				escapeRef.current()
			) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, [steppable]);

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape" || event.defaultPrevented) {
			return;
		}
		const inField = isEditable(event.target);
		// In the final question, Escape leaves the card even from the text field.
		if (inField && overlay?.kind !== "final") {
			return;
		}
		if (stepBack()) {
			event.preventDefault();
		}
	};

	const handlers: TileHandlers = {
		clueFirst: withActs,
		onFocusTile: setRovingId,
		onKeyDown: (event, threadId) => {
			// In the studio the stage already moved focus, in reading order.
			if (event.defaultPrevented) {
				return;
			}
			const toBoardEdge = event.ctrlKey || event.metaKey;
			const edgeKey = event.key === "Home" || event.key === "End";
			if (event.altKey || (toBoardEdge && !edgeKey) || !isBoardKey(event.key)) {
				return;
			}
			const from = tilePosition(board, threadId);
			if (!from) {
				return;
			}
			event.preventDefault();
			const to = moveOnBoard(board, from, event.key, toBoardEdge);
			const next = tileAt(board, to);
			if (next) {
				setRovingId(next.thread.id);
				focusTile(rootRef.current, next.thread.id);
			}
		},
		onPick: pick,
	};

	const offBoardNote =
		board.offBoard > 0
			? `, ${plural(board.offBoard, "conversation", "conversations")} not on the board`
			: "";
	const boardLabel = loading
		? "Game board, loading"
		: `Game board, ${board.round}${offBoardNote}`;

	const needYou = tiles.filter((tile) => tile.needsYou && !shown(tile)).length;
	const tally =
		board.threadCount === 0
			? "Board empty"
			: `${plural(left, "clue", "clues")} left`;
	const status = loading
		? "Setting up the board"
		: [board.round, tally, needYou > 0 ? `${needYou} need you` : null]
				.filter(Boolean)
				.join(" \u00b7 ");
	const canReset = !loading && Object.keys(revealed).length > 0;

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
						{ reduced: reducedMotion }
					).filter((item) => keepsActOverlay(item, kitSettings))
				),
			]
				.sort()
				.join("|")
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shownIds = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		actCards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => actCards.openBlocker(threadId, agentName, opener);
	const actView: QuizActView | null = withActs
		? {
				acts,
				clock,
				iconOnly: budget.iconOnly,
				nowMs,
				offStage,
				onAsk: (askId) => actCards.openAsk(askId),
				onBlocker: (threadId, agentName) =>
					actCards.openBlocker(threadId, agentName),
				onQueue: () => openQueue(queueOpener),
				owners,
				privacy,
				shown: shownIds,
				slots,
				snapshot,
			}
		: null;
	const offStageActs = new Map(
		[...acts].filter(([id]) => !onStage.some((act) => act.agentId === id))
	);
	const contestantActs = withActs
		? {
				offStage:
					offStageActs.size > 0 ? (
						<section
							aria-label="Off the podiums"
							className={`${GAME_PLATE} mt-3 p-3`}
						>
							<ActAgentList
								acts={offStageActs}
								clock={clock}
								nowMs={nowMs}
								onAsk={onAsk}
								onBlocker={onBlocker}
								onOpenThread={port.openThread}
								snapshot={snapshot}
							/>
						</section>
					) : null,
				row: (agentId: string) => {
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
				},
			}
		: undefined;
	const hud = (
		<>
			<GameHudSlot
				at="top-left"
				className={
					withActs
						? "max-w-[calc(100%-7.5rem)] flex-col items-start [&>*]:max-w-full"
						: undefined
				}
			>
				<GameTitlePlate
					compact={compact}
					icon={<Trophy aria-hidden="true" />}
					keepStatus={withActs}
					status={withActs ? actSummaryLine(totals) : status}
					title="Quiz Show"
				/>
				{withActs ? (
					<>
						<BlindSpotCaption snapshot={snapshot} />
						<div className="flex gap-2">
							<NeedYouButton
								onAsk={onAsk}
								snapshot={snapshot}
								totals={totals}
							/>
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
						</div>
					</>
				) : null}
			</GameHudSlot>
			<GameHudSlot at="top-right" className="items-center">
				{/* With acts the board follows the agents; there is no game to reset. */}
				{withActs ? null : (
					<GameIconButton
						disabled={!canReset}
						label="New game"
						onClick={newGame}
						title={
							canReset
								? "New game: put every clue back on the board"
								: "No clues played yet"
						}
					>
						<RotateCcw
							aria-hidden="true"
							className="size-5"
							strokeWidth={2.5}
						/>
					</GameIconButton>
				)}
				<GameAction
					compact={compact}
					disabled={loading}
					icon={<MessageCircleQuestion aria-hidden="true" />}
					label="Final question"
					onClick={() => openFinal()}
				/>
			</GameHudSlot>
			{loading || isEmpty ? null : (
				<GameHudSlot at="bottom-right">
					<IsoZoomControls view={isoView} />
				</GameHudSlot>
			)}
		</>
	);

	const cards = (
		<AnimatePresence>
			{clueTile ? (
				<QuizClueCard
					animate={animate}
					answerRef={answerRef}
					key={`clue-${clueTile.thread.id}`}
					onAnswer={answer}
					onBack={backToBoard}
					snapshot={snapshot}
					tile={clueTile}
				/>
			) : null}
			{overlay?.kind === "final" ? (
				<QuizFinalQuestion
					agents={snapshot.agents}
					animate={animate}
					defaultAgentId={overlay.agentId ?? contestants[0]?.agent.id}
					featuredIds={contestants.map((entry) => entry.agent.id)}
					fieldRef={finalFieldRef}
					key="final"
					onCancel={backToBoard}
					onSubmit={submitFinal}
				/>
			) : null}
		</AnimatePresence>
	);

	return (
		<MotionConfig reducedMotion={reducedMotion ? "always" : "user"}>
			<GameShell
				accent="sun"
				busy={loading}
				hud={hud}
				label="Quiz Show"
				onKeyDown={onRootKeyDown}
				rootRef={rootRef}
				sheet={
					panelOpen ? (
						<QuizAnswerBooth
							headingRef={boothHeadingRef}
							onClose={closeBooth}
							snapshot={snapshot}
							thread={activeThread}
							threadView={threadView}
							tile={tileFor(activeThreadId)}
						/>
					) : null
				}
				stageRef={stageRef}
				testId="interface-quiz"
			>
				<div
					className="absolute inset-0 flex flex-col"
					style={{ ...QUIZ_STAGE_VARS, ...QUIZ_EFFECT_VARS }}
				>
					<h1 className="sr-only" ref={quizHeadingRef} tabIndex={-1}>
						Quiz Show
					</h1>
					{withActs ? (
						<AskQueueList
							acts={acts}
							clock={clock}
							fallbackFocus={quizHeadingRef}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							snapshot={snapshot}
							unowned={unowned}
						/>
					) : null}
					{loading || isEmpty ? (
						<div className="flex min-h-0 flex-1 @min-[672px]/game:px-8 px-3 @min-[672px]/game:pt-24 pt-20 @min-[672px]/game:pb-8 pb-4 [container:set/size]">
							<QuizBoardFrame
								busy={loading}
								cells={loading ? <QuizBoardSkeleton /> : null}
								className="m-auto h-[min(100cqh,calc(100cqw/1.75))] w-[min(100cqw,calc(100cqh*1.75))]"
								label={boardLabel}
								rows={2}
							>
								{isEmpty && overlay?.kind !== "final" ? (
									<QuizEmptyCard
										hasAgents={snapshot.agents.length > 0}
										onStart={() => port.startThread({})}
									/>
								) : null}
								{cards}
							</QuizBoardFrame>
						</div>
					) : (
						<div className="relative min-h-0 flex-1">
							<IsoStage
								bounds={{ ...STUDIO_BOUNDS, top: STUDIO_TOP }}
								fallback={
									<div className="absolute inset-0 flex flex-col overflow-y-auto @min-[672px]/game:pt-24 pt-20">
										<div className="flex min-h-[420px] flex-1 @min-[672px]/game:px-8 px-3 pb-4 [container:set/size]">
											<QuizBoardFrame
												cells={
													<QuizBoardCells
														animate={animate}
														board={board}
														handlers={handlers}
														inPlayId={inPlayId}
														isRevealed={shown}
														openId={clueTile ? clueTile.thread.id : null}
														tabStopId={tabStopId}
													/>
												}
												className="m-auto @max-[35rem]/set:h-auto h-[min(100cqh,calc(100cqw/1.75))] @max-[35rem]/set:w-full w-[min(100cqw,calc(100cqh*1.75))] @max-[35rem]/set:[container-type:inline-size]"
												label={boardLabel}
												rows={board.rows}
											/>
										</div>
										<QuizContestants
											acts={contestantActs}
											contestants={contestants}
											onAsk={openFinal}
										/>
									</div>
								}
								// With acts, zoom on to the board, the podiums and the lectern.
								fitPlates={withActs ? QUIZ_ACT_PLATE_FIT : undefined}
								insets={insets}
								label={`${boardLabel}. The studio: the board's wall of tiles, the contestants at their podiums and the host. Tab or the arrow keys move between the clues and the contestants; drag to pan, plus and minus to zoom.`}
								night={night}
								reducedMotion={reducedMotion}
								view={isoView}
							>
								{({ quality, theme }) => (
									<QuizStudio
										acts={actView ? { onStage, view: actView } : null}
										audience={audience}
										board={board}
										contestants={contestants}
										handlers={handlers}
										headlines={headlines}
										inPlayId={inPlayId}
										isRevealed={shown}
										looks={looks}
										night={night}
										onAsk={openFinal}
										openId={clueTile ? clueTile.thread.id : null}
										quality={quality}
										reducedMotion={reducedMotion}
										shape={shape}
										theme={theme}
									/>
								)}
							</IsoStage>
							{/* The clue and the final question come up on a screen over the set. */}
							{clueTile || overlay?.kind === "final" ? (
								<div
									className="pointer-events-none absolute inset-0 z-40 grid place-items-center @min-[672px]/game:px-8 px-3 @min-[672px]/game:pt-24 pt-20 pb-6"
									style={{ paddingRight: sheetCover + 12 }}
								>
									<div
										className="pointer-events-auto relative h-[min(100%,460px)] w-[min(100%,780px)] rounded-[10px] bg-(--quiz-frame) [container:board/size]"
										style={{ boxShadow: BOARD_BEZEL }}
									>
										{cards}
									</div>
								</div>
							) : null}
						</div>
					)}
				</div>
				{withActs ? <ActAnnouncer sentence={sentence} /> : null}
				{actCards.element}
			</GameShell>
		</MotionConfig>
	);
}
