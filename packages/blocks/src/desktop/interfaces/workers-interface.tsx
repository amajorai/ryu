import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { gameTitleHeight } from "./game-hud.tsx";
import { GameShell, gameSheetCover } from "./game-shell.tsx";
import { actSummaryLine } from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import {
	IsoStage,
	useGameNight,
	useIsoView,
	useReducedMotion,
} from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
	ActAnnouncer,
	AskQueueList,
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";
import { OFFICE_RIM, WorkersDioramaScene } from "./workers-diorama.tsx";
import { useElementSize } from "./workers-hooks.ts";
import { WorkersHud } from "./workers-hud.tsx";
import { useWorkersActScene } from "./workers-interface-acts.ts";
import { useWorkersEscape } from "./workers-interface-escape.ts";
import { EmptyOffice, LoadingOffice } from "./workers-interface-loading.tsx";
import { WorkersList } from "./workers-list.tsx";
import {
	ACT_SPREAD,
	actWorkers,
	buildWorkers,
	layoutOffice,
	workerIndexForThread,
	workerTotals,
	workspaceName,
} from "./workers-model.ts";
import { WORKERS_SCENE_CSS, workersArt } from "./workers-palette.ts";
import { WorkersPanel, type WorkersSheetView } from "./workers-panel.tsx";

type Sheet = { kind: "new" } | { kind: "worker"; workerId: string };

const STAGE_FALLBACK = { height: 808, width: 1280 };

/**
 * Workers: the workspace as a cosy open-plan office diorama on an island,
 * built on the 3D game kit. Every agent is a villager at its own desk,
 * before a monitor whose screen glows in its conversation's colour
 * (working, waiting on you, a failed run, or a dim screensaver), with the
 * conversation's title on a screen plate. A screen plate opens that
 * conversation in the game kit's sheet (Back goes to the worker's desk: its
 * tasks and a composer for a new one); a worker's name plate opens their
 * desk; New task starts one with any worker.
 */
