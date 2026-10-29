/* eslint-disable react/no-unknown-property */
import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { World3dParams } from "@ryuhq/protocol/interfaces";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import type { Group, Vector3 } from "three";
import type { Vec3 } from "./game3d-palette.ts";
import { CURVE_UNIFORMS, curveDrop, FADE_UNIFORMS } from "./game3d-toon.ts";
import {
	FOCUS_AIM_HEIGHT,
	FOCUS_DISTANCE,
	FOCUS_EYE_LIFT,
	FOCUS_LOOK_HEIGHT,
	type FocusSide,
	focusDirection,
	focusRight,
} from "./world-3d-focus.ts";

/** Keeps the orbit camera above the ground and out of the sea. */
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.25;
const MIN_POLAR_ANGLE = 0.3;
const MIN_ORBIT_DISTANCE = 5;
/**
 * Island-life follow cam: behind and above the player, pitched down about
 * 28 degrees and looking about three tiles ahead, so the player sits a
 * little below the middle of the frame (about 63% down), the ground rolls away over a visibly curved horizon,
 * and the top quarter of the frame is sky.
 */
const FOLLOW_OFFSET: Vec3 = [0.55, 6.5, 12.1];
const ISO_OFFSET: Vec3 = [16, 18, 16];
const LOOK_AHEAD = -3.4;
/**
 * Near the south shore the look-at point stops this far north of it, so
 * the bottom of the frame is lawn and a thin strip of beach rather than a
 * band of sand (the frame's bottom edge sees about 6 tiles past the point).
 */
const SHORE_CLEARANCE = 6.1;
/**
 * The rolling-log bend: how fast the ground drops with distance from the
 * point the camera looks at. Gentle in isometric view, where the whole
 * village should stay readable.
 */
const ORBIT_CURVE = 0.026;
const ISO_CURVE = 0.0025;
/** An office floor barely bends, so its back wall stays in view. */
const INDOOR_CURVE = 0.006;
/**
 * Isometric zoom, in pixels per tile: fitted to the village when it fits at
 * least `ISO_MIN_ZOOM`, otherwise the camera follows the player that close.
 */
const ISO_MIN_ZOOM = 32;
const ISO_MAX_ZOOM = 90;
/** Screen room kept clear for the HUD: minimap, tracker and prompt. */
const ISO_PAD_X = 32;
const ISO_PAD_Y = 150;
const LOOK_HEIGHT = 0.6;
const FOLLOW_SPEED = 4;
/** How fast the eye glides into (and out of) a conversation shot. */
const FRAME_SPEED = 5;
/** Half the height the shot must fit: characters and their name plates. */
const FOCUS_HALF_HEIGHT = 1.9;
/** Room beside the pair for bodies and name plates. */
const FOCUS_MARGIN = 0.75;
/** How fast the view slides aside when a panel opens or closes. */
const SHIFT_SPEED = 6;
/** Frames slower than this (seconds) cut to the new framing instead. */
const SNAP_DELTA = 0.25;

/** Canvas pixels a panel covers: from the right, and from the bottom. */
export interface ViewShift {
	x: number;
	y: number;
}

/** Radius of the see-through circle around the player, in tiles. */
const FADE_RADIUS = 1.5;
/** In a conversation shot: the circle around the pair, in tiles. */
const FOCUS_FADE_RADIUS = 2.4;
/**
 * In a conversation shot: scenery more than this much nearer the lens than
 * the pair fades out (tiles of view depth).
 */
const FOCUS_NEAR_CLEARANCE = 1.6;

/**
 * Keeps the screen-door fade centered on the player: trees and cottages in
 * front of the player, inside a circle around them on screen, are drawn
 * see-through so the player never disappears behind scenery.
 */
