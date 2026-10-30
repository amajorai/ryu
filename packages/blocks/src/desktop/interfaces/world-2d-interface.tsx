import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceParamsByRenderer,
	isWorldTileFree,
	layoutWorld,
	resolveInterfaceParams,
	type WorldEntity,
	type WorldPoint,
} from "@ryuhq/protocol/interfaces";
import { useEffect, useMemo, useRef } from "react";
import { GAME_KIT_CSS } from "./game-palette.ts";
import { actTotals } from "./game3d-acts.ts";
import { useActCards } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";
import { useTalkingAgent, useWorldController } from "./use-world-controller.ts";
import { AgentActor, PlayerMarker } from "./world-2d-actors.tsx";
import { loadPixelFont } from "./world-2d-font.ts";
import { World2dActLayer } from "./world-2d-interface-act-layer.tsx";
import { actorAct } from "./world-2d-interface-actor-act.ts";
import { cameraOffset } from "./world-2d-interface-camera.ts";
import {
	facingToward,
	SV_VARIABLES,
	useDarkTheme,
	useLargestSize,
	useMeetActiveThreadAgent,
	useViewportSize,
	useVillagePort,
} from "./world-2d-interface-hooks.ts";
import { useWorld2dHotbar } from "./world-2d-interface-hotbar.ts";
import { World2dHud } from "./world-2d-interface-hud.tsx";
import { NO_ACTORS, NO_NOTICES } from "./world-2d-interface-keys.ts";
import { useWorld2dActPlaces } from "./world-2d-interface-places.ts";
import { useWorld2dScene } from "./world-2d-interface-scene.ts";
import { sceneFrame, villageProps } from "./world-2d-layout.ts";
import {
	needsYou,
	startPoint,
	talkSpot,
	type VillagerStatus,
	villagerStatuses,
} from "./world-2d-model.ts";
import { PIXEL_SCENES } from "./world-2d-palette.ts";
import {
	World2dActed,
	World2dActLines,
	World2dPanel,
	world2dActLine,
} from "./world-2d-panel.tsx";
import { SCALE, TILE } from "./world-2d-pixel.ts";
import type { ActorState } from "./world-2d-render.ts";
import { useWorldStage } from "./world-2d-stage.ts";
import { villageRoofColors, WORLD_PALETTES } from "./world-themes.ts";
import { layoutVillage } from "./world-village.ts";

export { actorAct } from "./world-2d-interface-actor-act.ts";

/**
 * Stardew Valley-style pixel village: every agent has a cottage and stands on
 * its doorstep, the player (straw hat) walks the streets and talks to them.
 * Villagers waiting on the user wear Stardew's "!" quest marker; busy ones
 * show the "..." emote. The world is real pixel art drawn at 16x16 art
 * tiles (2x2 per world tile) on a canvas and upscaled with nearest-neighbor
 * filtering; an accessible DOM layer sits on top. Under a dark app theme
 * the village is shown at night.
 */

