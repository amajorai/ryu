import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { MotionConfig } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { GameShell, gameSheetCover } from "./game-shell.tsx";
import { actTotals, stageAgents, youSpotSlots } from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { useGameNight, useIsoView, useReducedMotion } from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
	ActAnnouncer,
	AskQueueList,
	askOwners,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { QuizBoardFrame, QuizBoardSkeleton } from "./quiz-board.tsx";
import { QuizAnswerBooth } from "./quiz-booth.tsx";
import { QuizEmptyCard } from "./quiz-cards.tsx";
import { useQuizActViews } from "./quiz-interface-acts.tsx";
import {
	quizTileHandlers,
	useQuizEscape,
	useQuizFocusMove,
} from "./quiz-interface-focus.ts";
import { QuizHud } from "./quiz-interface-hud.tsx";
import { QuizOverlayCards, QuizStage } from "./quiz-interface-stage.tsx";
import {
	COMPACT_BELOW,
	type FocusTarget,
	ISLAND_RIM,
	type Overlay,
	readRevealed,
	useQuizBoardState,
	writeRevealed,
} from "./quiz-interface-state.ts";
import {
	boardTiles,
	buildContestants,
	isRevealed,
	plural,
	pruneRevealed,
	QUIZ_PODIUMS,
	type QuizTile,
	type RevealedMap,
} from "./quiz-model.ts";
import { QUIZ_EFFECT_VARS, QUIZ_STAGE_VARS } from "./quiz-palette.ts";
import { AUDIENCE_IDS, HOST_ID } from "./quiz-studio.tsx";
import { STUDIO_BOUNDS } from "./quiz-world.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

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
	const tl = useLiteralMessages();
	const reducedMotion = useReducedMotion();
	const animate = !reducedMotion;
	const actsView = useActs(snapshot);
	const { acts, enabled: withActs, nowMs, privacy, unowned } = actsView;
	const { board, clueState, headlines } = useQuizBoardState(
		snapshot,
		acts,
		withActs,
		round
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

	useQuizFocusMove({
		activeThreadId,
		answerRef,
		boothHeadingRef,
		finalFieldRef,
		focusRef,
		panelOpen,
		restoreRef,
		rootRef,
		tabStopId,
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

	const onRootKeyDown = useQuizEscape({
		backToBoard,
		closeBooth,
		overlay,
		panelOpen,
		rootRef,
	});

	const handlers = quizTileHandlers({
		board,
		pick,
		rootRef,
		setRovingId,
		withActs,
	});

	let boardLabel: string;
	if (loading) {
		boardLabel = "Game board, loading";
	} else if (board.offBoard > 0) {
		boardLabel = tl(
			"Game board, {round}, {count, plural, one {{countText} conversation} other {{countText} conversations}} not on the board",
			{
				count: board.offBoard,
				countText: String(board.offBoard),
				round: board.round,
			}
		);
	} else {
		boardLabel = tl("Game board, {round}", { round: board.round });
	}

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

	const { actView, contestantActs, onAsk, onBlocker } = useQuizActViews({
		actCards,
		acts,
		clock,
		nowMs,
		offStage,
		onStage,
		owners,
		port,
		privacy,
		queueOpener,
		reducedMotion,
		slots,
		snapshot,
		stageWidth,
		withActs,
	});
	const hud = (
		<QuizHud
			acts={acts}
			canReset={canReset}
			clock={clock}
			compact={compact}
			isEmpty={isEmpty}
			isoView={isoView}
			loading={loading}
			newGame={newGame}
			nowMs={nowMs}
			onAsk={onAsk}
			onBlocker={onBlocker}
			openFinal={openFinal}
			queueOpener={queueOpener}
			snapshot={snapshot}
			status={status}
			totals={totals}
			unowned={unowned}
			withActs={withActs}
		/>
	);

	const cards = (
		<QuizOverlayCards
			animate={animate}
			answerRef={answerRef}
			clueTile={clueTile}
			contestants={contestants}
			finalFieldRef={finalFieldRef}
			onAnswer={answer}
			onBack={backToBoard}
			onSubmitFinal={submitFinal}
			overlay={overlay}
			snapshot={snapshot}
		/>
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
						<QuizStage
							actView={actView}
							animate={animate}
							audience={audience}
							board={board}
							boardLabel={boardLabel}
							cards={cards}
							clueTile={clueTile}
							contestantActs={contestantActs}
							contestants={contestants}
							finalOpen={overlay?.kind === "final"}
							handlers={handlers}
							headlines={headlines}
							inPlayId={inPlayId}
							insets={insets}
							isoView={isoView}
							looks={looks}
							night={night}
							onStage={onStage}
							openFinal={openFinal}
							reducedMotion={reducedMotion}
							shape={shape}
							sheetCover={sheetCover}
							shown={shown}
							tabStopId={tabStopId}
							withActs={withActs}
						/>
					)}
				</div>
				{withActs ? <ActAnnouncer sentence={sentence} /> : null}
				{actCards.element}
			</GameShell>
		</MotionConfig>
	);
}