export function OccluderFade({
	focus = null,
	playerRef,
}: {
	/** While a conversation is framed, the fade follows the pair instead. */
	focus?: CameraFocus | null;
	playerRef: RefObject<Group | null>;
}) {
	const camera = useThree((state) => state.camera);
	const point = useMemo(() => camera.position.clone(), [camera]);
	useFrame(({ gl, size }) => {
		const player = playerRef.current;
		const { ryuFadeCenter, ryuFadeDepth, ryuFadeNear, ryuFadeRadius } =
			FADE_UNIFORMS;
		if (!player) {
			ryuFadeRadius.value = 0;
			ryuFadeNear.value = 0;
			return;
		}
		const x = focus
			? (focus.agent[0] + focus.player[0]) / 2
			: player.position.x;
		const z = focus
			? (focus.agent[2] + focus.player[2]) / 2
			: player.position.z;
		const y = (focus ? FOCUS_LOOK_HEIGHT : 0.6) - curveDrop(x, z);
		point.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
		const depth = -point.z;
		if (depth <= 0.1) {
			ryuFadeRadius.value = 0;
			ryuFadeNear.value = 0;
			return;
		}
		point.set(x, y, z).project(camera);
		const dpr = gl.getPixelRatio();
		ryuFadeCenter.value = {
			x: (point.x * 0.5 + 0.5) * size.width * dpr,
			y: (point.y * 0.5 + 0.5) * size.height * dpr,
		};
		const pixelsPerTile =
			"fov" in camera
				? (size.height * dpr) /
					2 /
					Math.tan((((camera.fov as number) / 2) * Math.PI) / 180) /
					depth
				: ((camera as { zoom?: number }).zoom ?? 40) * dpr;
		ryuFadeRadius.value =
			(focus ? FOCUS_FADE_RADIUS : FADE_RADIUS) * pixelsPerTile;
		ryuFadeDepth.value = depth;
		// Foreground scenery (a tree beside the lens) would fill the shot:
		// everything a little nearer than the pair melts away.
		ryuFadeNear.value = focus ? Math.max(0, depth - FOCUS_NEAR_CLEARANCE) : 0;
	}, -0.4);
	return null;
}

/** The slice of drei's orbit controls the follow camera drives. */
interface OrbitPivot {
	addEventListener: (type: "start", listener: () => void) => void;
	removeEventListener: (type: "start", listener: () => void) => void;
	target: Vector3;
	update: () => unknown;
}

/** The player and the agent they are talking to, framed together. */
export interface CameraFocus {
	agent: Vec3;
	player: Vec3;
	/** Film from the right (1), the left (-1) or straight in front (0). */
	side: FocusSide;
}

/**
 * How the camera is moving: following the player, gliding to frame a
 * conversation, or gliding back behind the player afterwards.
 */
type Framing = "focus" | "follow" | "return";

/**
 * Ground points (x, z) the isometric view keeps in frame, and the margin
 * around them in tiles.
 */
export interface IsoFrame {
	margin: number;
	points: readonly (readonly [number, number])[];
}

/** Height of the tallest scenery the isometric fit keeps in frame. */
const ISO_FIT_HEIGHT = 2.4;

/**
 * Orthographic zoom (pixels per tile) and look-at point that fit `frame`
 * under the fixed isometric angle, leaving room for the HUD. `center` is
 * `null` when the village only fits below `ISO_MIN_ZOOM`.
 */
export function fitIsometric(
	frame: IsoFrame,
	width: number,
	height: number
): { center: Vec3 | null; zoom: number } {
	const length = Math.hypot(...ISO_OFFSET);
	// Toward the scene, screen-right and screen-up for the fixed iso angle.
	const forward: Vec3 = [
		-ISO_OFFSET[0] / length,
		-ISO_OFFSET[1] / length,
		-ISO_OFFSET[2] / length,
	];
	const flat = Math.hypot(forward[0], forward[2]);
	const right: Vec3 = [-forward[2] / flat, 0, forward[0] / flat];
	const up: Vec3 = [
		right[1] * forward[2] - right[2] * forward[1],
		right[2] * forward[0] - right[0] * forward[2],
		right[0] * forward[1] - right[1] * forward[0],
	];
	let [minRight, maxRight, minUp, maxUp] = [
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	];
	for (const [x, z] of frame.points) {
		for (const y of [0, ISO_FIT_HEIGHT]) {
			const alongRight = x * right[0] + z * right[2];
			const alongUp = x * up[0] + y * up[1] + z * up[2];
			minRight = Math.min(minRight, alongRight);
			maxRight = Math.max(maxRight, alongRight);
			minUp = Math.min(minUp, alongUp);
			maxUp = Math.max(maxUp, alongUp);
		}
	}
	if (!Number.isFinite(minRight)) {
		return { center: null, zoom: ISO_MIN_ZOOM };
	}
	const zoom = Math.min(
		ISO_MAX_ZOOM,
		(width - ISO_PAD_X * 2) / (maxRight - minRight + frame.margin * 2),
		(height - ISO_PAD_Y) / (maxUp - minUp + frame.margin * 2)
	);
	if (zoom < ISO_MIN_ZOOM) {
		return { center: null, zoom: ISO_MIN_ZOOM };
	}
	// Screen-space center back to a point on the view axis through it.
	const midRight = (minRight + maxRight) / 2;
	const midUp = (minUp + maxUp) / 2;
	return {
		center: [
			right[0] * midRight + up[0] * midUp,
			up[1] * midUp,
			right[2] * midRight + up[2] * midUp,
		],
		zoom,
	};
}

