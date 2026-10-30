import type { World2dParams } from "@ryuhq/protocol/interfaces";
import {
	isWorldTileFree,
	type WorldLayout,
	type WorldPoint,
} from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import { stageAgents, youSpotSlots } from "./game3d-acts.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import type { useActs } from "./use-acts.ts";
import { world2dActorTile, world2dYouSpot } from "./world-2d-acts.ts";
import {
	cameraOffset,
	type ViewportSize,
} from "./world-2d-interface-camera.ts";
import {
	HEAD_ROOM,
	HOTBAR_ROOM,
	HUD_NARROW_BOTTOM,
	HUD_WIDE_BOTTOM,
	HUD_WIDE_WIDTH,
} from "./world-2d-interface-keys.ts";
import { sceneFrame } from "./world-2d-layout.ts";
import { PX, SCALE, TILE } from "./world-2d-pixel.ts";

type ActsView = ReturnType<typeof useActs>;

/**
 * With acts: each villager's tile for its act (an asker queues on your
 * doorstep, a deliverer by the chest), the chest itself, and the village as
 * you walk it.
 */
export function useWorld2dActPlaces({
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
}: {
	acts: ActsView["acts"];
	frameViewport: ViewportSize;
	indoor: boolean;
	layout: WorldLayout;
	narrowStage: boolean;
	obstacles: ReadonlySet<string>;
	playerTile: { current: WorldPoint };
	reducedMotion: boolean;
	snapshot: InterfaceRendererProps<World2dParams>["snapshot"];
	stageHeight: number;
	stageWidth: number;
	startLayout: WorldLayout;
	unowned: ActsView["unowned"];
	withActs: boolean;
}) {
	const rawPlaces = useMemo(() => {
		if (!withActs) {
			return null;
		}
		const height = stageHeight;
		const width = stageWidth;
		// Never the tile you stand on (the controller would snap you away),
		// and never where the HUD (the act column, or the top band on a phone)
		// would cover the villager and its "!", seen from your doorstep.
		const player = playerTile.current;
		// Seen as the camera frames your doorstep (it stops at the village's
		// edges, so the doorstep need not be mid-view).
		const startFrame = sceneFrame(layout, frameViewport, TILE);
		const camera = cameraOffset(
			layout,
			startFrame,
			{ height: Math.ceil(height / SCALE), width: Math.ceil(width / SCALE) },
			startLayout.spawn,
			{ indoor, talkingRows: null }
		);
		const underHud = (point: WorldPoint) => {
			if (width <= 0 || height <= 0) {
				return false;
			}
			const x = (camera.x + (point.x + startFrame.margin.x + 0.5) * PX) * SCALE;
			const feet =
				(camera.y + (point.y + startFrame.margin.y + 1) * PX) * SCALE;
			const top = feet - TILE / 2 - HEAD_ROOM;
			// The hotbar along the bottom covers feet as the HUD covers heads.
			if (feet > height - HOTBAR_ROOM) {
				return true;
			}
			return narrowStage
				? top < HUD_NARROW_BOTTOM
				: top < HUD_WIDE_BOTTOM && x > width - HUD_WIDE_WIDTH - TILE / 2;
		};
		const free = (point: WorldPoint) =>
			isWorldTileFree(layout, point) &&
			!obstacles.has(`${point.x},${point.y}`) &&
			!(point.x === player.x && point.y === player.y) &&
			!underHud(point);
		const placed = new Set(layout.entities.map((entity) => entity.agentId));
		const { onStage } = stageAgents(
			new Map([...acts].filter(([agentId]) => placed.has(agentId))),
			Number.POSITIVE_INFINITY
		);
		const { slots } = youSpotSlots(
			acts,
			unowned,
			onStage.map((act) => act.agentId)
		);
		// Your doorstep: the tile you start on. Only the slots in use get a
		// place, villagers first, so each fits in a thin view.
		const spot = world2dYouSpot(startLayout, free, narrowStage, {
			posts: slots
				.filter((slot) => slot.carrier === "notice")
				.map((slot) => slot.point),
			villagers: slots
				.filter((slot) => slot.carrier === "villager")
				.map((slot) => slot.point),
		});
		const delivering = onStage
			.filter((act) => act.act === "delivering")
			.map((act) => act.agentId);
		const tiles = new Map<string, WorldPoint>();
		for (const entity of layout.entities) {
			const act = acts.get(entity.agentId);
			if (act) {
				tiles.set(
					entity.agentId,
					world2dActorTile(
						act,
						{ x: entity.x, y: entity.y },
						spot,
						slots,
						reducedMotion,
						delivering.indexOf(entity.agentId)
					)
				);
			}
		}
		const replies = (snapshot.asks ?? []).some((ask) => ask.kind === "reply");
		return {
			chest: delivering.length > 0 || replies ? spot.tray : null,
			// An ask nobody carries (unowned, or parked by a busy agent) waits
			// on its queue tile as a notice post.
			notices: slots.flatMap((slot) => {
				const tile = slot.carrier === "notice" ? spot.slots[slot.point] : null;
				return tile ? [tile] : [];
			}),
			tiles,
		};
	}, [
		acts,
		frameViewport,
		indoor,
		layout,
		obstacles,
		narrowStage,
		reducedMotion,
		snapshot.asks,
		stageHeight,
		stageWidth,
		startLayout,
		unowned,
		withActs,
	]);
	// Keyed by where things stand, not by the acts map (a new one every
	// second): the village rebuilds, walks and redraws only when a place
	// changes.
	const placesKey = rawPlaces
		? JSON.stringify([rawPlaces.chest, rawPlaces.notices, [...rawPlaces.tiles]])
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the places' content.
	const actPlaces = useMemo(() => rawPlaces, [placesKey]);
	// The village as you walk it: villagers stand on their acts' tiles, so
	// you bump into, stand by and talk to them where they are.
	const actLayout = useMemo(() => {
		const tiles = actPlaces?.tiles;
		if (!tiles) {
			return startLayout;
		}
		return {
			...startLayout,
			entities: startLayout.entities.map((entity) => ({
				...entity,
				...tiles.get(entity.agentId),
			})),
		};
	}, [actPlaces, startLayout]);
	return { actLayout, actPlaces };
}