export function World2dInterface({
	activeThreadId,
	loading,
	params,
	port: hostPort,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["world-2d"]>) {
	// The live settings (a bare `{}` resolves to the defaults).
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	const settings = resolveInterfaceParams("world-2d", params) as Required<
		InterfaceParamsByRenderer["world-2d"]
	>;
	const dark = useDarkTheme();
	useEffect(() => {
		loadPixelFont();
	}, []);
	const theme = dark && settings.theme === "meadow" ? "night" : settings.theme;
	const port = useVillagePort(
		hostPort,
		activeThreadId !== null || threadView !== null
	);
	const layout = useMemo(() => layoutWorld(snapshot), [snapshot]);
	const village = useMemo(() => layoutVillage(layout), [layout]);
	// The player starts among the cottages rather than on the empty square.
	const startLayout = useMemo(
		() => ({ ...layout, spawn: startPoint(layout, village) }),
		[layout, village]
	);
	const actsView = useActs(snapshot);
	const { acts, enabled: withActs, nowMs, privacy, unowned } = actsView;
	// With acts the villagers' marks (the "!" emote, the hotbar and map
	// badges) follow the acts: an ask or an answer waiting, a stopped run,
	// work; everything else is idle.
	const statuses = useMemo(() => {
		if (!withActs) {
			return villagerStatuses(snapshot.agents, snapshot.threads);
		}
		const out = new Map<string, VillagerStatus>();
		for (const agent of snapshot.agents) {
			const act = acts.get(agent.id);
			let status: VillagerStatus = "idle";
			if (act?.act === "asking" || act?.act === "delivering") {
				status = "your-turn";
			} else if (
				act?.act === "blocked" &&
				act.blockers[0]?.kind !== "interrupted"
			) {
				status = "attention";
			} else if (act?.act === "working") {
				status = "working";
			}
			out.set(agent.id, status);
		}
		return out;
	}, [acts, snapshot, withActs]);
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const worldHeadingRef = useRef<HTMLHeadingElement>(null);
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: worldHeadingRef,
		nowMs,
		port: hostPort,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	const totals = actTotals(snapshot, acts);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const palette = WORLD_PALETTES[theme];
	const pixel = PIXEL_SCENES[theme];
	const indoor = pixel.indoor;
	const furniture = useMemo(
		() => villageProps(layout, village, indoor),
		[indoor, layout, village]
	);
	const roofs = useMemo(
		() => villageRoofColors(village, palette),
		[palette, village]
	);
	// Furniture stands on free grass beside the streets, so blocking it never
	// cuts an agent off from the plaza.
	const obstacles = useMemo(
		() => new Set([...village.blocked, ...furniture.blocking]),
		[furniture, village]
	);
	const viewport = useViewportSize();
	const reducedMotion = useReducedMotion();
	// The forest margin only ever grows with the viewport, so opening the
	// talk panel (a narrower view) never re-bakes the ground.
	const frameViewport = useLargestSize(viewport.size);
	// A narrow stage queues down your column. Held while you talk, so the
	// talk panel narrowing the view never swings the queue round.
	const liveNarrow = viewport.size.width < 640;
	// Held while you talk (the last render's talk state), and read straight
	// from the measured size otherwise, so the first measured frame already
	// places the queue for this stage (no walk from the fallback's places).
	const talkOpenRef = useRef(false);
	const heldNarrow = useRef(liveNarrow);
	if (!talkOpenRef.current) {
		heldNarrow.current = liveNarrow;
	}
	const narrowStage = heldNarrow.current;
	// With acts: each villager's tile for its act (an asker queues on your
	// doorstep, a deliverer by the chest), and the chest itself.
	// Where you stood at the last render: act places keep off it.
	const playerTile = useRef<WorldPoint>(startLayout.spawn);
	const { height: stageHeight, width: stageWidth } = viewport.size;
	const { actLayout, actPlaces } = useWorld2dActPlaces({
		acts,
		frameViewport,
		indoor,
		layout,
		narrowStage,
		obstacles,
		playerTile,
		reducedMotion,
		snapshot,
		stageHeight,
		stageWidth,
		startLayout,
		unowned,
		withActs,
	});
	const world = useWorldController(actLayout, port, obstacles);
	playerTile.current = world.player;
	talkOpenRef.current =
		world.talkingTo !== null || activeThreadId !== null || threadView !== null;
	const view = useMemo(
		() => ({
			height: Math.ceil(viewport.size.height / SCALE),
			width: Math.ceil(viewport.size.width / SCALE),
		}),
		[viewport.size]
	);
	const frame = useMemo(
		() => sceneFrame(layout, frameViewport, TILE),
		[layout, frameViewport]
	);
	const frameKey = `${frame.margin.x},${frame.margin.y}`;
	const { talkingAgent, talkingThreads } = useTalkingAgent(
		snapshot,
		world.talkingTo,
		activeThreadId
	);
	// While talking the player is drawn beside the villager (see talkSpot).
	const spot = useMemo(
		() =>
			talkSpot(
				actLayout,
				world.talkingTo,
				world.player,
				(point) =>
					isWorldTileFree(actLayout, point) &&
					!village.blocked.has(`${point.x},${point.y}`)
			),
		[actLayout, village, world.player, world.talkingTo]
	);
	const shownPlayer = spot?.point ?? world.player;
	const shownFacing = spot?.facing ?? world.facing;
	const camera = cameraOffset(layout, frame, view, shownPlayer, {
		indoor,
		talkingRows: talkingAgent ? village.plaza.top : null,
	});
	useMeetActiveThreadAgent(snapshot, activeThreadId, world);

	const title = indoor ? "Ryu HQ" : "Ryu Village";
	const staticScene = useWorld2dScene({
		frame,
		furniture,
		layout,
		palette,
		pixel,
		roofs,
		title,
		village,
	});

	const nearbyId = world.nearby?.agentId ?? null;
	const talkingId = talkingAgent?.id ?? null;
	// With acts, what each villager says in the talk box.
	const actLines = useMemo(() => {
		if (!withActs) {
			return null;
		}
		const lines = new Map<string, string>();
		for (const act of acts.values()) {
			const line = world2dActLine(act, snapshot.threads, privacy);
			if (line) {
				lines.set(act.agentId, line);
			}
		}
		return lines;
	}, [acts, privacy, snapshot.threads, withActs]);
	// Each villager's act sprites, keyed by what they draw (a wait plaque
	// changes by the minute, not every second).
	const rawSprites = useMemo(
		() =>
			new Map(
				withActs
					? [...acts].map(([agentId, act]) => [
							agentId,
							actorAct(act, nowMs, settings.overlayDensity),
						])
					: []
			),
		[acts, nowMs, settings.overlayDensity, withActs]
	);
	const spritesKey = JSON.stringify([...rawSprites]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the sprites' content.
	const actSprites = useMemo(() => rawSprites, [spritesKey]);
	const actors: ActorState[] = useMemo(
		() =>
			layout.entities.map((entity, index) => {
				const talking = entity.agentId === talkingId;
				const near = entity.agentId === nearbyId || talking;
				const status = statuses.get(entity.agentId) ?? "idle";
				const tile = actPlaces?.tiles.get(entity.agentId);
				const placed = tile ? { ...entity, ...tile } : entity;
				return {
					act: actSprites.get(entity.agentId),
					emote: settings.workBubbles,
					alert:
						status === "attention" || status === "your-turn" ? status : null,
					entity: placed,
					facing: facingToward(placed, shownPlayer, near),
					lookIndex: index,
					near,
					talking,
					working: entity.status === "working",
				};
			}),
		[
			actPlaces,
			actSprites,
			layout,
			nearbyId,
			settings.workBubbles,
			shownPlayer,
			statuses,
			talkingId,
		]
	);

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const playerRef = useRef<HTMLDivElement>(null);
	const stageRefs = useMemo(
		() => ({ canvas: canvasRef, overlay: overlayRef, player: playerRef }),
		[]
	);
	useWorldStage(
		{
			// Nobody is drawn before the stage is measured: a villager first seen
			// at the fallback size's places would then walk to this stage's.
			actors: viewport.measured ? actors : NO_ACTORS,
			camera,
			chest: actPlaces?.chest ?? null,
			notices: actPlaces?.notices ?? NO_NOTICES,
			frameKey,
			pixel,
			player: shownPlayer,
			playerFacing: shownFacing,
			reducedMotion,
			scene: staticScene,
			view,
		},
		stageRefs
	);

	const hotbarView = useWorld2dHotbar({
		acts,
		cards,
		hostPort,
		layout,
		nearbyId,
		nowMs,
		privacy,
		settings,
		statuses,
		talkingId,
		viewport,
		withActs,
		world,
	});
	const { askerAsk, onKeyDown, talkTo } = hotbarView;
	// Where a villager's talk button stands: on its act's tile.
	const placedEntity = (entity: WorldEntity): WorldEntity => {
		const tile = actPlaces?.tiles.get(entity.agentId);
		return tile ? { ...entity, ...tile } : entity;
	};

	return (
		<div
			// isolate: the world's own layers (the HUD, the act plates) stay
			// under the cards and sheets the act layer opens over it.
			className={cn("relative flex size-full min-h-0", withActs && "isolate")}
			// The act layer's plates and buttons are game-kit pieces: with acts
			// the world carries the kit's tokens (old hosts are unchanged).
			data-game-accent={withActs ? "leaf" : undefined}
			data-game-shell={withActs ? "" : undefined}
			data-testid="interface-world-2d"
			style={SV_VARIABLES}
		>
			{withActs ? <style>{GAME_KIT_CSS}</style> : null}
			<div
				aria-busy={loading}
				aria-label={
					withActs
						? "Agent world. Use arrow keys or WASD to walk, E to talk or answer."
						: "Agent world. Use arrow keys or WASD to walk, E to talk."
				}
				className="relative min-w-0 flex-1 overflow-hidden outline-none focus-visible:shadow-[inset_0_0_0_3px_var(--sv-focus)]"
				onKeyDown={onKeyDown}
				ref={world.mapRef}
				role="application"
				style={{ background: pixel.backdrop }}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the map is a keyboard-driven game surface (role="application").
				tabIndex={0}
			>
				<div className="absolute inset-0" ref={viewport.ref}>
					<div aria-hidden="true" className="absolute top-0 left-0">
						<canvas
							className="block [image-rendering:pixelated]"
							height={view.height}
							ref={canvasRef}
							style={{ height: view.height * SCALE, width: view.width * SCALE }}
							width={view.width}
						/>
					</div>
					<div className="absolute top-0 left-0" ref={overlayRef}>
						{layout.entities.map((entity) => (
							<AgentActor
								asking={askerAsk(entity.agentId) !== null}
								emote={
									(withActs
										? statuses.get(entity.agentId) === "working"
										: entity.status === "working") ||
									needsYou(statuses.get(entity.agentId) ?? "idle")
								}
								entity={placedEntity(entity)}
								indoor={indoor}
								key={entity.agentId}
								margin={frame.margin}
								near={nearbyId === entity.agentId}
								onTalk={talkTo}
								talking={talkingId === entity.agentId}
							/>
						))}
						<PlayerMarker elementRef={playerRef} />
					</div>
				</div>
				<World2dHud
					furniture={furniture}
					hotbarView={hotbarView}
					indoor={indoor}
					layout={layout}
					loading={loading}
					nearbyId={nearbyId}
					pixel={pixel}
					port={port}
					roofs={roofs}
					shownPlayer={shownPlayer}
					statuses={statuses}
					talkingAgent={talkingAgent}
					talkingId={talkingId}
					title={title}
					totals={totals}
					viewport={viewport}
					village={village}
					withActs={withActs}
					world={world}
				/>
			</div>
			{withActs ? (
				<World2dActLayer
					acts={acts}
					clock={clock}
					hostPort={hostPort}
					nowMs={nowMs}
					onAsk={onAsk}
					onBlocker={onBlocker}
					queueOpener={queueOpener}
					sentence={sentence}
					snapshot={snapshot}
					talkingAgent={talkingAgent}
					totals={totals}
					unowned={unowned}
					viewport={viewport}
					worldHeadingRef={worldHeadingRef}
				/>
			) : null}
			{cards.element}
			{talkingAgent ? (
				<World2dActed.Provider value={withActs}>
					<World2dActLines.Provider value={actLines}>
						<World2dPanel
							activeThreadId={activeThreadId}
							agent={talkingAgent}
							lookIndex={layout.entities.findIndex(
								(entity) => entity.agentId === talkingAgent.id
							)}
							onClose={world.walkAway}
							port={port}
							status={statuses.get(talkingAgent.id) ?? "idle"}
							threads={talkingThreads}
							threadView={threadView}
						/>
					</World2dActLines.Provider>
				</World2dActed.Provider>
			) : null}
		</div>
	);
}