/**
 * Where the camera looks when not framing a conversation: the fitted village
 * center in isometric view, otherwise a few tiles ahead of the player (but
 * never so far south that the frame fills with beach).
 */
function restingTarget(
	isoCenter: Vec3 | null,
	player: Vector3,
	out: Vector3,
	shoreZ: number | null
): Vector3 {
	if (isoCenter) {
		return out.set(...isoCenter);
	}
	const ahead = player.z + LOOK_AHEAD;
	const z = shoreZ === null ? ahead : Math.min(ahead, shoreZ - SHORE_CLEARANCE);
	return out.set(player.x, LOOK_HEIGHT, z);
}

/** Canvas size a panel leaves uncovered (the shift is capped). */
export function uncoveredSize(
	width: number,
	height: number,
	shift: ViewShift
): { height: number; width: number } {
	return {
		height: height - Math.min(shift.y, height * 0.3) * 2,
		width: width - Math.min(shift.x, width * 0.45) * 2,
	};
}

/**
 * Distance that keeps both characters (and their name plates) inside the
 * part of the canvas a panel leaves visible.
 */
export function focusDistance(
	focus: CameraFocus,
	fov: number,
	visibleWidth: number,
	visibleHeight: number
): number {
	const tanHalf = Math.tan(((fov / 2) * Math.PI) / 180);
	const aspect = Math.max(0.3, visibleWidth / Math.max(1, visibleHeight));
	// Seen from the side, the pair spreads across the screen.
	const right = focusRight(focus.side);
	const across =
		Math.abs(
			(focus.player[0] - focus.agent[0]) * right[0] +
				(focus.player[2] - focus.agent[2]) * right[2]
		) /
			2 +
		FOCUS_MARGIN;
	return Math.max(
		FOCUS_DISTANCE,
		across / (tanHalf * aspect),
		FOCUS_HALF_HEIGHT / tanHalf
	);
}

/**
 * Third-person camera. The look-at target eases toward the player each frame.
 * Orbit mode moves the orbit pivot and the camera together, so a drag keeps
 * its angle while the camera follows; isometric keeps a fixed high angle.
 * Talking to an agent eases into a close, low two-shot from the side of the
 * pair, sized to fit the part of the canvas the dialogue leaves uncovered.
 * Each frame it also sets the world's bend around the point it looks at.
 */
