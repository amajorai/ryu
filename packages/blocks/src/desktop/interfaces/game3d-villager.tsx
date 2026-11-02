/* eslint-disable react/no-unknown-property */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Group, Mesh } from "three";
import {
	compileLife,
	emptyLifeFrame,
	type LifeBubble,
	type LifeItem,
	type LifePaths,
	type LifeScript,
	type LifeState,
	lifeStateAt,
	sampleLife,
} from "./game3d-life.ts";
import {
	CarriedItem,
	LifeEffects,
	type LifeRuntime,
	poseLife,
} from "./game3d-life.tsx";
import { CurvedBasicMaterial } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type { VillagerSpec } from "./game3d-villager-looks.ts";
import {
	FACE_CAMERA,
	FigureProbes,
	PLATE_HEIGHT,
	poseVillager,
	VillagerPlate,
} from "./game3d-villager-plate.tsx";
import {
	type RigFrame,
	type RigPose,
	VillagerRig,
} from "./game3d-villager-rig.tsx";
import {
	type LifeClock,
	lifeClockAt,
	needsLifeFrame,
} from "./game3d-villager-tools.ts";

export {
	AGENT_PARTS,
	EAR_TUFTS,
	eyeParts,
	fringe,
	SIDE_LOCKS,
} from "./game3d-villager-hair.ts";
export {
	accessoryFor,
	useVillagerLooks,
	type VillagerSpec,
	villagerLooksFor,
} from "./game3d-villager-looks.ts";
export {
	BODY_Y,
	CHARACTER_INK,
	CHARACTER_RIM,
	fixed,
	HAIR_SHEEN,
	HEAD_RADIUS,
	HEAD_RIM,
	HEAD_Y,
	headTurn,
	LOCK_INK,
	lock,
	type MemberLooks,
	onHead,
	type PartGeometry,
	type PartSpec,
	pair,
	SHINE,
	SHOE_COLOR,
	type VillagerAccessory,
	type VillagerPose,
	type VillagerTool,
} from "./game3d-villager-model.ts";
export {
	FACE_CAMERA,
	initialOf,
	VillagerPlate,
	villagerPlateLabel,
} from "./game3d-villager-plate.tsx";
export {
	type RigFrame,
	type RigPose,
	VillagerRig,
} from "./game3d-villager-rig.tsx";
export {
	localMatrices,
	PART_GROUPS,
	type PartGroup,
	PartMaterial,
	PartShape,
	shortestAngle,
} from "./game3d-villager-shape.tsx";
export {
	isWorkBubble,
	type LifeClock,
	lifeClockAt,
	needsAnchorRedraw,
	needsLifeFrame,
	toolPartsFor,
} from "./game3d-villager-tools.ts";

/**
 * The kit's villagers: the chibi characters of World 3D (a big round head
 * about as tall as the small body, stubby arms and feet) with anime faces:
 * large eyes with a colored iris, two highlights and a lash line, a small
 * mouth and blush, and anime hair (bangs, side locks, and a style per
 * agent: short, long, spiky with an ahoge, or a bun). Every villager is the
 * same rig drawn with one instanced mesh per body part (plus one ink hull
 * for the parts that are outlined), so a crowd stays a few dozen draw calls.
 *
 * - `VillagerRig` draws the rig for any number of villagers; the caller
 *   poses each one every frame (root transform and arm swings).
 * - `Villagers` is what a game uses: one villager per agent, posed by state
 *   (`idle`, `working` with a tool in hand, `needs-you` waving under a
 *   bouncing "!" bubble, `failed` slumped with a red mark, `waiting`
 *   looking around), optionally walking a looped path, each with a name
 *   plate that is the villager's focusable, clickable control.
 * - `useVillagerLooks` gives each agent its outfit (from its swatch), hair
 *   and a head accessory, so agents read apart at a glance.
 */

/** What a scripted villager shows outside the rig: bubble and held item. */
interface LifeShown {
	bubble: LifeBubble | null;
	item: LifeItem | null;
}

const NO_SHOWN: ReadonlyMap<string, LifeShown> = new Map();

/** Where a scripted villager starts when it first appears. */
function lifeStart(spec: VillagerSpec): LifeState {
	return {
		action: "idle",
		bubble: null,
		item: null,
		position: spec.position,
		yaw: spec.facing ?? FACE_CAMERA,
	};
}

/**
 * The villagers of a game, posed by state, with their name plates. A
 * selected villager wears a pressed plate and a ring on the ground.
 *
 * A villager whose spec has a `life` script acts it out (walking `paths`,
 * the game's waypoints): villagers on stage at the first frame start
 * settled at their script's end, so a scene opens calm; later key changes
 * and newcomers play their steps. Under reduced motion every script snaps
 * to its settled end.
 */
