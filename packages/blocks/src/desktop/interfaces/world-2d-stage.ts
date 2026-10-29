import type { WorldDirection, WorldPoint } from "@ryuhq/protocol/interfaces";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { PixelScene } from "./world-2d-palette.ts";
import { CHARACTER, PX, SCALE } from "./world-2d-pixel.ts";
import {
	type ActorState,
	CHARACTER_RAISE,
	drawFrame,
	type NightLayers,
	type StaticScene,
} from "./world-2d-render.ts";

/**
 * The 2D village's render loop. Canvas pixels are art pixels; the canvas is
 * upscaled by an integer factor with nearest-neighbor filtering. The camera
 * and the player glide between tiles (eased, snapped to whole art pixels so
 * nothing ever lands between pixels), the player's walk cycle advances with
 * the distance covered, and idle loops tick at 8 fps. Under
 * `prefers-reduced-motion` everything jumps and the idle loops hold still.
 * The DOM overlay (buttons, labels) is moved in the same frame as the
 * canvas so the two never drift apart.
 */

const GLIDE_MS = 210;
const TICK_MS = 125;
/** A villager walks a tile in this long (the act layer's trips). */
const WALK_MS = 240;

interface Glide {
	from: WorldPoint;
	start: number;
	to: WorldPoint;
}

/** The host's own "animations off" setting, or the system's reduce-motion preference. */
function prefersReducedMotion(host: boolean): boolean {
	return (
		host ||
		(typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches)
	);
}

function sample(
	glide: Glide,
	now: number
): { done: boolean; point: WorldPoint } {
	const t = Math.min(1, (now - glide.start) / GLIDE_MS);
	const eased = 1 - (1 - t) ** 3;
	return {
		done: t >= 1,
		point: {
			x: glide.from.x + (glide.to.x - glide.from.x) * eased,
			y: glide.from.y + (glide.to.y - glide.from.y) * eased,
		},
	};
}

function retarget(
	glide: Glide | null,
	to: WorldPoint,
	now: number,
	jump: boolean
): Glide {
	if (!glide || jump) {
		return { from: to, start: now - GLIDE_MS, to };
	}
	if (glide.to.x === to.x && glide.to.y === to.y) {
		return glide;
	}
	return { from: sample(glide, now).point, start: now, to };
}

/** A villager's walk to its tile: eased over the distance. */
interface Walk extends Glide {
	ms: number;
}

function sampleWalk(
	walk: Walk,
	now: number
): { done: boolean; point: WorldPoint } {
	const t = Math.min(1, (now - walk.start) / walk.ms);
	const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
	return {
		done: t >= 1,
		point: {
			x: walk.from.x + (walk.to.x - walk.from.x) * eased,
			y: walk.from.y + (walk.to.y - walk.from.y) * eased,
		},
	};
}

export interface StageInput {
	actors: readonly ActorState[];
	/** Camera offset in art pixels. */
	camera: WorldPoint;
	/** The act layer's chest of answers, on its tile. */
	chest?: WorldPoint | null;
	/** Changes when the scene is re-framed; the camera then jumps. */
	frameKey: string;
	/** Notice posts: asks nobody carries, on their queue tiles. */
	notices?: readonly WorldPoint[];
	pixel: PixelScene;
	player: WorldPoint;
	playerFacing: WorldDirection;
	/** Whether motion is reduced for the host (its "animations off" setting counts). */
	reducedMotion?: boolean;
	scene: StaticScene | null;
	/** Viewport size in art pixels. */
	view: { height: number; width: number };
}

