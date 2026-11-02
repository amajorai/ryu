/* eslint-disable react/no-unknown-property */
import { Canvas } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import type { World3dParams } from "@ryuhq/protocol/interfaces";
import {
	type KeyboardEvent,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import { GAME_PLATE } from "./game-hud.tsx";
import { GAME_KIT_CSS } from "./game-palette.ts";
import { actSummaryLine, actTotals } from "./game3d-acts.ts";
import { agentSwatches } from "./game3d-palette.ts";
import { useReducedMotion, useWebGLProbe } from "./game3d-stage.tsx";
import { QUALITY } from "./game3d-toon.ts";
import {
	ActAgentList,
	ActAnnouncer,
	AskQueueList,
	askOwners,
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import { isAskKey, useInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";
import { useTalkingAgent, useWorldController } from "./use-world-controller.ts";
import {
	BAND_HEIGHT,
	CHOICES_WIDTH,
	World3dDialog,
} from "./world-3d-dialog.tsx";
import {
	QuestTracker,
	Village3dEmpty,
	Village3dHud,
	Village3dMinimap,
	Village3dPrompt,
} from "./world-3d-hud.tsx";
import {
	FirstFrames,
	LoadingWorld,
	useMeetActiveThreadAgent,
	useStageWidth,
	useWorldPort,
} from "./world-3d-interface-state.tsx";
import {
	useUrgentStatuses,
	useWorldActView,
	useWorldGoal,
	useWorldVillage,
} from "./world-3d-interface-village.ts";
import type { ViewShift } from "./world-3d-scene.tsx";
import { SCENE_THEMES } from "./world-3d-theme.ts";
import { VillageScene } from "./world-3d-village-scene.tsx";

export { showPlate } from "./world-3d-plate.tsx";

/**
 * Three-dimensional twin of the 2D world: the same village (a cottage per
 * agent, paths, a plaza and a forest rim) as a cel-shaded island that rolls
 * away over a curved horizon under an anime sky. The player walks up to an
 * agent (or clicks one) to talk; the dialogue offers past conversations and
 * a composer, and an open conversation shows the host's chat surface.
 */
export function World3dInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<World3dParams>) {
	const actsView = useActs(snapshot);
	const { acts, enabled: withActs, nowMs, privacy, unowned } = actsView;
	const reducedMotion = useReducedMotion();
	const { actLayout, layout, placed, slots, spread, staged, village } =
		useWorldVillage(snapshot, actsView, reducedMotion);
	const worldPort = useWorldPort(port, activeThreadId);
	const world = useWorldController(actLayout, worldPort, village.blocked);
	useMeetActiveThreadAgent(snapshot, activeThreadId, world);
	const probe = useWebGLProbe();
	const { stageRef, stageWidth } = useStageWidth();
	// Without WebGL (and with acts) the agents are a plain list: no HUD over
	// it, and the map is not a keyboard surface.
	const listOnly = withActs && probe?.supported === false;
	const rootRef = useRef<HTMLDivElement>(null);
	const covered = useInterfaceCovered(rootRef);
	const [drawn, setDrawn] = useState(false);
	const onDrawn = useCallback(() => setDrawn(true), []);
	const [hovered, setHovered] = useState<string | null>(null);
	const { talkingAgent, talkingThreads } = useTalkingAgent(
		snapshot,
		world.talkingTo,
		activeThreadId
	);
	const theme = SCENE_THEMES[params.theme];
	const swatches = useMemo(
		() =>
			agentSwatches(
				layout.entities.map((entity) => entity.agentId),
				theme.night
			),
		[layout, theme.night]
	);
	const isometric = params.camera === "isometric";
	const urgent = useUrgentStatuses(acts, snapshot.threads, withActs);
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const worldHeadingRef = useRef<HTMLHeadingElement>(null);
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: worldHeadingRef,
		nowMs,
		port,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	const totals = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const goal = useWorldGoal({
		layout,
		loading,
		nowMs,
		placed,
		player: world.player,
		privacy,
		snapshot,
		totals,
		withActs,
	});
	const actView = useWorldActView({
		actsView,
		cards,
		clock,
		mapRef: world.mapRef,
		owners,
		queueOpener,
		reducedMotion,
		slots,
		snapshot,
		staged,
		stageWidth,
		talking: world.talkingTo !== null,
	});
	// With acts an asking agent is answered, not walked to or talked to:
	// the tracker and the talk keys open its ask (it waits on your step).
	const askOf = (agentId: string) => {
		const act = withActs ? acts.get(agentId) : undefined;
		return act?.act === "asking" ? act.ask : null;
	};
	const talkOrAnswer = (
		agentId: string,
		opener?: HTMLElement,
		askId?: string
	) => {
		const ask = askOf(agentId);
		// The tracker names one ask: it opens exactly that one, and focus
		// returns to the tracker when the card closes.
		const id = askId ?? ask?.id;
		if (id) {
			cards.openAsk(id, opener ?? world.mapRef.current ?? undefined);
			return;
		}
		world.talkTo(agentId);
	};
	const onMapKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const ask = world.nearby ? askOf(world.nearby.agentId) : null;
		// E, Enter and Space beside an asker answer it (the controller's talk
		// keys would visit it), past its own guards.
		if (ask && isAskKey(event)) {
			event.preventDefault();
			cards.openAsk(ask.id, world.mapRef.current ?? undefined);
			return;
		}
		world.onKeyDown(event);
	};
	const actButtons = (
		<div className="flex gap-2">
			<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={totals} />
			<QueueButton
				acts={acts}
				clock={clock}
				narrow={stageWidth < 640}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				openRef={queueOpener}
				snapshot={snapshot}
				totals={totals}
				unowned={unowned}
			/>
		</div>
	);
	const summary = (
		<p
			className={cn(
				GAME_PLATE,
				"pointer-events-auto w-fit max-w-full truncate rounded-xl px-3 py-1.5 font-semibold text-[13px]"
			)}
			data-act-summary=""
		>
			{actSummaryLine(totals)}
		</p>
	);
	const askQueue = (mode: "reveal" | "sheet") => (
		<AskQueueList
			acts={acts}
			clock={clock}
			fallbackFocus={worldHeadingRef}
			mode={mode}
			nowMs={nowMs}
			onAsk={onAsk}
			onBlocker={onBlocker}
			snapshot={snapshot}
			unowned={unowned}
		/>
	);
	const agentList = (revealOnFocus: boolean) => (
		<ActAgentList
			acts={acts}
			clock={clock}
			nowMs={nowMs}
			onAsk={onAsk}
			onBlocker={onBlocker}
			onOpenThread={port.openThread}
			revealOnFocus={revealOnFocus}
			snapshot={snapshot}
		/>
	);
	const empty = !loading && layout.entities.length === 0;
	const nearby = world.nearby;
	// The dialogue already says who you are talking to.
	const showPrompt = !(talkingAgent && nearby?.agentId === talkingAgent.id);
	const viewShift = useMemo<ViewShift>(() => {
		if (!talkingAgent) {
			return { x: 0, y: 0 };
		}
		if (threadView) {
			// Panel docked on the right: clamp(360px, 46vw, 680px).
			const panel = Math.min(680, Math.max(360, stageWidth * 0.46));
			return { x: panel / 2, y: 0 };
		}
		return {
			x: stageWidth > 720 ? CHOICES_WIDTH / 2 : 0,
			y: BAND_HEIGHT / 2,
		};
	}, [stageWidth, talkingAgent, threadView]);
	const minimapSize = stageWidth < 900 ? 96 : 120;
	const hud =
		talkingAgent || listOnly ? null : (
			<Village3dHud
				acts={
					// Without WebGL the list overlay carries them instead.
					withActs && !empty && !listOnly ? (
						<>
							{summary}
							<BlindSpotCaption snapshot={snapshot} />
							{actButtons}
						</>
					) : undefined
				}
				empty={
					empty ? (
						<Village3dEmpty
							onStart={() => port.startThread({})}
							place={theme.place}
						/>
					) : undefined
				}
				minimap={
					// The "Minimap" setting (shown unless turned off).
					layout.entities.length > 0 && params.minimap !== false ? (
						<Village3dMinimap
							entities={layout.entities}
							facing={world.facing}
							layout={layout}
							nearbyId={nearby?.agentId ?? null}
							player={world.player}
							size={minimapSize}
							swatches={swatches}
							theme={theme}
							village={village}
						/>
					) : undefined
				}
				prompt={
					showPrompt && !empty ? (
						<Village3dPrompt
							answer={nearby ? askOf(nearby.agentId) !== null : false}
							loading={loading}
							nearbyName={nearby?.name ?? null}
							orbit={!isometric}
						/>
					) : undefined
				}
				talkReady={Boolean(nearby)}
				tracker={
					empty ? undefined : <QuestTracker goal={goal} onGo={talkOrAnswer} />
				}
			/>
		);
	const sky = `linear-gradient(${theme.skyZenith}, ${theme.skyHorizon})`;

	return (
		<div
			className="relative flex size-full min-h-0"
			// The act layer's plates and buttons are game-kit pieces: with acts
			// the world carries the kit's tokens (old hosts are unchanged).
			data-game-accent={withActs ? "sky" : undefined}
			data-game-shell={withActs ? "" : undefined}
			data-testid="interface-world-3d"
			ref={rootRef}
		>
			{withActs ? <style>{GAME_KIT_CSS}</style> : null}
			<div
				className="@container relative isolate min-w-0 flex-1 overflow-hidden"
				ref={stageRef}
				style={{ background: sky }}
			>
				{/* The HUD comes first in the tab order: the tracker sits top left. */}
				{hud}
				{withActs ? (
					// Siblings of the map (never inside role="application"), so its
					// keys never see theirs.
					<>
						<h1 className="sr-only" ref={worldHeadingRef} tabIndex={-1}>
							World 3D
						</h1>
						{/* Above the HUD when revealed by focus, so its rows and rings
						    show. Without WebGL the list column carries both, visibly. */}
						{listOnly ? null : (
							<div className="pointer-events-none absolute inset-0 z-[450] [&_button]:pointer-events-auto [&_ul]:pointer-events-auto">
								{askQueue("reveal")}
								{probe?.supported ? agentList(true) : null}
							</div>
						)}
					</>
				) : null}
				<div
					aria-busy={loading}
					aria-hidden={listOnly ? true : undefined}
					aria-label={
						listOnly
							? undefined
							: "Agent world in 3D: a village with a house per agent. Use arrow keys or WASD to walk, E to talk to the agent in front of you, Escape to walk away."
					}
					className={cn(
						// The ring rides an overlay above the canvas, which would cover an
						// inset ring painted on this element.
						"relative size-full outline-none after:pointer-events-none after:absolute after:inset-0 after:z-10 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset",
						hovered && "cursor-pointer"
					)}
					onKeyDown={listOnly ? undefined : onMapKeyDown}
					ref={world.mapRef}
					role={listOnly ? undefined : "application"}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the scene is a keyboard-driven game surface (role="application").
					tabIndex={listOnly ? undefined : 0}
				>
					{probe?.supported ? (
						<Canvas
							camera={
								isometric
									? { far: 400, near: 0.1, position: [16, 18, 16], zoom: 60 }
									: { far: 1000, fov: 40, near: 0.1, position: [3, 6.2, 12] }
							}
							dpr={QUALITY[probe.quality].dpr}
							// Under a page the host opened over this interface, draw nothing.
							frameloop={covered ? "never" : "always"}
							gl={{ antialias: false }}
							key={params.camera}
							orthographic={isometric}
							shadows="soft"
						>
							<VillageScene
								acts={actView}
								camera={params.camera}
								nearId={nearby?.agentId ?? null}
								onHover={setHovered}
								onTalk={world.talkTo}
								player={world}
								quality={probe.quality}
								reducedMotion={reducedMotion}
								spread={spread}
								swatches={swatches}
								talkingId={talkingAgent?.id ?? null}
								theme={theme}
								urgent={urgent}
								viewShift={viewShift}
							/>
							<FirstFrames onReady={onDrawn} />
						</Canvas>
					) : null}
					{probe && !probe.supported && !withActs ? (
						<div className="flex size-full items-center justify-center bg-background p-6">
							<p className="max-w-sm text-center text-muted-foreground text-sm">
								World 3D needs WebGL, which is not available here. Switch to
								World 2D to see the same agents.
							</p>
						</div>
					) : null}
				</div>
				{probe === null || (probe.supported && !drawn) ? (
					<LoadingWorld minimapSize={minimapSize} sky={sky} />
				) : null}
				{listOnly ? (
					// Without WebGL the agents are a list: the text equivalent,
					// with nothing drawn over it.
					<div className="absolute inset-0 z-[400] flex flex-col gap-3 overflow-y-auto bg-background p-4">
						{summary}
						<BlindSpotCaption snapshot={snapshot} />
						<p className="text-muted-foreground text-sm">
							3D needs WebGL; switch to World 2D for the map.
						</p>
						{actButtons}
						{askQueue("sheet")}
						{agentList(false)}
						{/* No agents: the empty state lives in the list column, never
						    under it as a hidden Tab stop. */}
						{empty ? (
							<Village3dEmpty
								onStart={() => port.startThread({})}
								place={theme.place}
							/>
						) : null}
					</div>
				) : null}
				{talkingAgent ? (
					<World3dDialog
						activeThreadId={activeThreadId}
						acts={
							withActs && acts.get(talkingAgent.id)
								? {
										act: acts.get(talkingAgent.id) as NonNullable<
											ReturnType<typeof acts.get>
										>,
										agentName: talkingAgent.name,
										asks: (snapshot.asks ?? []).filter(
											(ask) => ask.agentId === talkingAgent.id
										),
										nowMs,
										onAsk,
										privacy,
									}
								: undefined
						}
						agent={talkingAgent}
						onClose={world.walkAway}
						port={port}
						threads={talkingThreads}
						threadView={threadView}
					/>
				) : null}
				{withActs ? <ActAnnouncer sentence={sentence} /> : null}
				{cards.element}
			</div>
		</div>
	);
}