export function Villagers({
	iconOnly = false,
	onHover,
	onSelect,
	paths,
	plates = true,
	reducedMotion,
	selectedId = null,
	villagers,
}: {
	/** Narrow stages: plates show the initial only (names stay accessible). */
	iconOnly?: boolean;
	onHover?: (id: string | null) => void;
	onSelect?: (id: string) => void;
	/** Waypoints scripted villagers walk along (straight lines without). */
	paths?: LifePaths;
	plates?: boolean;
	reducedMotion: boolean;
	selectedId?: string | null;
	villagers: readonly VillagerSpec[];
}) {
	const members = useMemo(
		() => villagers.map((villager) => villager.looks),
		[villagers]
	);
	const anchors = useRef<(Group | null)[]>([]);
	const lives = useRef(new Map<string, LifeRuntime>());
	const byIndex = useRef<(LifeRuntime | null)[]>([]);
	const seeded = useRef(false);
	// A plate's Html places itself before this moves its anchor in a frame,
	// so a moved anchor needs one more frame (a demand canvas draws none).
	const anchorsMoved = useRef(false);
	const wasBusy = useRef(false);
	// Life scripts run on a clock that never goes back: R3F restarts its
	// clock at 0 whenever the frame loop changes (a paused stage, one
	// scrolled off), which would rewind every script to its start.
	const clockBase = useRef<LifeClock>({ last: 0, offset: 0 });
	const dirty = useRef(false);
	const [shown, setShown] = useState(NO_SHOWN);
	const invalidate = useThree((state) => state.invalidate);
	const canvas = useThree((state) => state.gl.domElement);
	const lifeKeys = villagers
		.map((villager) =>
			villager.life ? `${villager.id}:${villager.life.key}` : ""
		)
		.join("\n");
	// A script change must draw even when the frame loop runs on demand.
	// biome-ignore lint/correctness/useExhaustiveDependencies: redraw whenever any script key changes.
	useEffect(() => {
		invalidate();
	}, [invalidate, lifeKeys, shown]);

	const publish = () => {
		if (dirty.current) {
			return;
		}
		dirty.current = true;
		queueMicrotask(() => {
			dirty.current = false;
			const next = new Map<string, LifeShown>();
			for (const [id, runtime] of lives.current) {
				next.set(id, runtime.shown);
			}
			setShown(next);
		});
	};

	const live = (spec: VillagerSpec, script: LifeScript, time: number) => {
		let runtime = lives.current.get(spec.id);
		if (!runtime || runtime.key !== script.key) {
			const start = runtime
				? lifeStateAt(runtime.timeline, time - runtime.startedAt, reducedMotion)
				: lifeStart(spec);
			const timeline = compileLife(start, script, paths);
			const settle = !(runtime || seeded.current);
			const startedAt = settle ? time - timeline.settled : time;
			if (runtime) {
				runtime.key = script.key;
				runtime.timeline = timeline;
				runtime.startedAt = startedAt;
			} else {
				runtime = {
					body: { scale: 1, x: 0, y: 0, yaw: 0, z: 0 },
					frame: emptyLifeFrame(),
					key: script.key,
					shown: { bubble: null, item: null },
					startedAt,
					timeline,
				};
				lives.current.set(spec.id, runtime);
			}
		}
		sampleLife(
			runtime.timeline,
			time - runtime.startedAt,
			runtime.frame,
			reducedMotion
		);
		const { bubble, item } = runtime.frame;
		if (bubble !== runtime.shown.bubble || item !== runtime.shown.item) {
			runtime.shown = { bubble, item };
			publish();
		}
		return runtime;
	};

	const pose = (index: number, out: RigPose, frame: RigFrame) => {
		const spec = villagers[index];
		if (!spec) {
			return;
		}
		const scale = spec.scale ?? 1;
		const time = lifeClockAt(clockBase.current, frame.time);
		const runtime = spec.life ? live(spec, spec.life, time) : null;
		byIndex.current[index] = runtime;
		if (runtime) {
			poseLife(runtime.frame, out, time, index * 1.7, reducedMotion);
		} else {
			poseVillager(spec, index, out, frame.time, reducedMotion);
		}
		const parent = spec.follow?.();
		if (parent) {
			out.position.x += parent.x;
			out.position.z += parent.z;
		}
		if (spec.scale) {
			out.scale.multiplyScalar(spec.scale);
		}
		if (runtime) {
			const { body } = runtime;
			body.x = out.position.x;
			body.y = out.position.y;
			body.z = out.position.z;
			body.yaw = out.rotation.y;
			body.scale = scale;
		}
		const anchor = anchors.current[index];
		if (anchor && (spec.walk || runtime || spec.follow)) {
			const y =
				(runtime ? runtime.frame.position[1] : spec.position[1]) +
				PLATE_HEIGHT * scale;
			const { position } = anchor;
			if (
				position.x !== out.position.x ||
				position.y !== y ||
				position.z !== out.position.z
			) {
				anchorsMoved.current = true;
			}
			position.set(out.position.x, y, out.position.z);
		}
	};

	useFrame(({ clock }) => {
		// Villagers present at the first frame have been settled; anyone
		// scripted from now on plays in.
		seeded.current = true;
		// How many villagers still play their one-off steps (walking to their
		// spot, delivering): `data-life-busy` on the canvas, for checks that
		// must wait for the scene to settle. Reduced motion reads the end.
		let busy = 0;
		if (!reducedMotion) {
			const time = lifeClockAt(clockBase.current, clock.elapsedTime);
			for (const runtime of lives.current.values()) {
				const elapsed = time - runtime.startedAt;
				if (elapsed >= 0 && elapsed < runtime.timeline.settled) {
					busy += 1;
				}
			}
		}
		if (
			needsLifeFrame({
				busy,
				moved: anchorsMoved.current,
				reducedMotion,
				wasBusy: wasBusy.current,
			})
		) {
			invalidate();
		}
		wasBusy.current = busy > 0;
		anchorsMoved.current = false;
		const count = String(busy);
		if (canvas.dataset.lifeBusy !== count) {
			canvas.dataset.lifeBusy = count;
		}
		byIndex.current.length = villagers.length;
		for (const id of lives.current.keys()) {
			if (!villagers.some((villager) => villager.id === id && villager.life)) {
				lives.current.delete(id);
			}
		}
	});

	const selected = villagers.find((villager) => villager.id === selectedId);
	const scripted = villagers.some((villager) => villager.life);
	return (
		<group>
			<VillagerRig
				members={members}
				onHover={
					onHover
						? (index) =>
								onHover(index === null ? null : (villagers[index]?.id ?? null))
						: undefined
				}
				onPick={
					onSelect || villagers.some((villager) => villager.activate)
						? (index) => {
								const villager = villagers[index];
								if (villager?.activate) {
									villager.activate();
								} else if (villager) {
									onSelect?.(villager.id);
								}
							}
						: undefined
				}
				pose={pose}
			/>
			{villagers.map((villager) => {
				const item = villager.life ? shown.get(villager.id)?.item : null;
				const runtime = lives.current.get(villager.id);
				return item && runtime ? (
					<CarriedItem body={runtime.body} item={item} key={villager.id} />
				) : null;
			})}
			{scripted && !reducedMotion ? (
				<LifeEffects count={villagers.length} runtimes={byIndex} />
			) : null}
			{plates
				? villagers.map((villager, index) =>
						villager.plate === false ? null : (
							<group
								key={villager.id}
								position={[
									villager.position[0],
									villager.position[1] + PLATE_HEIGHT * (villager.scale ?? 1),
									villager.position[2],
								]}
								ref={(group) => {
									anchors.current[index] = group;
								}}
							>
								<VillagerPlate
									bubble={
										villager.life && villager.bubble !== false
											? shown.get(villager.id)?.bubble
											: null
									}
									iconOnly={villager.iconOnly ?? iconOnly}
									onSelect={onSelect}
									selected={villager.id === selectedId}
									spec={villager}
								/>
								<FigureProbes
									id={villager.actAgent ?? villager.id}
									scale={villager.scale ?? 1}
								/>
							</group>
						)
					)
				: null}
			{selected && !selected.walk && !selected.life ? (
				<GroundRing
					color={selected.looks.body}
					position={selected.position}
					reducedMotion={reducedMotion}
				/>
			) : null}
		</group>
	);
}

/** A soft, pulsing ring on the ground: the selected villager or object. */
export function GroundRing({
	color,
	position,
	radius = 0.5,
	reducedMotion,
}: {
	color: string;
	position: Vec3;
	radius?: number;
	reducedMotion: boolean;
}) {
	const ref = useRef<Mesh>(null);
	useFrame(({ clock }) => {
		const ring = ref.current;
		if (!ring || reducedMotion) {
			return;
		}
		const pulse = 1 + (0.5 + Math.sin(clock.elapsedTime * 4) * 0.5) * 0.1;
		ring.scale.set(pulse, pulse, 1);
	});
	return (
		<mesh
			position={[position[0], position[1] + 0.04, position[2]]}
			ref={ref}
			renderOrder={2}
			rotation={[-Math.PI / 2, 0, 0]}
		>
			<ringGeometry args={[radius * 0.84, radius, 48, 2]} />
			<CurvedBasicMaterial
				color={color}
				depthWrite={false}
				opacity={0.8}
				polygonOffset
				polygonOffsetFactor={-4}
				toneMapped={false}
				transparent
			/>
		</mesh>
	);
}