export function FollowCamera({
	bounds,
	focus,
	indoors = false,
	mode,
	playerRef,
	reducedMotion,
	shoreZ = null,
	span,
	viewShift,
}: {
	/** Ground the isometric view tries to fit: the cottages and the plaza. */
	bounds: IsoFrame;
	/** An office: the floor barely bends. */
	indoors?: boolean;
	/** The south edge of the walkable ground (the beach starts there). */
	shoreZ?: number | null;
	/** The conversation to frame, or `null` to follow the player. */
	focus: CameraFocus | null;
	mode: World3dParams["camera"];
	playerRef: RefObject<Group | null>;
	reducedMotion: boolean;
	span: number;
	/**
	 * CSS pixels the view slides by to center the scene in what a panel on
	 * the right (x) or a dialogue band at the bottom (y) leaves visible.
	 */
	viewShift: ViewShift;
}) {
	const shiftNow = useRef<ViewShift>({ x: 0, y: 0 });
	const framing = useRef<Framing>("follow");
	const camera = useThree((state) => state.camera);
	const size = useThree((state) => state.size);
	const controls = useThree(
		(state) => state.controls
	) as unknown as OrbitPivot | null;
	// Scratch vectors cloned from the camera (no runtime three.js import).
	const scratch = useMemo(
		() => ({
			eye: camera.position.clone(),
			shift: camera.position.clone(),
			target: camera.position.clone(),
			wanted: camera.position.clone(),
		}),
		[camera]
	);
	const offset = mode === "isometric" ? ISO_OFFSET : FOLLOW_OFFSET;
	const focusKey = focus
		? `${focus.agent.join(",")}|${focus.player.join(",")}|${focus.side}`
		: null;
	const visible = uncoveredSize(size.width, size.height, viewShift);

	// Orthographic zoom fits the whole village when it is small enough;
	// larger villages keep about a dozen tiles in view around the player.
	const isoFit = useMemo(
		() => fitIsometric(bounds, size.width, size.height),
		[bounds, size.height, size.width]
	);
	useEffect(() => {
		if (mode !== "isometric" || !("isOrthographicCamera" in camera)) {
			return;
		}
		camera.zoom =
			isoFit.center === null
				? Math.max(ISO_MIN_ZOOM, Math.min(size.width, size.height * 1.4) / 15)
				: isoFit.zoom;
		camera.updateProjectionMatrix();
	}, [camera, isoFit, mode, size]);
	const isoCenter = mode === "isometric" ? isoFit.center : null;

	// Frame the player once the camera (and, in orbit mode, the controls) exist.
	useEffect(() => {
		const { target } = scratch;
		const player = playerRef.current?.position ?? target.clone().set(0, 0, 0);
		restingTarget(isoCenter, player, target, shoreZ);
		camera.position.set(
			target.x + offset[0],
			target.y + offset[1],
			target.z + offset[2]
		);
		camera.lookAt(target);
		if (controls) {
			controls.target.copy(target);
			controls.update();
		}
	}, [camera, controls, isoCenter, offset, playerRef, scratch, shoreZ]);

	// A new conversation glides in; ending one glides back behind the player.
	useEffect(() => {
		framing.current = focusKey ? "focus" : "return";
	}, [focusKey]);

	// Dragging the view hands the camera to the player until the next change.
	useEffect(() => {
		if (!controls) {
			return;
		}
		const release = () => {
			framing.current = "follow";
		};
		controls.addEventListener("start", release);
		return () => controls.removeEventListener("start", release);
	}, [controls]);

	const setOffset = (shift: ViewShift) => {
		if (shift.x === 0 && shift.y === 0) {
			camera.clearViewOffset();
			return;
		}
		camera.setViewOffset(
			size.width,
			size.height,
			shift.x,
			shift.y,
			size.width,
			size.height
		);
	};

	// Off-center projection: keeps the canvas full size (no WebGL resize when
	// a panel opens) and slides the picture into the uncovered area.
	const applyViewShift = (delta: number) => {
		const wantedX = Math.min(viewShift.x, size.width * 0.45);
		const wantedY = Math.min(viewShift.y, size.height * 0.3);
		const current = shiftNow.current;
		if (current.x === wantedX && current.y === wantedY) {
			return;
		}
		const ease = (from: number, to: number) =>
			reducedMotion || Math.abs(to - from) < 0.5
				? to
				: from + (to - from) * Math.min(1, delta * SHIFT_SPEED);
		shiftNow.current = {
			x: ease(current.x, wantedX),
			y: ease(current.y, wantedY),
		};
		setOffset(shiftNow.current);
	};

	// A resize resets the projection; re-apply the current shift to it.
	useEffect(() => {
		const { x, y } = shiftNow.current;
		if (x !== 0 || y !== 0) {
			camera.setViewOffset(
				size.width,
				size.height,
				x,
				y,
				size.width,
				size.height
			);
		}
	}, [camera, size]);

	/** Where the orbit camera should sit for the current framing. */
	const wantedEye = (target: Vector3, eye: Vector3): Vector3 => {
		if (framing.current === "focus" && focus) {
			const fov = "fov" in camera ? (camera.fov as number) : 40;
			const distance = focusDistance(focus, fov, visible.width, visible.height);
			const direction = focusDirection(focus.side);
			return eye.set(
				target.x + direction[0] * distance,
				target.y + direction[1] * distance + FOCUS_EYE_LIFT,
				target.z + direction[2] * distance
			);
		}
		return eye.set(
			target.x + offset[0],
			target.y + offset[1],
			target.z + offset[2]
		);
	};

	/** Bends the world around the point the camera looks at. */
	const bendAround = (pivot: Vector3) => {
		const { ryuCurve, ryuCurveCenter, ryuCurveDir } = CURVE_UNIFORMS;
		let curve = mode === "isometric" ? ISO_CURVE : ORBIT_CURVE;
		if (indoors) {
			curve = Math.min(curve, INDOOR_CURVE);
		}
		ryuCurve.value = curve;
		ryuCurveCenter.value.x = pivot.x;
		ryuCurveCenter.value.y = pivot.z;
		const dx = pivot.x - camera.position.x;
		const dz = pivot.z - camera.position.z;
		const length = Math.hypot(dx, dz);
		if (length > 0.001) {
			ryuCurveDir.value.x = dx / length;
			ryuCurveDir.value.y = dz / length;
		}
	};

	useFrame((_, delta) => {
		const player = playerRef.current;
		if (!player) {
			return;
		}
		// On a renderer this slow, easing reads as stutter: cut instead.
		const snap = reducedMotion || delta > SNAP_DELTA;
		applyViewShift(snap ? 1 : delta);
		const { eye, shift, target, wanted } = scratch;
		if (focus) {
			wanted.set(
				(focus.player[0] + focus.agent[0]) / 2,
				FOCUS_AIM_HEIGHT,
				(focus.player[2] + focus.agent[2]) / 2
			);
		} else {
			restingTarget(isoCenter, player.position, wanted, shoreZ);
		}
		const speed = focus ? FRAME_SPEED : FOLLOW_SPEED;
		const blend = snap ? 1 : Math.min(1, delta * speed);
		shift.copy(wanted).sub(target).multiplyScalar(blend);
		target.add(shift);
		if (mode === "orbit" && controls) {
			controls.target.add(shift);
			camera.position.add(shift);
			if (framing.current !== "follow") {
				// Glide the eye too; settle once it is there.
				wantedEye(target, eye);
				const glide = snap ? 1 : Math.min(1, delta * FRAME_SPEED);
				camera.position.lerp(eye, glide);
				if (
					camera.position.distanceTo(eye) < 0.02 &&
					target.distanceTo(wanted) < 0.02
				) {
					framing.current = "follow";
				}
			}
			// The controls aimed the lens before it moved this frame; aim it
			// again so a cut never shows one frame looking the old way.
			camera.lookAt(controls.target);
			bendAround(controls.target);
		} else {
			camera.position.set(
				target.x + offset[0],
				target.y + offset[1],
				target.z + offset[2]
			);
			camera.lookAt(target);
			bendAround(target);
		}
		// Name plates project with this frame's camera, not the last one.
		camera.updateMatrixWorld();
		// Runs after the orbit controls' update (-1, subscribed first as a
		// child) and before the name plates (0).
	}, -1);

	return mode === "orbit" ? (
		<OrbitControls
			enableDamping
			enablePan={false}
			makeDefault
			maxDistance={Math.max(14, span * 1.1)}
			maxPolarAngle={MAX_POLAR_ANGLE}
			minDistance={MIN_ORBIT_DISTANCE}
			minPolarAngle={MIN_POLAR_ANGLE}
		/>
	) : null;
}

/**
 * Fog distances: the village stays crisp and the far ground melts into the
 * horizon haze (aerial perspective) as it rolls away.
 */
export function fogRange(mode: World3dParams["camera"]): [number, number] {
	const distance = Math.hypot(
		...(mode === "isometric" ? ISO_OFFSET : FOLLOW_OFFSET)
	);
	return mode === "isometric"
		? [distance + 6, distance + 34]
		: [distance + 6, distance + 30];
}