export function useWorldStage(
	input: StageInput,
	refs: {
		canvas: RefObject<HTMLCanvasElement | null>;
		overlay: RefObject<HTMLDivElement | null>;
		player: RefObject<HTMLDivElement | null>;
	}
): void {
	const live = useRef(input);
	live.current = input;
	const anim = useRef<{
		camera: Glide | null;
		dirty: boolean;
		frameKey: string;
		lastPlayer: WorldPoint | null;
		lastTick: number;
		layers: NightLayers | null;
		player: Glide | null;
		reduced: boolean;
		walked: number;
		/** Each villager's walk to its tile, by agent. */
		walks: Map<string, Walk>;
	}>({
		camera: null,
		dirty: true,
		frameKey: "",
		lastPlayer: null,
		lastTick: -1,
		layers: null,
		player: null,
		reduced: false,
		walked: 0,
		walks: new Map(),
	});

	const playerX = (input.player.x + (input.scene?.frame.margin.x ?? 0)) * PX;
	const playerY = (input.player.y + (input.scene?.frame.margin.y ?? 0)) * PX;
	useLayoutEffect(() => {
		const state = anim.current;
		const now = performance.now();
		const reframed = state.frameKey !== input.frameKey;
		state.frameKey = input.frameKey;
		state.reduced = prefersReducedMotion(input.reducedMotion === true);
		state.camera = retarget(
			state.camera,
			input.camera,
			now,
			reframed || state.reduced
		);
		state.player = retarget(
			state.player,
			{ x: playerX, y: playerY },
			now,
			reframed || state.reduced
		);
		state.dirty = true;
	}, [input.camera, input.frameKey, input.reducedMotion, playerX, playerY]);

	// A villager whose tile changed walks there (jumps under reduced motion).
	useLayoutEffect(() => {
		const state = anim.current;
		const now = performance.now();
		const reduced = prefersReducedMotion(live.current.reducedMotion === true);
		// A villager who left forgets its walk; back, it starts at home.
		const present = new Set(input.actors.map((actor) => actor.entity.agentId));
		for (const agentId of state.walks.keys()) {
			if (!present.has(agentId)) {
				state.walks.delete(agentId);
			}
		}
		for (const actor of input.actors) {
			const to = { x: actor.entity.x, y: actor.entity.y };
			const walk = state.walks.get(actor.entity.agentId);
			if (walk && walk.to.x === to.x && walk.to.y === to.y) {
				continue;
			}
			const from = walk && !reduced ? sampleWalk(walk, now).point : to;
			const tiles = Math.hypot(to.x - from.x, to.y - from.y);
			state.walks.set(actor.entity.agentId, {
				from,
				ms: Math.max(1, tiles * WALK_MS),
				start: now,
				to,
			});
		}
		state.dirty = true;
	}, [input.actors]);

	// Any other prop change (statuses, facing, scene) just needs a redraw.
	useEffect(() => {
		anim.current.dirty = true;
	});

	useEffect(() => {
		const canvas = refs.canvas.current;
		if (!canvas) {
			return;
		}
		canvas.width = Math.max(1, input.view.width);
		canvas.height = Math.max(1, input.view.height);
		const layer = () => {
			const offscreen = document.createElement("canvas");
			offscreen.width = canvas.width;
			offscreen.height = canvas.height;
			return offscreen.getContext("2d");
		};
		const light = layer();
		const fx = layer();
		anim.current.layers = light && fx ? { fx, light } : null;
		anim.current.dirty = true;
	}, [input.view.height, input.view.width, refs.canvas]);

	useEffect(() => {
		if (typeof requestAnimationFrame !== "function") {
			return;
		}
		let frame = 0;
		const started = performance.now();
		const step = (now: number) => {
			frame = requestAnimationFrame(step);
			const state = anim.current;
			const current = live.current;
			const canvas = refs.canvas.current;
			const context = canvas?.getContext("2d");
			if (!(current.scene && context && state.camera && state.player)) {
				return;
			}
			// A page the host opened over the interface covers it: draw nothing,
			// and once it lifts redraw once.
			if (
				isInterfaceCovered(
					canvas?.closest("[data-testid='interface-world-2d']") ??
						canvas ??
						null
				)
			) {
				state.dirty = true;
				return;
			}
			const cam = sample(state.camera, now);
			const pos = sample(state.player, now);
			let villagersWalk = false;
			const actors = current.actors.map((actor) => {
				const walk = state.walks.get(actor.entity.agentId);
				if (!walk) {
					return actor;
				}
				const at = sampleWalk(walk, now);
				villagersWalk ||= !at.done;
				return at.done
					? actor
					: { ...actor, entity: { ...actor.entity, ...at.point } };
			});
			const moving = !(cam.done && pos.done) || villagersWalk;
			const tick = state.reduced ? 0 : Math.floor((now - started) / TICK_MS);
			if (!(moving || state.dirty || tick !== state.lastTick)) {
				return;
			}
			state.dirty = false;
			state.lastTick = tick;
			const px = Math.round(pos.point.x);
			const py = Math.round(pos.point.y);
			if (state.lastPlayer) {
				state.walked +=
					Math.abs(px - state.lastPlayer.x) + Math.abs(py - state.lastPlayer.y);
			}
			state.lastPlayer = { x: px, y: py };
			const walking = !pos.done;
			const walkFrame = walking ? Math.floor(state.walked / 8) % 4 : 0;
			if (!walking) {
				state.walked = 0;
			}
			const camX = Math.round(cam.point.x);
			const camY = Math.round(cam.point.y);
			const overlay = refs.overlay.current;
			if (overlay) {
				overlay.style.transform = `translate3d(${camX * SCALE}px, ${camY * SCALE}px, 0)`;
			}
			const playerElement = refs.player.current;
			if (playerElement) {
				const left = px + PX / 2 - CHARACTER.w / 2;
				const top = py + PX - CHARACTER_RAISE - CHARACTER.h;
				playerElement.style.transform = `translate3d(${left * SCALE}px, ${top * SCALE}px, 0)`;
			}
			drawFrame(context, state.layers, current.scene, current.pixel, {
				actors,
				chest: current.chest ?? null,
				notices: current.notices ?? [],
				camX,
				camY,
				motion: !state.reduced,
				player: { facing: current.playerFacing, walkFrame, x: px, y: py },
				time: now - started,
			});
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [refs]);
}