export function WorkersInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["workers"]>) {
	const tl = useLiteralMessages();
	const baseWorkers = useMemo(
		() => (loading ? [] : buildWorkers(snapshot)),
		[loading, snapshot]
	);
	// The act layer (when the host sends asks): what each worker acts out,
	// the queue at your door, the cards, the HUD summary and the announcer.
	const actsView = useActs(snapshot);
	const { acts, nowMs, privacy, unowned } = actsView;
	const actsOn = actsView.enabled && !loading;
	// With acts every light, monitor and label follows the act.
	const workers = useMemo(
		() => (actsOn ? actWorkers(baseWorkers, acts) : baseWorkers),
		[acts, actsOn, baseWorkers]
	);
	const totals = useMemo(() => workerTotals(baseWorkers), [baseWorkers]);
	const reduced = useReducedMotion();
	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const size = useElementSize(stageRef, STAGE_FALLBACK);
	const night = useGameNight(rootRef);
	const isoView = useIsoView();
	const plan = useMemo(
		() => layoutOffice(workers, actsOn ? ACT_SPREAD : 1),
		[actsOn, workers]
	);
	const shape = useMemo(
		() =>
			islandFor(plan.halfWidth * 2 + 0.3, plan.halfDepth * 2 + 0.3, OFFICE_RIM),
		[plan]
	);
	const agentIds = useMemo(
		() => snapshot.agents.map((agent) => agent.id),
		[snapshot.agents]
	);
	const { looks } = useVillagerLooks(agentIds, night);
	const art = workersArt(night);
	const [sheet, setSheet] = useState<Sheet | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const headingRef = useRef<HTMLHeadingElement>(null);
	const hudHeadingRef = useRef<HTMLHeadingElement>(null);
	const focusTarget = useRef<"hud" | "sheet" | null>(null);

	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: hudHeadingRef,
		nowMs,
		port,
		snapshot,
	});
	const { openAsk, openBlocker } = cards;
	const { actScene, onAsk, onBlocker, queueOpener, tally } = useWorkersActScene(
		{
			acts,
			actsOn,
			clock,
			nowMs,
			openAsk,
			openBlocker,
			params,
			privacy,
			reduced,
			snapshot,
			unowned,
			width: size.width,
		}
	);

	const threadOpen = threadView !== null && threadView !== undefined;
	const sheetWorker =
		sheet?.kind === "worker"
			? workers.find((worker) => worker.id === sheet.workerId)
			: undefined;
	const preferIndex = sheetWorker ? workers.indexOf(sheetWorker) : -1;
	const ownerIndex = workerIndexForThread(workers, activeThreadId, preferIndex);
	const owner = workers[ownerIndex] ?? sheetWorker;

	let view: WorkersSheetView | null = null;
	if (threadOpen) {
		view = {
			kind: "thread",
			thread: snapshot.threads.find((thread) => thread.id === activeThreadId),
			worker: owner,
		};
	} else if (sheet?.kind === "new") {
		view = { kind: "new" };
	} else if (sheetWorker) {
		view = { kind: "worker", worker: sheetWorker };
	}
	const viewKey = view
		? `${view.kind}:${view.kind === "worker" ? view.worker.id : ""}:${threadOpen ? (activeThreadId ?? "new") : ""}`
		: "office";

	const cover = view ? gameSheetCover(size.width) : 0;
	// On a narrow stage the sheet covers everything: nothing to reframe.
	const sheetCover = cover < size.width ? cover : 0;
	const roomWidth = size.width - sheetCover;
	const compact = roomWidth < 720;
	const insets = useMemo(
		() => ({
			bottom: compact ? 72 : 96,
			left: 16,
			right: 16 + sheetCover,
			// A phone's title plate wraps the act summary to two lines.
			top: compact ? 10 + gameTitleHeight(actsOn ? 2 : 1) + 8 : 92,
		}),
		[actsOn, compact, sheetCover]
	);
	const selectedId = view?.kind === "worker" ? view.worker.id : owner?.id;
	useLayoutEffect(() => {
		const target = focusTarget.current;
		if (!(target && viewKey)) {
			return;
		}
		focusTarget.current = null;
		if (target === "sheet") {
			headingRef.current?.focus();
		} else {
			hudHeadingRef.current?.focus();
		}
	}, [viewKey]);

	// Announce only workers newly waiting on you, not every snapshot.
	const waiting = loading || actsOn ? null : totals.waitingOnYou;
	const lastWaiting = useRef<number | null>(null);
	// Once acts arrive the act announcer speaks: clear any legacy words.
	useEffect(() => {
		if (actsOn) {
			setAnnouncement("");
		}
	}, [actsOn]);
	useEffect(() => {
		const previous = lastWaiting.current;
		lastWaiting.current = waiting;
		if (previous !== null && waiting !== null && waiting > previous) {
			setAnnouncement(
				tl(
					"{waiting, plural, one {{count} worker} other {{count} workers}} waiting on you",
					{ count: String(waiting), waiting }
				)
			);
		}
	}, [tl, waiting]);

	/** A worker's name plate: their desk, with their tasks and a composer. */
	const openWorker = (workerId: string) => {
		if (threadOpen) {
			port.closeThread();
		}
		setSheet({ kind: "worker", workerId });
		focusTarget.current = "sheet";
	};
	/** A screen plate: the task the worker's monitor shows. */
	const openScreen = (workerId: string) => {
		const worker = workers.find((item) => item.id === workerId);
		if (!worker) {
			return;
		}
		setSheet({ kind: "worker", workerId });
		focusTarget.current = "sheet";
		if (worker.current) {
			port.openThread(worker.current.id);
		} else if (threadOpen) {
			port.closeThread();
		}
	};
	const openThread = (threadId: string) => {
		focusTarget.current = "sheet";
		port.openThread(threadId);
	};
	const back = () => {
		if (owner) {
			setSheet({ kind: "worker", workerId: owner.id });
		}
		focusTarget.current = "sheet";
		port.closeThread();
	};
	const close = () => {
		if (threadOpen) {
			port.closeThread();
		}
		setSheet(null);
		focusTarget.current = "hud";
	};
	const newTask = () => {
		if (threadOpen) {
			port.closeThread();
		}
		setSheet({ kind: "new" });
		focusTarget.current = "sheet";
	};
	const start = (input: { agentId?: string; prompt: string }) => {
		const worker = workers.find((item) => item.id === input.agentId);
		if (worker) {
			setSheet({ kind: "worker", workerId: worker.id });
			setAnnouncement(
				tl("Started a task on {name}'s computer", { name: worker.name })
			);
		}
		focusTarget.current = "sheet";
		port.startThread(
			input.agentId
				? { agentId: input.agentId, prompt: input.prompt }
				: { prompt: input.prompt }
		);
	};

	/** Escape steps back: an open task to its worker, then the sheet. */
	const stepBack = (): boolean => {
		if (threadOpen && owner) {
			back();
			return true;
		}
		if (view) {
			close();
			return true;
		}
		return false;
	};
	const onRootKeyDown = useWorkersEscape(stepBack, stageRef);

	const empty = !loading && workers.length === 0;
	const summary = actsOn
		? `Office: ${actSummaryLine(tally)}.`
		: tl(
				"Office: {workers, plural, one {{workerCount} worker} other {{workerCount} workers}}, {working} working, {waitingOnYou} waiting on you.",
				{
					waitingOnYou: String(totals.waitingOnYou),
					workerCount: String(totals.workers),
					workers: totals.workers,
					working: String(totals.working),
				}
			);
	const hud = (
		<WorkersHud
			acts={
				actsOn
					? {
							buttons: (
								<>
									<NeedYouButton
										onAsk={onAsk}
										snapshot={snapshot}
										totals={tally}
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
										totals={tally}
										unowned={unowned}
									/>
								</>
							),
							caption: <BlindSpotCaption snapshot={snapshot} />,
							summary: actSummaryLine(tally),
							totals: tally,
						}
					: null
			}
			compact={compact}
			legend={roomWidth >= 1100}
			loading={loading}
			newTaskOpen={view?.kind === "new"}
			onNewTask={newTask}
			title={workspaceName(
				snapshot.groups,
				workers.map((worker) => worker.id)
			)}
			totals={totals}
			view={isoView}
		/>
	);
	return (
		<GameShell
			accent="sky"
			busy={loading}
			data-motion={reduced ? "reduce" : "full"}
			data-workers-scene=""
			hud={hud}
			label="Workers"
			onKeyDown={onRootKeyDown}
			rootRef={rootRef}
			sheet={
				view ? (
					<WorkersPanel
						activeThreadId={threadOpen ? activeThreadId : null}
						actMode={actsOn}
						freeId={
							actsOn
								? ([...acts.values()].find((act) => act.act === "idle")
										?.agentId ?? workers[0]?.id)
								: undefined
						}
						groups={snapshot.groups}
						headingRef={headingRef}
						onBack={back}
						onClose={close}
						onOpenThread={openThread}
						onOpenWorker={(workerId) => {
							setSheet({ kind: "worker", workerId });
							focusTarget.current = "sheet";
						}}
						onStart={start}
						threadView={threadView}
						view={view}
						workers={workers}
					/>
				) : null
			}
			testId="interface-workers"
		>
			<style>{WORKERS_SCENE_CSS}</style>
			<h1 className="sr-only" ref={hudHeadingRef} tabIndex={-1}>
				{workspaceName(
					snapshot.groups,
					workers.map((worker) => worker.id)
				)}
			</h1>
			<div className="absolute inset-0" ref={stageRef}>
				{loading ? (
					<LoadingOffice />
				) : (
					<>
						<p className="sr-only">{summary}</p>
						{actsOn ? (
							<AskQueueList
								acts={acts}
								clock={clock}
								fallbackFocus={hudHeadingRef}
								nowMs={nowMs}
								onAsk={onAsk}
								onBlocker={onBlocker}
								snapshot={snapshot}
								unowned={unowned}
							/>
						) : null}
						<IsoStage
							bounds={{
								// With acts the coffee corner's plates (a resting worker's
								// name and words) stand past the room's right wall.
								maxX: plan.halfWidth + (actsOn ? 1.4 : 0),
								maxZ: plan.halfDepth,
								minX: -plan.halfWidth,
								minZ: -plan.halfDepth,
								top: 2.6,
							}}
							fallback={
								<WorkersList
									actLayer={
										actsOn
											? { acts, clock, nowMs, onAsk, onBlocker, snapshot }
											: null
									}
									onOpenScreen={openScreen}
									onOpenWorker={openWorker}
									selectedId={view ? (selectedId ?? null) : null}
									workers={workers}
								/>
							}
							fill={1.3}
							insets={insets}
							label={
								actsOn
									? "Office diorama: a desk per worker. Tab or the arrow keys move between the workers and what waits for you; drag to pan, plus and minus to zoom."
									: "Office diorama: a desk per worker. Tab or the arrow keys move between workers and their screens; drag to pan, plus and minus to zoom."
							}
							night={night}
							reducedMotion={reduced}
							view={isoView}
						>
							{({ quality, theme }) => (
								<WorkersDioramaScene
									actScene={actScene}
									art={art}
									looks={looks}
									night={night}
									onOpenScreen={openScreen}
									onOpenWorker={openWorker}
									plan={plan}
									quality={quality}
									reducedMotion={reduced}
									selectedId={view ? (selectedId ?? null) : null}
									shape={shape}
									theme={theme}
								/>
							)}
						</IsoStage>
					</>
				)}
				{empty ? <EmptyOffice /> : null}
			</div>
			<p aria-live="polite" className="sr-only">
				{announcement}
			</p>
			{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
			{cards.element}
		</GameShell>
	);
}
