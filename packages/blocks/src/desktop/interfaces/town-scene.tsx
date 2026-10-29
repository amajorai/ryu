/* eslint-disable react/no-unknown-property */
import { Html, RoundedBoxGeometry } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import type {
	DirectionalLight,
	InstancedMesh,
	OrthographicCamera,
	Vector3,
} from "three";
import {
	actLife,
	slotOf,
	toolForActivity,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import { Cottages } from "./game3d-cottages.tsx";
import { FlowerClusters, type FlowerPatch } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland, islandFor } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import type { IslandShape } from "./game3d-island.ts";
import type { LifePaths } from "./game3d-life.ts";
import { ToonMaterial } from "./game3d-materials.tsx";
import { mathKit } from "./game3d-math.ts";
import type { Scene3dTheme } from "./game3d-palette.ts";
import { Bloom } from "./game3d-post.tsx";
import {
	LampPosts,
	PathStones,
	type PlantedTree,
	Pond,
	TreeGrove,
} from "./game3d-props.tsx";
import { useGlowCanvas } from "./game3d-sky.tsx";
import { SeaStars, sceneTheme } from "./game3d-stage.tsx";
import {
	CURVE_UNIFORMS,
	linearRgb,
	QUALITY,
	type RenderQuality,
	setLook,
} from "./game3d-toon.ts";
import {
	FACE_CAMERA,
	useVillagerLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
	type VillagerTool,
} from "./game3d-villager.tsx";
import { TOWN_SKIN, TownActMeshes, townPaths } from "./town-acts.tsx";
import {
	type SimClock,
	SimProvider,
	TownMesh,
	useSim,
	type Vec3,
} from "./town-art.tsx";
import {
	AgentBuilding,
	buildingBox,
	CityHall,
	HALL_TOP,
	hallCottage,
	PAD_Y,
	tagPoint,
	townCottages,
	zoneRails,
} from "./town-buildings.tsx";
import {
	ISLAND_MARGIN,
	LOT,
	ROAD,
	roadLines,
	SIDEWALK,
	type Town,
	type TownDistrict,
	townFrame,
} from "./town-model.ts";
import {
	districtColor,
	hashId,
	mixHex,
	pickById,
	type TownDataView,
	type TownPalette,
} from "./town-palette.ts";

/**
 * The Town scene (lazy-loaded): a toon-shaded diorama on a slab of earth,
 * seen through an isometric (orthographic) camera. A road grid frames the
 * district blocks around City Hall; lots carry the agents' buildings, the
 * houses that grew there and empty zoned plots; cars run the roads while
 * agents work. Drag orbits within limits and the wheel zooms; the DOM layer
 * (hit targets and signs) is placed from here after every camera move.
 *
 * The frame loop stops when the stage is hidden or the clock is paused
 * (reduced motion starts paused), and then only draws on change. React
 * Three Fiber disposes every geometry, material and the context on unmount.
 */

/** Default view: azimuth from +z toward +x, and elevation (radians). */
const AZIMUTH = Math.PI / 4;
const ELEVATION = 0.62;
const ORBIT = 0.55;
const ELEVATION_RANGE: [number, number] = [0.42, 1.0];
const ZOOM_RANGE: [number, number] = [0.75, 3.2];
/** Lowest point of the earth slab and highest of the edge trees. */
const SLAB_BOTTOM = -1.12;
/** How much closer than fit-to-content the home view frames the town. */
const FRAME_FILL = 1.3;
const EDGE_TOP = 1.4;

export interface SceneInsets {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/** What the DOM can ask of the camera. */
export interface TownCamera {
	focus: (target: { x: number; z: number; zoom?: number }) => void;
	reset: () => void;
	zoomBy: (factor: number) => void;
}

/** The act layer's part in the scene (town-acts.tsx), when the host sends asks. */
export interface TownActScene {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	/** Where the act props' DOM plates stand. */
	anchors: ReadonlyMap<string, Vec3>;
	clock?: ClockOptions;
	slots: readonly YouSpotSlot[];
}

export interface TownSceneProps {
	/**
	 * The asks and the clock for the act meshes (the clock tower's oldest
	 * wait), apart from `actScene` so its identity holds between ticks.
	 */
	actAsks?: InterfaceSnapshot["asks"];
	/** False when the stage is hidden: the frame loop stops. */
	active: boolean;
	actNow?: number;
	/** The act layer: townsfolk act out their acts; act plates follow. */
	actScene?: TownActScene | null;
	dataView: TownDataView;
	hoverId: string | null;
	insets: SceneInsets;
	onCamera: (camera: TownCamera) => void;
	onDrawn: () => void;
	/** The DOM layer whose `[data-anchor]` children follow the scene. */
	overlay: RefObject<HTMLDivElement | null>;
	palette: TownPalette;
	quality: RenderQuality;
	reduced: boolean;
	selectedId: string | null;
	/** Simulation speed: 0 paused, 1 normal, 3 fast. */
	speed: number;
	town: Town;
}

export default function TownScene(props: TownSceneProps) {
	const { active, quality, reduced, speed } = props;
	let frameloop: "always" | "demand" | "never" = "always";
	if (!active) {
		frameloop = "never";
	} else if (reduced || speed === 0) {
		frameloop = "demand";
	}
	return (
		<Canvas
			camera={{ far: 400, near: 0.1, position: [40, 40, 40], zoom: 20 }}
			dpr={QUALITY[quality].dpr}
			flat
			frameloop={frameloop}
			gl={{ antialias: false, powerPreference: "high-performance" }}
			orthographic
			shadows={quality === "high" ? "soft" : true}
			style={{ inset: 0, position: "absolute", touchAction: "none" }}
		>
			<TownContents {...props} />
		</Canvas>
	);
}

function TownContents(props: TownSceneProps) {
	const {
		dataView,
		hoverId,
		onDrawn,
		palette,
		quality,
		reduced,
		selectedId,
		speed,
		town,
	} = props;
	const clock = useRef<SimClock>({ time: 0 });
	CURVE_UNIFORMS.ryuCurve.value = 0;
	useMemo(
		() =>
			setLook({
				ink: palette.ink,
				rimLight: palette.rimLight,
				shadeTint: palette.shadeTint,
				sun: palette.sunDirection,
			}),
		[palette]
	);
	const fillers = useMemo(
		() => [
			...town.districts.flatMap((district) => district.fillers),
			...town.parks.flatMap((park) => park.homes),
		],
		[town]
	);
	const night = palette.mode === "dark";
	const cottages = useMemo(
		() =>
			townCottages(town.buildings, fillers, night, hallCottage(palette, night)),
		[fillers, night, palette, town.buildings]
	);
	const theme = sceneTheme(night);
	const glow = useGlowCanvas();
	const shape = useMemo(
		() => islandFor(town.grid.reach * 2, town.grid.reach * 2, ISLAND_MARGIN),
		[town.grid.reach]
	);
	return (
		<SimProvider clock={clock}>
			<SimTicker clock={clock} reduced={reduced} speed={speed} />
			<color args={[theme.water ?? palette.background]} attach="background" />
			<Lights palette={palette} quality={quality} town={town} />
			<CameraRig {...props} />
			<Ground
				palette={palette}
				quality={quality}
				reduced={reduced}
				shape={shape}
				theme={theme}
				town={town}
			/>
			{town.districts.map((district) => (
				<DistrictBlock
					dataView={dataView}
					district={district}
					inner={town.grid.inner}
					key={district.id}
					palette={palette}
				/>
			))}
			<Plaza inner={town.grid.inner} palette={palette} />
			{town.parks.map((park) => (
				<Block
					color={palette.grassDark}
					inner={town.grid.inner}
					key={park.id}
					palette={palette}
					x={park.x}
					z={park.z}
				/>
			))}
			<Ponds night={night} town={town} />
			<Trees theme={theme} town={town} />
			<Lamps night={night} town={town} />
			<Townsfolk
				actScene={props.actScene ?? null}
				night={night}
				reduced={reduced}
				town={town}
			/>
			{props.actScene ? (
				<TownActMeshes
					acts={props.actScene.acts}
					clock={props.actScene.clock}
					nowMs={props.actNow ?? 0}
					palette={palette}
					reduced={reduced}
					slots={props.actScene.slots}
					snapshot={{ asks: props.actAsks }}
					town={town}
				/>
			) : null}
			{night ? (
				<SeaStars glow={glow} span={(town.grid.reach + ISLAND_MARGIN) * 2} />
			) : null}
			{town.buildings.map((building) => (
				<AgentBuilding
					building={building}
					hovered={hoverId === `b:${building.agent.id}`}
					key={building.agent.id}
					palette={palette}
					reduced={reduced}
					selected={selectedId === building.agent.id}
				/>
			))}
			<Cottages
				cottages={cottages}
				lamps={false}
				reducedMotion={reduced}
				theme={theme}
			/>
			<CityHall
				hovered={hoverId === "hall"}
				palette={palette}
				reduced={reduced}
			/>
			<Cars count={town.cars} palette={palette} town={town} />
			{palette.mode === "dark" ? (
				<Bloom
					samples={quality === "high" ? 4 : 0}
					strength={palette.lampGlow}
				/>
			) : null}
			<FirstFrames onReady={onDrawn} />
		</SimProvider>
	);
}

/** Advances the simulation clock by the speed control. */
function SimTicker({
	clock,
	reduced,
	speed,
}: {
	clock: { current: SimClock };
	reduced: boolean;
	speed: number;
}) {
	useFrame((_, delta) => {
		if (!reduced) {
			clock.current.time += Math.min(delta, 0.1) * speed;
		}
	});
	return null;
}

/** Calls `onReady` once the scene has drawn a couple of frames. */
function FirstFrames({ onReady }: { onReady: () => void }) {
	const frames = useRef(0);
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		invalidate();
	}, [invalidate]);
	useFrame(() => {
		frames.current += 1;
		if (frames.current === 2) {
			onReady();
		} else if (frames.current < 2) {
			invalidate();
		}
	});
	return null;
}

function Lights({
	palette,
	quality,
	town,
}: {
	palette: TownPalette;
	quality: RenderQuality;
	town: Town;
}) {
	const sun = useRef<DirectionalLight>(null);
	const reach = town.grid.reach + ISLAND_MARGIN + 2;
	useLayoutEffect(() => {
		const light = sun.current;
		if (!light) {
			return;
		}
		light.target.position.set(0, 0, 0);
		light.target.updateMatrixWorld();
		const camera = light.shadow.camera;
		camera.left = -reach;
		camera.right = reach;
		camera.top = reach;
		camera.bottom = -reach;
		camera.near = 1;
		camera.far = 120;
		camera.updateProjectionMatrix();
		light.shadow.needsUpdate = true;
	}, [reach]);
	const mapSize = QUALITY[quality].shadowMap;
	const [dx, dy, dz] = palette.sunDirection;
	return (
		<>
			<hemisphereLight
				args={[palette.hemiSky, palette.hemiGround, palette.hemiIntensity]}
			/>
			<ambientLight intensity={palette.ambient} />
			<directionalLight
				castShadow
				color={palette.sunColor}
				intensity={palette.sun}
				position={[dx * 40, dy * 40, dz * 40]}
				ref={sun}
				shadow-bias={-0.0005}
				shadow-mapSize={[mapSize, mapSize]}
				shadow-normalBias={0.03}
				shadow-radius={3}
			/>
		</>
	);
}

interface CameraState {
	azimuth: number;
	elevation: number;
	x: number;
	z: number;
	zoom: number;
}

const HOME: CameraState = {
	azimuth: AZIMUTH,
	elevation: ELEVATION,
	x: 0,
	z: 0,
	zoom: 1,
};

function sameState(a: CameraState, b: CameraState): boolean {
	return (
		a.azimuth === b.azimuth &&
		a.elevation === b.elevation &&
		a.x === b.x &&
		a.z === b.z &&
		a.zoom === b.zoom
	);
}

function clamp(value: number, [low, high]: [number, number]): number {
	return Math.min(high, Math.max(low, value));
}

/**
 * The isometric camera: fitted to the town inside the stage insets, then
 * eased toward a goal that drag (orbit, limited), the wheel (zoom) and
 * focus requests move. After every move it places the DOM anchors.
 */
function CameraRig({
	actScene,
	insets,
	onCamera,
	overlay,
	reduced,
	town,
}: TownSceneProps) {
	const camera = useThree((state) => state.camera) as OrthographicCamera;
	const size = useThree((state) => state.size);
	const invalidate = useThree((state) => state.invalidate);
	const gl = useThree((state) => state.gl);
	const home = useRef<CameraState>({ ...HOME });
	const goal = useRef<CameraState>({ ...HOME });
	const current = useRef<CameraState>({ ...HOME });
	const fit = useRef(20);
	const dirty = useRef(true);
	const reach = town.grid.reach;

	const anchors = useMemo(() => {
		const boxes = new Map<string, { max: Vec3; min: Vec3 }>();
		const points = new Map<string, Vec3>();
		for (const building of town.buildings) {
			boxes.set(`b:${building.agent.id}`, buildingBox(building));
			points.set(`t:${building.agent.id}`, tagPoint(building));
		}
		points.set("t:hall", [0, HALL_TOP + 0.35, -0.2]);
		boxes.set("hall", {
			max: [1.9, HALL_TOP, 1.2],
			min: [-1.9, 0, -1.6],
		});
		for (const district of town.districts) {
			points.set(`d:${district.id}`, signPoint(district, town.grid.inner));
		}
		for (const [anchor, point] of actScene?.anchors ?? []) {
			points.set(anchor, point);
		}
		return { boxes, points };
	}, [actScene?.anchors, town]);

	// Fit the whole island at the home angle, once per size, insets and layout.
	useLayoutEffect(() => {
		if (size.width <= 0 || size.height <= 0) {
			return;
		}
		const narrow = size.width < 640;
		// Frame City Hall and the built-up blocks; the parks bleed off the
		// sides like the rest of a bigger city, so the buildings read.
		// With acts every building is an agent's one target and must stay on
		// stage: frame the buildings themselves, phone or not.
		const actFrame = actScene ? buildingsFrame(town) : null;
		const frame =
			actFrame ??
			townFrame(town, town.districts.length > 0 ? "districts" : "island");
		const tallest = Math.max(
			EDGE_TOP,
			...town.buildings.map((building) => buildingBox(building).max[1] * 0.6)
		);
		let heights = [SLAB_BOTTOM, EDGE_TOP];
		if (town.districts.length > 0) {
			heights = narrow ? [0, EDGE_TOP] : [0, tallest];
		}
		const next: CameraState = {
			...HOME,
			x: (frame.minX + frame.maxX) / 2,
			z: (frame.minZ + frame.maxZ) / 2,
		};
		const atHome = sameState(goal.current, home.current);
		home.current = next;
		place(camera, next, 1);
		const scratch = camera.position.clone();
		let minX = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const x of [frame.minX, frame.maxX]) {
			for (const z of [frame.minZ, frame.maxZ]) {
				for (const y of heights) {
					scratch.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
					minX = Math.min(minX, scratch.x);
					maxX = Math.max(maxX, scratch.x);
					minY = Math.min(minY, scratch.y);
					maxY = Math.max(maxY, scratch.y);
				}
			}
		}
		const width = Math.max(80, size.width - insets.left - insets.right);
		const height = Math.max(80, size.height - insets.top - insets.bottom);
		// A portrait stage (a phone) would shrink the town to a strip across
		// the middle: let the outer blocks run off the sides instead.
		const across =
			(width / (maxX - minX)) * (height > width * 1.2 && !actFrame ? 1.6 : 1);
		// A touch closer than fit-to-content: the parks bleed off the edges and
		// the cottages and townsfolk read at a glance.
		// With acts the buildings are framed to fit (every one is a target).
		fit.current =
			Math.min(across, height / (maxY - minY)) * (actFrame ? 0.96 : FRAME_FILL);
		const offsetX = (insets.right - insets.left) / 2;
		const offsetY = (insets.bottom - insets.top) / 2;
		camera.setViewOffset(
			size.width,
			size.height,
			offsetX,
			offsetY,
			size.width,
			size.height
		);
		if (atHome) {
			goal.current = { ...next };
			current.current = { ...next };
		}
		dirty.current = true;
		invalidate();
	}, [actScene, camera, insets, invalidate, size, town]);

	// Pointer drag orbits (within limits); the wheel zooms.
	useEffect(() => {
		const element = gl.domElement;
		let drag: { id: number; x: number; y: number } | null = null;
		const onDown = (event: PointerEvent) => {
			if (event.button !== 0) {
				return;
			}
			drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
			element.setPointerCapture(event.pointerId);
		};
		const onMove = (event: PointerEvent) => {
			if (!drag || drag.id !== event.pointerId) {
				return;
			}
			const dx = event.clientX - drag.x;
			const dy = event.clientY - drag.y;
			drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
			goal.current.azimuth = clamp(goal.current.azimuth - dx * 0.006, [
				AZIMUTH - ORBIT,
				AZIMUTH + ORBIT,
			]);
			goal.current.elevation = clamp(
				goal.current.elevation + dy * 0.004,
				ELEVATION_RANGE
			);
			invalidate();
		};
		const onUp = (event: PointerEvent) => {
			if (drag?.id === event.pointerId) {
				drag = null;
			}
		};
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			goal.current.zoom = clamp(
				goal.current.zoom * Math.exp(-event.deltaY * 0.0015),
				ZOOM_RANGE
			);
			invalidate();
		};
		element.addEventListener("pointerdown", onDown);
		element.addEventListener("pointermove", onMove);
		element.addEventListener("pointerup", onUp);
		element.addEventListener("pointercancel", onUp);
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			element.removeEventListener("pointerdown", onDown);
			element.removeEventListener("pointermove", onMove);
			element.removeEventListener("pointerup", onUp);
			element.removeEventListener("pointercancel", onUp);
			element.removeEventListener("wheel", onWheel);
		};
	}, [gl, invalidate]);

	// A narrow stage pulls a focus back, so the focused building keeps its
	// neighbours and the roads around it in view.
	const stageWidth = useRef(size.width);
	stageWidth.current = size.width;
	useEffect(() => {
		onCamera({
			focus: ({ x, z, zoom }) => {
				goal.current.x = clamp(x, [-reach, reach]);
				goal.current.z = clamp(z, [-reach, reach]);
				goal.current.zoom = clamp(
					(zoom ?? 2.3) / focusEase(stageWidth.current),
					ZOOM_RANGE
				);
				invalidate();
			},
			reset: () => {
				goal.current = { ...home.current };
				invalidate();
			},
			zoomBy: (factor) => {
				goal.current.zoom = clamp(goal.current.zoom * factor, ZOOM_RANGE);
				invalidate();
			},
		});
	}, [invalidate, onCamera, reach]);

	// New anchors (a re-render of the DOM layer) need placing too.
	useEffect(() => {
		dirty.current = true;
		invalidate();
	});

	useFrame((_, delta) => {
		const from = current.current;
		const to = goal.current;
		const ease = reduced ? 1 : 1 - Math.exp(-Math.min(delta, 0.1) * 7);
		let moving = false;
		for (const key of ["azimuth", "elevation", "x", "z", "zoom"] as const) {
			const gap = to[key] - from[key];
			if (Math.abs(gap) > 1e-4) {
				from[key] += gap * ease;
				moving = true;
			} else {
				from[key] = to[key];
			}
		}
		if (!(moving || dirty.current)) {
			return;
		}
		dirty.current = false;
		place(camera, from, fit.current * from.zoom);
		placeAnchors(camera, overlay.current, anchors, size, insets);
		if (moving) {
			invalidate();
		}
	});
	return null;
}

/** The box round City Hall and every agent building, with a little margin. */
function buildingsFrame(town: Town): {
	maxX: number;
	maxZ: number;
	minX: number;
	minZ: number;
} {
	const frame = { maxX: 2.6, maxZ: 3.2, minX: -2.6, minZ: -2.2 };
	for (const building of town.buildings) {
		const box = buildingBox(building);
		frame.minX = Math.min(frame.minX, box.min[0] - 0.6);
		frame.maxX = Math.max(frame.maxX, box.max[0] + 0.6);
		frame.minZ = Math.min(frame.minZ, box.min[2] - 0.6);
		frame.maxZ = Math.max(frame.maxZ, box.max[2] + 0.6);
	}
	return frame;
}

/** How much a focus zoom eases off on a narrow stage. */
export function focusEase(width: number): number {
	if (width <= 0 || width >= 900) {
		return 1;
	}
	if (width < 640) {
		return 1.3;
	}
	return 1 + ((900 - width) / 260) * 0.3;
}

function place(
	camera: OrthographicCamera,
	state: CameraState,
	zoom: number
): void {
	const distance = 80;
	const flat = Math.cos(state.elevation) * distance;
	camera.position.set(
		state.x + Math.sin(state.azimuth) * flat,
		Math.sin(state.elevation) * distance,
		state.z + Math.cos(state.azimuth) * flat
	);
	camera.lookAt(state.x, 0, state.z);
	camera.zoom = zoom;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld();
}

/**
 * Where a district's sign stands: inside its own block, on the front edge
 * the camera sees, and never on the edge it shares with City Hall's plaza.
 */
export function signPoint(district: TownDistrict, inner: number): Vec3 {
	const inset = inner / 2 - 0.35;
	const behindHall = district.cell.col === 0 && district.cell.row === -1;
	return behindHall
		? [district.x + inset, PAD_Y, district.z]
		: [district.x, PAD_Y, district.z + inset];
}

/** Moves every `[data-anchor]` element in the DOM layer onto the art. */
function placeAnchors(
	camera: OrthographicCamera,
	overlay: HTMLDivElement | null,
	anchors: {
		boxes: Map<string, { max: Vec3; min: Vec3 }>;
		points: Map<string, Vec3>;
	},
	size: { height: number; width: number },
	insets: SceneInsets = NO_INSETS
): void {
	if (!overlay) {
		return;
	}
	const scratch: Vector3 = camera.position.clone();
	const project = (x: number, y: number, z: number) => {
		scratch.set(x, y, z).project(camera);
		return {
			x: ((scratch.x + 1) / 2) * size.width,
			y: ((1 - scratch.y) / 2) * size.height,
		};
	};
	const labels: PlacedLabel[] = [];
	for (const element of overlay.querySelectorAll<HTMLElement>(
		"[data-anchor]"
	)) {
		const id = element.dataset.anchor ?? "";
		const box = anchors.boxes.get(id);
		const point = anchors.points.get(id);
		if (box) {
			let minX = Number.POSITIVE_INFINITY;
			let maxX = Number.NEGATIVE_INFINITY;
			let minY = Number.POSITIVE_INFINITY;
			let maxY = Number.NEGATIVE_INFINITY;
			for (const x of [box.min[0], box.max[0]]) {
				for (const y of [box.min[1], box.max[1]]) {
					for (const z of [box.min[2], box.max[2]]) {
						const screen = project(x, y, z);
						minX = Math.min(minX, screen.x);
						maxX = Math.max(maxX, screen.x);
						minY = Math.min(minY, screen.y);
						maxY = Math.max(maxY, screen.y);
					}
				}
			}
			element.style.left = `${minX}px`;
			element.style.top = `${minY}px`;
			element.style.width = `${Math.max(24, maxX - minX)}px`;
			element.style.height = `${Math.max(24, maxY - minY)}px`;
			element.style.visibility =
				maxX < 0 || minX > size.width || maxY < 0 || minY > size.height
					? "hidden"
					: "visible";
		} else if (point) {
			const screen = project(point[0], point[1], point[2]);
			const placed = placeLabel(element, screen, size, insets);
			if (placed) {
				labels.push(placed);
			}
		}
	}
	settleLabels(labels, size, insets);
}

const NO_INSETS: SceneInsets = { bottom: 0, left: 0, right: 0, top: 0 };

/** The room a label keeps on each side: the stage gutter, or the HUD's inset. */
function labelBounds(insets: SceneInsets): SceneInsets {
	return {
		bottom: Math.max(LABEL_MARGIN, insets.bottom),
		left: Math.max(LABEL_MARGIN, insets.left),
		right: Math.max(LABEL_MARGIN, insets.right),
		top: Math.max(LABEL_MARGIN, insets.top),
	};
}

export interface PlacedLabel {
	/**
	 * A life bubble that may hang on the other side (the kit's `auto` side):
	 * its element, and the label's box with the bubble hung left instead.
	 */
	bubble?: { element: HTMLElement; left: { width: number; x: number } };
	element: HTMLElement;
	height: number;
	/** A name tag lifts up past what it covers; a sign slides along. */
	mode: "lift" | "slide";
	/** Held in place: the selected building's tag. */
	movable: boolean;
	/** The plate's own width, without a bubble's reach (a queue plate's slide). */
	plateWidth?: number;
	/**
	 * Higher settles first and wins a collision: alarms (8), queue plates (7), act
	 * props and tags with a bubble (6, never hidden), next steps and limits
	 * (5), other act words (4), a hovered tag (4), City Hall (3), district
	 * signs (2), then the other name tags (0).
	 */
	rank: number;
	/** Looks a little farther for room before hiding (a district sign with acts). */
	wide?: boolean;
	width: number;
	/** Left edge and top edge, in stage pixels. */
	x: number;
	y: number;
	/** A queue plate or the tray (`data-you-spot`): 8 px from its kind. */
	youSpot?: boolean;
}

/** The space kept between two labels. */
const LABEL_GAP = 4;

function overlaps(a: PlacedLabel, b: PlacedLabel): boolean {
	// Queue plates and the tray keep a wider gap (the you-spot spacing).
	const gap = a.youSpot && b.youSpot ? QUEUE_GAP : LABEL_GAP;
	return (
		a.x < b.x + b.width + gap &&
		b.x < a.x + a.width + gap &&
		a.y < b.y + b.height + gap &&
		b.y < a.y + a.height + gap
	);
}

/** The places a label may try, in order, from where it was projected. */
function candidates(label: PlacedLabel): { x: number; y: number }[] {
	const step = label.height + LABEL_GAP + 1;
	if (label.youSpot) {
		// A queue plate stays by its slot: a small slide radius (up to a row
		// and a half up or down, half a plate aside), nearest first.
		const spots = [{ x: label.x, y: label.y }];
		for (const dy of [0.5, 1, 1.5]) {
			for (const dx of [0, -0.5, 0.5]) {
				// By the plate's own width: a bubble's reach would slide it
				// far from its slot.
				const width = label.plateWidth ?? label.width;
				spots.push(
					{ x: label.x + dx * width, y: label.y - dy * step },
					{ x: label.x + dx * width, y: label.y + dy * step }
				);
			}
		}
		return spots;
	}
	if (label.rank >= SIGN_RANK || label.wide) {
		// An act prop, a next step, a limit or a wide sign looks nearby only
		// (about one label width, two rows): it never moves onto another lot.
		const side = (label.width + LABEL_GAP) / 2;
		const spots = [{ x: label.x, y: label.y }];
		for (let ring = 1; ring <= 2; ring++) {
			// Up and aside only: below a building stand its folk, whose pose an
			// act prop must not cover.
			for (const [dx, dy] of [
				[0, -1],
				[1, 0],
				[1, -1],
				[-1, -1],
				[-1, 0],
			] as const) {
				spots.push({
					x: label.x + dx * ring * side,
					y: label.y + dy * ring * step,
				});
			}
		}
		return spots;
	}
	if (label.mode === "lift") {
		return [0, 1, 2, 3].map((index) => ({
			x: label.x,
			y: label.y - index * step,
		}));
	}
	const side = label.width / 2 + LABEL_GAP;
	return [
		{ x: label.x, y: label.y },
		{ x: label.x, y: label.y + step },
		{ x: label.x - side, y: label.y + step / 2 },
		{ x: label.x + side, y: label.y + step / 2 },
		{ x: label.x, y: label.y - step },
	];
}

/**
 * Keeps labels from stacking, in screen space after projection, inside the
 * stage less the HUD's insets. Labels settle by rank (see `PlacedLabel`),
 * then front to back. A label whose bubble may flip first tries its own
 * place with the bubble on the left; then each tries a few nearby places
 * (a queue plate within a row and a half of its slot, an act prop up or
 * aside by at most one label width or two rows, never down onto the folk;
 * a tag lifts, a sign slides) and takes the first clear of everything
 * settled. A crowded queue stacks its plates 8 px apart. An act prop with
 * no clear place keeps its own; any other label is hidden until the camera
 * moves, and its building or district stays reachable from the desk.
 */
export function settleLabels(
	labels: PlacedLabel[],
	stage: { height: number; width: number },
	insets: SceneInsets = NO_INSETS
): void {
	const bounds = labelBounds(insets);
	const settled: PlacedLabel[] = labels.filter((label) => !label.movable);
	const queue = labels
		.filter((label) => label.movable)
		// By rank; the queue in slot order (top first), the rest front to back.
		.sort(
			(a, b) =>
				b.rank - a.rank || (a.youSpot && b.youSpot ? a.y - b.y : b.y - a.y)
		);
	for (const label of queue) {
		const origin = { x: label.x, y: label.y };
		const fits = (place: { x: number; y: number }, box: PlacedLabel) => {
			if (
				place.y < bounds.top ||
				place.x < bounds.left ||
				place.x + box.width > stage.width - bounds.right ||
				place.y + box.height > stage.height - bounds.bottom
			) {
				return false;
			}
			const moved = { ...box, ...place };
			return !settled.some((other) => overlaps(moved, other));
		};
		// A bubble that may flip tries its own place with the bubble on the
		// left before the label moves at all.
		if (label.bubble && !fits(origin, label)) {
			const left = { ...label, ...label.bubble.left };
			if (fits({ x: left.x, y: left.y }, left)) {
				label.bubble.element.dataset.side = "left";
				label.x = left.x;
				label.width = left.width;
				settled.push(label);
				continue;
			}
		}
		let spot = candidates(label).find((place) => fits(place, label));
		if (!spot && label.youSpot) {
			// A crowded queue (a small stage) stacks: each plate hangs below
			// what it would cover, 8 px clear, if that stays inside the stage
			// less the HUD's insets.
			let y = label.y;
			for (const other of [...settled].sort((a, b) => a.y - b.y)) {
				const sideBySide =
					label.x < other.x + other.width + QUEUE_GAP &&
					other.x < label.x + label.width + QUEUE_GAP;
				if (
					sideBySide &&
					y < other.y + other.height + QUEUE_GAP &&
					other.y < y + label.height + QUEUE_GAP
				) {
					y = other.y + other.height + QUEUE_GAP;
				}
			}
			if (y + label.height <= stage.height - bounds.bottom) {
				spot = { x: label.x, y };
			} else {
				// Below would reach under the HUD: stack upward instead.
				let up = label.y;
				for (const other of [...settled].sort((a, b) => b.y - a.y)) {
					const sideBySide =
						label.x < other.x + other.width + QUEUE_GAP &&
						other.x < label.x + label.width + QUEUE_GAP;
					if (
						sideBySide &&
						up < other.y + other.height + QUEUE_GAP &&
						other.y < up + label.height + QUEUE_GAP
					) {
						up = other.y - label.height - QUEUE_GAP;
					}
				}
				if (up >= bounds.top) {
					spot = { x: label.x, y: up };
				}
			}
		}
		if (!spot) {
			// An act prop is a Tab target: it keeps its place rather than hide.
			if (label.rank >= EXEMPT_RANK) {
				settled.push(label);
				continue;
			}
			label.element.style.visibility = "hidden";
			continue;
		}
		label.x = spot.x;
		label.y = spot.y;
		if (spot.x !== origin.x) {
			label.element.style.left = `${Number.parseFloat(label.element.style.left) + spot.x - origin.x}px`;
		}
		if (spot.y !== origin.y) {
			label.element.style.top = `${Number.parseFloat(label.element.style.top) + spot.y - origin.y}px`;
		}
		settled.push(label);
	}
}

/** Labels at this rank or above are act props: always placed, never hidden. */
const EXEMPT_RANK = 6;

/** Labels at this rank or above look nearby for room before giving way. */
const SIGN_RANK = 5;

/** The space kept between two you-spot labels (queue plates, the tray). */
const QUEUE_GAP = 8;

/** The gutter a label keeps from the stage edge. */
const LABEL_MARGIN = 8;

/**
 * Places a point label (centred on its point, or hung above it when
 * `data-hang="above"`) and keeps it whole inside the stage: a label whose
 * point is on the stage is nudged in from the edge, one whose point is off
 * it is hidden, so nothing is clipped and nothing leaks past the panel.
 */
function placeLabel(
	element: HTMLElement,
	screen: { x: number; y: number },
	size: { height: number; width: number },
	insets: SceneInsets = NO_INSETS
): PlacedLabel | null {
	const onStage =
		screen.x >= 0 &&
		screen.x <= size.width &&
		screen.y >= 0 &&
		screen.y <= size.height;
	// An act prop is never hidden while its point is in view between the
	// HUD's insets; panned or zoomed away it hides rather than pile up under
	// the HUD (the ask queue and the building buttons stay the keyboard path).
	const exempt = Number(element.dataset.rank ?? 0) >= EXEMPT_RANK;
	const inView =
		screen.x >= insets.left &&
		screen.x <= size.width - insets.right &&
		screen.y >= insets.top &&
		screen.y <= size.height - insets.bottom;
	if (exempt ? !inView : !onStage) {
		element.style.visibility = "hidden";
		return null;
	}
	const bounds = labelBounds(exempt ? insets : NO_INSETS);
	const width = element.offsetWidth;
	const height = element.offsetHeight;
	const above = element.dataset.hang === "above";
	const halfWidth = width / 2;
	// A life bubble hangs above and right of its tag, outside the tag's box:
	// it counts toward the room the label takes and stays inside the stage.
	const bubble = element.querySelector<HTMLElement>("[data-life-bubble]");
	const reachRight = bubble
		? Math.max(halfWidth, BUBBLE_SHIFT + bubble.offsetWidth)
		: halfWidth;
	const reachUp = bubble ? bubble.offsetHeight + BUBBLE_RISE : 0;
	const x = clamp(screen.x, [
		bounds.left + halfWidth,
		Math.max(bounds.left + halfWidth, size.width - bounds.right - reachRight),
	]);
	// The label's own transform hangs it above, or centres it on, the point.
	const lift = above ? height : height / 2;
	const y = clamp(screen.y, [
		bounds.top + lift + reachUp,
		Math.max(
			bounds.top + lift + reachUp,
			size.height - bounds.bottom - height + lift
		),
	]);
	element.style.left = `${x}px`;
	element.style.top = `${y}px`;
	element.style.visibility = "visible";
	// A tag faded out on a small stage takes no room.
	if (element.dataset.shown === "false") {
		return null;
	}
	const reachLeft = bubble
		? Math.max(halfWidth, BUBBLE_SHIFT + bubble.offsetWidth)
		: halfWidth;
	const flips = bubble?.dataset.bubbleAuto !== undefined;
	if (bubble && flips) {
		bubble.dataset.side = "right";
	}
	return {
		bubble:
			bubble && flips
				? {
						element: bubble,
						left: { width: reachLeft + halfWidth, x: x - reachLeft },
					}
				: undefined,
		element,
		height: height + reachUp,
		mode: above ? "lift" : "slide",
		movable: element.dataset.fixed !== "true",
		rank: Number(element.dataset.rank ?? 0),
		wide: element.dataset.wide === "true",
		youSpot: element.querySelector("[data-you-spot]") !== null,
		plateWidth: width,
		width: halfWidth + reachRight,
		x: x - halfWidth,
		y: y - lift - reachUp,
	};
}

/** A life bubble's offset from its tag (game3d-life.tsx: 50% + 16px, 6px up). */
const BUBBLE_SHIFT = 16;
const BUBBLE_RISE = 6;

/** The slab of earth, the grass, the roads and their lane marks. */
/**
 * The island the town stands on (the game kit's: a rounded lawn with an
 * earth cliff in the sea), its streets laid in warm paving, and swaying
 * grass on the open lawn and inside the parks and district greens.
 */
function Ground({
	palette,
	quality,
	reduced,
	shape,
	theme,
	town,
}: {
	palette: TownPalette;
	quality: RenderQuality;
	reduced: boolean;
	shape: IslandShape;
	theme: Scene3dTheme;
	town: Town;
}) {
	const { reach } = town.grid;
	const lines = useMemo(() => roadLines(town.grid), [town.grid]);
	const paint = useMemo(() => {
		const paving = linearRgb(palette.asphalt);
		const span = reach + ROAD / 2;
		return (x: number, z: number) => {
			if (Math.abs(x) > span || Math.abs(z) > span) {
				return null;
			}
			const onRoad = lines.some(
				(line) => Math.abs(x - line) < LANE / 2 || Math.abs(z - line) < LANE / 2
			);
			return onRoad ? paving : null;
		};
	}, [lines, palette.asphalt, reach]);
	// Lawn at ground level: everywhere but the streets and the blocks.
	const blocks = useMemo(
		() => [
			...town.districts.map((district) => [district.x, district.z] as const),
			...town.parks.map((park) => [park.x, park.z] as const),
			[0, 0] as const,
		],
		[town]
	);
	const outer = town.grid.inner / 2 + SIDEWALK;
	const onBlock = useMemo(
		() => (x: number, z: number, margin: number) =>
			blocks.some(
				([bx, bz]) =>
					Math.abs(x - bx) < outer + margin && Math.abs(z - bz) < outer + margin
			),
		[blocks, outer]
	);
	const avoidLow = useMemo(
		() => (x: number, z: number) => paint(x, z) !== null || onBlock(x, z, 0.1),
		[onBlock, paint]
	);
	// Lawn inside the parks and the district greens, clear of every lot.
	const greens = useMemo(
		() => [
			...town.parks.map((park) => ({ pond: park.pond, x: park.x, z: park.z })),
			...town.districts.map((district) => ({
				pond: null,
				x: district.x,
				z: district.z,
			})),
		],
		[town]
	);
	const lots = useMemo(
		() => [
			...town.buildings.map((building) => building.lot),
			...town.districts.flatMap((district) => [
				...district.fillers.map((filler) => filler.lot),
			]),
			...town.parks.flatMap((park) => park.homes.map((home) => home.lot)),
		],
		[town]
	);
	const inner = town.grid.inner / 2 - 0.1;
	const avoidHigh = useMemo(
		() => (x: number, z: number) =>
			!greens.some(
				(green) =>
					Math.abs(x - green.x) < inner &&
					Math.abs(z - green.z) < inner &&
					!(green.pond && Math.hypot(x - green.pond.x, z - green.pond.z) < 1.15)
			) ||
			lots.some(
				(lot) =>
					Math.abs(x - lot.x) < LOT * 0.42 && Math.abs(z - lot.z) < LOT * 0.42
			),
		[greens, inner, lots]
	);
	// Wildflower patches on the greens, clear of every lot and pond.
	const flowers = useMemo<FlowerPatch[]>(() => {
		const patches: FlowerPatch[] = [];
		for (const [index, green] of greens.entries()) {
			for (let patch = 0; patch < 7; patch++) {
				const x =
					green.x + (((index * 7 + patch * 13) % 11) / 11 - 0.5) * inner * 1.8;
				const z =
					green.z + (((index * 5 + patch * 7) % 13) / 13 - 0.5) * inner * 1.8;
				if (!avoidHigh(x, z)) {
					patches.push({
						at: [x, 0, z],
						x: index * 31 + patch,
						y: patch * 17 + index,
					});
				}
			}
		}
		return patches;
	}, [avoidHigh, greens, inner]);
	return (
		<group>
			<IsoIsland paint={paint} shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoidLow}
				quality={quality}
				reducedMotion={reduced}
				shape={shape}
				theme={theme}
			/>
			{/* Taller tufts on the greens, so the lawns read lush from afar. */}
			<group position={[0, BLOCK_TOP, 0]} scale={[1, 1.7, 1]}>
				<IslandGrass
					avoid={avoidHigh}
					quality={quality}
					reducedMotion={reduced}
					shape={shape}
					theme={theme}
				/>
			</group>
			<group position={[0, BLOCK_TOP, 0]}>
				<FlowerClusters patches={flowers} />
			</group>
			<Lanes night={theme.night} town={town} />
		</group>
	);
}

/** The paved lanes run down the middle of each street, verges either side. */
const LANE = 0.95;

/**
 * Soft paved-stone lanes: two staggered rows of rounded paving stones down
 * every street, and a flower of stones at every junction.
 */
function Lanes({ night, town }: { night: boolean; town: Town }) {
	const { roundels, stones } = useMemo(() => {
		const lines = roadLines(town.grid);
		const span = town.grid.reach + ROAD / 2;
		const list: Vec3[] = [];
		const near = (at: number) =>
			lines.some((cross) => Math.abs(cross - at) < LANE * 0.75);
		for (const line of lines) {
			for (let at = -span + 0.25; at <= span - 0.25; at += 0.46) {
				if (near(at)) {
					continue;
				}
				for (const side of [-1, 1]) {
					const across = line + side * 0.22;
					const shift = side > 0 ? 0.23 : 0;
					list.push([at + shift, 0.012, across]);
					list.push([across, 0.012, at + shift]);
				}
			}
		}
		const petals: Vec3[] = [];
		for (const x of lines) {
			for (const z of lines) {
				petals.push([x, 0.014, z]);
				for (let petal = 0; petal < 6; petal++) {
					const angle = (petal / 6) * Math.PI * 2;
					petals.push([
						x + Math.cos(angle) * 0.42,
						0.012,
						z + Math.sin(angle) * 0.42,
					]);
				}
			}
		}
		return { roundels: petals, stones: list };
	}, [town.grid]);
	return (
		<group>
			<PathStones night={night} size={0.4} stones={stones} />
			<PathStones night={night} size={0.36} stones={roundels} />
		</group>
	);
}

/** The top of a block's lawn, above the street. */
const BLOCK_TOP = 0.185;

/** A block: a raised sidewalk ring and the ground inside it. */
function Block({
	color,
	inner,
	palette,
	x,
	z,
}: {
	color: string;
	inner: number;
	palette: TownPalette;
	x: number;
	z: number;
}) {
	const outer = inner + SIDEWALK * 2;
	return (
		<group position={[x, 0, z]}>
			<TownMesh
				castShadow={false}
				color={palette.sidewalk}
				ink={0}
				position={[0, 0.08, 0]}
			>
				<RoundedBoxGeometry
					args={[outer, 0.16, outer]}
					radius={0.07}
					smoothness={3}
				/>
			</TownMesh>
			<mesh position={[0, 0.17, 0]} receiveShadow>
				<RoundedBoxGeometry
					args={[inner, 0.03, inner]}
					radius={0.012}
					smoothness={2}
				/>
				<ToonMaterial color={color} curve={false} />
			</mesh>
		</group>
	);
}

/**
 * A district block: its ground tint (or the data view's colour), a plot
 * under every agent's building (the houses that fill in get none), zoning rails round the empty ones, and a sign
 * post at the front corner where the DOM name sign hangs.
 */
function DistrictBlock({
	dataView,
	district,
	inner,
	palette,
}: {
	dataView: TownDataView;
	district: TownDistrict;
	inner: number;
	palette: TownPalette;
}) {
	const tint = districtColor(palette, dataView, district);
	const pad = mixHex(tint, palette.lotPad, dataView === "none" ? 0.55 : 0.25);
	const pads = useMemo(() => {
		const items: InstanceSpec[] = [];
		for (const building of district.buildings) {
			items.push({ position: [building.lot.x, PAD_Y - 0.01, building.lot.z] });
		}
		return items;
	}, [district]);
	const rails = useMemo(() => zoneRails(district.emptyLots), [district]);
	return (
		<group>
			<Block
				color={tint}
				inner={inner}
				palette={palette}
				x={district.x}
				z={district.z}
			/>
			<InstancedParts items={pads} receiveShadow>
				<boxGeometry args={[LOT - 0.22, 0.02, LOT - 0.22]} />
				<ToonMaterial color={pad} curve={false} />
			</InstancedParts>
			<InstancedParts items={rails}>
				<boxGeometry args={[1, 0.02, 0.05]} />
				<meshBasicMaterial color={palette.zoneLine} />
			</InstancedParts>
		</group>
	);
}

/** City Hall's paved square in the centre block. */
function Plaza({ inner, palette }: { inner: number; palette: TownPalette }) {
	return (
		<Block
			color={mixHex(palette.sidewalk, palette.lotPad, 0.5)}
			inner={inner}
			palette={palette}
			x={0}
			z={0}
		/>
	);
}

/** A pond in each park (the kit's, with stones and lily pads). */
function Ponds({ night, town }: { night: boolean; town: Town }) {
	return (
		<group>
			{town.parks.map((park) =>
				park.pond ? (
					<Pond
						at={[park.pond.x, BLOCK_TOP, park.pond.z]}
						key={park.id}
						night={night}
						radius={0.9}
					/>
				) : null
			)}
		</group>
	);
}

/** Trees: in the parks, on the plaza corners and around the town edge. */
function Trees({ theme, town }: { theme: Scene3dTheme; town: Town }) {
	const trees = useMemo(() => {
		const planted: PlantedTree[] = [];
		const add = (x: number, z: number, seed: string, y = BLOCK_TOP) => {
			const hash = hashId(seed);
			let kind: PlantedTree["kind"] = "fruit";
			if (hash % 5 === 0) {
				kind = "blossom";
			} else if (hash % 3 === 0) {
				kind = "cedar";
			}
			planted.push({
				at: [x, y, z],
				kind,
				scale: 0.62 + (hash % 7) * 0.03,
				seed: hash % 1000,
			});
		};
		const span = town.grid.inner / 2 - 0.55;
		for (const park of town.parks) {
			const blocked = (x: number, z: number) =>
				(park.pond !== null &&
					Math.hypot(x - park.pond.x, z - park.pond.z) < 1.35) ||
				park.homes.some(
					(home) =>
						Math.abs(x - home.lot.x) < LOT * 0.55 &&
						Math.abs(z - home.lot.z) < LOT * 0.55
				);
			// A grove is planted densely; other parks leave clearings.
			const sparse = park.variant === "grove" ? 6 : 4;
			for (let row = 0; row < 4; row += 1) {
				for (let col = 0; col < 4; col += 1) {
					const seed = `${park.id}:${row}:${col}`;
					const jitter = hashId(seed);
					const x =
						park.x - span + (col * span * 2) / 3 + ((jitter % 5) - 2) * 0.08;
					const z =
						park.z - span + (row * span * 2) / 3 + ((jitter % 7) - 3) * 0.06;
					if (blocked(x, z) || jitter % sparse === 0) {
						continue;
					}
					add(x, z, seed);
				}
			}
		}
		for (const [index, corner] of [
			[-1, -1],
			[1, -1],
			[-1, 1],
			[1, 1],
		].entries()) {
			add(
				(corner[0] ?? 0) * span,
				(corner[1] ?? 0) * span,
				`plaza:${index.toString()}`
			);
		}
		const edge = town.grid.reach + ROAD / 2 + 0.85;
		for (let at = -edge; at <= edge; at += 1.3) {
			for (const side of [-1, 1]) {
				for (const axis of ["x", "z"] as const) {
					const seed = `edge:${axis}:${side}:${at.toFixed(1)}`;
					if (hashId(seed) % 3 === 0) {
						continue;
					}
					const x = axis === "x" ? at : side * edge;
					const z = axis === "x" ? side * edge : at;
					add(x, z, seed, 0);
				}
			}
		}
		return planted;
	}, [town]);
	return <TreeGrove theme={theme} trees={trees} />;
}

/** A street lamp at every crossing (the kit's); lit at night. */
function Lamps({ night, town }: { night: boolean; town: Town }) {
	const lamps = useMemo(() => {
		const list: Vec3[] = [];
		const lines = roadLines(town.grid);
		const offset = ROAD / 2 + SIDEWALK * 0.5;
		for (const x of lines) {
			for (const z of lines) {
				const lampX = x + offset;
				const lampZ = z + offset;
				if (
					Math.abs(lampX) > town.grid.reach ||
					Math.abs(lampZ) > town.grid.reach
				) {
					continue;
				}
				list.push([lampX, 0.16, lampZ]);
			}
		}
		return list;
	}, [town.grid]);
	return <LampPosts lamps={lamps} night={night} />;
}

/** Townsfolk's tools per step kind (the town row: hammer, crane, blueprint). */
const TOWN_TOOLS: Partial<Record<string, VillagerTool>> = {
	edit: "hammer",
	plan: "clipboard",
	read: "clipboard",
	run: "wrench",
	write: "hammer",
};

/** Waypoints scaled into the townsfolk's (scaled) frame. */
function scaledPaths(paths: LifePaths, factor: number): LifePaths {
	const points: Record<string, Vec3> = {};
	for (const [id, [x, y, z]] of Object.entries(paths.points)) {
		points[id] = [x * factor, y * factor, z * factor];
	}
	return { links: paths.links, points };
}

/** Townsfolk are drawn at half a villager's size, to the buildings' scale. */
const FOLK_SCALE = 0.72;

/**
 * The agents as townsfolk (the kit's villagers): one beside each agent's
 * building. Busy agents work at their lot with a hammer, agents waiting on
 * you wave, failed runs slump by the door, and the rest stroll the
 * sidewalk round their block. The building stays each agent's control.
 */
function Townsfolk({
	actScene,
	night,
	reduced,
	town,
}: {
	actScene: TownActScene | null;
	night: boolean;
	reduced: boolean;
	town: Town;
}) {
	const ids = useMemo(
		() => town.buildings.map((building) => building.agent.id),
		[town.buildings]
	);
	const { looks } = useVillagerLooks(ids, night);
	const folk = useMemo<VillagerSpec[]>(() => {
		const list: VillagerSpec[] = [];
		const ring = town.grid.inner / 2 + SIDEWALK / 2;
		for (const [index, building] of town.buildings.entries()) {
			const base = looks.get(building.agent.id);
			const district = town.districts.find(
				(item) => item.id === building.districtId
			);
			if (!base) {
				continue;
			}
			let pose: VillagerPose = "idle";
			let tool: VillagerTool | undefined;
			if (building.alert) {
				pose = "failed";
			} else if (building.working) {
				pose = "working";
				tool = "hammer";
			} else if (building.replied) {
				pose = "needs-you";
			}
			const scaled = (
				x: number,
				y: number,
				z: number
			): [number, number, number] => [
				x / FOLK_SCALE,
				y / FOLK_SCALE,
				z / FOLK_SCALE,
			];
			const door = scaled(
				building.lot.x + LOT * 0.4,
				PAD_Y,
				building.lot.z + LOT * 0.4
			);
			const strolls = pose === "idle" && district !== undefined;
			const walk =
				strolls && district
					? (
							[
								[1, 1],
								[-1, 1],
								[-1, -1],
								[1, -1],
							] as const
						).map(([sx, sz]) => {
							// Each stroller starts at a different corner.
							const turn = index % 4;
							const flip = turn % 2 ? -1 : 1;
							return scaled(
								district.x + sx * ring * flip,
								0.16,
								district.z + sz * ring * (turn > 1 ? -1 : 1)
							);
						})
					: undefined;
			list.push({
				facing: pose === "working" ? -Math.PI / 2 : FACE_CAMERA,
				id: building.agent.id,
				label: building.agent.name,
				looks: { ...base, tool },
				name: building.agent.name,
				pose,
				position: walk?.[0] ?? door,
				walk,
			});
		}
		return list;
	}, [looks, town]);
	// With acts, each villager acts out its agent's act on the kit: walks to
	// City Hall's steps to ask, to its inbox to deliver, works at its lot.
	const acted = useMemo(() => {
		if (!actScene) {
			return null;
		}
		const paths = scaledPaths(townPaths(town), 1 / FOLK_SCALE);
		const list: VillagerSpec[] = [];
		for (const spec of folk) {
			const act = actScene.acts.get(spec.id);
			const door = paths.points[`door-${spec.id}`];
			if (!(act && door)) {
				continue;
			}
			list.push({
				...spec,
				life: actLife(
					act,
					{
						paths,
						slot: slotOf(actScene.slots, act.agentId),
						station: `door-${spec.id}`,
						stationFacing: act.act === "working" ? -Math.PI / 2 : undefined,
					},
					TOWN_SKIN,
					{ reduced }
				),
				looks: {
					...spec.looks,
					tool:
						act.act === "working" && !act.stalled
							? (toolForActivity(act.carry, TOWN_TOOLS) ?? "hammer")
							: undefined,
				},
				pose: "idle",
				position: door,
				walk: undefined,
			});
			// The agent's helpers work on its scaffold beside it.
			list.push(
				...apprenticeSpecs({
					agentId: act.agentId,
					helpers: act.helpers,
					looks: spec.looks,
					station: [door[0] - 0.5, door[1], door[2] + 0.4],
				})
			);
		}
		return { list, paths };
	}, [actScene, folk, reduced, town]);
	// Where each agent's townsperson stands (its queue slot while it asks,
	// else its door), as the kit's figure probes: the kit draws its own only
	// on villager plates, and the building is the town's per-agent target.
	const figures = useMemo(() => {
		if (!actScene) {
			return [];
		}
		const paths = townPaths(town);
		return [...actScene.acts.values()].flatMap((act) => {
			const slot =
				act.act === "asking" ? slotOf(actScene.slots, act.agentId) : null;
			const feet =
				(slot ? paths.points[slot] : null) ??
				paths.points[`door-${act.agentId}`];
			return feet ? [{ agentId: act.agentId, feet }] : [];
		});
	}, [actScene, town]);
	return (
		<>
			<group scale={FOLK_SCALE}>
				<Villagers
					paths={acted?.paths}
					plates={false}
					reducedMotion={reduced}
					villagers={acted?.list ?? folk}
				/>
			</group>
			{figures.map(({ agentId, feet }) => (
				<group key={agentId}>
					<FigureProbe
						agentId={agentId}
						at={[feet[0], feet[1] + FOLK_TALL, feet[2]]}
						edge="head"
					/>
					<FigureProbe agentId={agentId} at={feet} edge="feet" />
				</group>
			))}
		</>
	);
}

/** A townsperson's head above its feet (world units, at the folk's scale). */
const FOLK_TALL = 1.35 * FOLK_SCALE;

/**
 * A hidden, zero-size marker at a townsperson's head or feet (the kit's
 * `data-act-figure` / `data-figure-edge` contract), for checks that no
 * prop covers the figure.
 */
function FigureProbe({
	agentId,
	at,
	edge,
}: {
	agentId: string;
	at: Vec3;
	edge: "feet" | "head";
}) {
	return (
		<Html position={at}>
			<span
				aria-hidden="true"
				className="pointer-events-none block size-0"
				data-act-figure={agentId}
				data-figure-edge={edge}
			/>
		</Html>
	);
}

interface Car {
	axis: "x" | "z";
	color: string;
	direction: 1 | -1;
	line: number;
	phase: number;
	speed: number;
}

/** Traffic: one car per lane slot, more agents at work, more cars. */
function Cars({
	count,
	palette,
	town,
}: {
	count: number;
	palette: TownPalette;
	town: Town;
}) {
	const bodies = useRef<InstancedMesh>(null);
	const cabins = useRef<InstancedMesh>(null);
	const sim = useSim();
	const span = town.grid.reach * 2;
	const cars = useMemo(() => {
		const lines = roadLines(town.grid);
		const list: Car[] = [];
		for (let index = 0; index < count; index += 1) {
			const hash = hashId(`car:${index}`);
			list.push({
				axis: index % 2 === 0 ? "x" : "z",
				color: pickById(palette.cars, `car:${index}`) ?? palette.asphalt,
				direction: hash % 2 === 0 ? 1 : -1,
				line: lines[hash % lines.length] ?? 0,
				phase: (hash % 1000) / 1000,
				speed: 0.09 + (hash % 5) * 0.012,
			});
		}
		return list;
	}, [count, palette, town.grid]);

	useLayoutEffect(() => {
		const mesh = bodies.current;
		if (!mesh) {
			return;
		}
		const kit = mathKit(mesh);
		for (const [index, car] of cars.entries()) {
			if (kit.color) {
				mesh.setColorAt(index, kit.color.set(car.color));
			}
		}
		if (mesh.instanceColor) {
			mesh.instanceColor.needsUpdate = true;
		}
	}, [cars]);

	useFrame(() => {
		const body = bodies.current;
		const cabin = cabins.current;
		if (!(body && cabin)) {
			return;
		}
		const { euler, matrix, position, quaternion, scale } = mathKit(body);
		scale.set(1, 1, 1);
		for (const [index, car] of cars.entries()) {
			const travelled = (car.phase + sim.current.time * car.speed) % 1;
			const along = (travelled * span - span / 2) * car.direction;
			const turn = car.direction === 1 ? 0 : Math.PI;
			if (car.axis === "x") {
				position.set(along, 0.13, car.line + car.direction * 0.36);
				euler.set(0, turn, 0);
			} else {
				position.set(car.line - car.direction * 0.36, 0.13, along);
				euler.set(0, turn - Math.PI / 2, 0);
			}
			quaternion.setFromEuler(euler);
			matrix.compose(position, quaternion, scale);
			body.setMatrixAt(index, matrix);
			position.y += 0.13;
			matrix.compose(position, quaternion, scale);
			cabin.setMatrixAt(index, matrix);
		}
		body.instanceMatrix.needsUpdate = true;
		cabin.instanceMatrix.needsUpdate = true;
	});
	if (cars.length === 0) {
		return null;
	}
	return (
		<group>
			<instancedMesh
				args={[undefined, undefined, cars.length]}
				castShadow
				key={`body-${cars.length}`}
				ref={bodies}
			>
				<boxGeometry args={[0.5, 0.16, 0.26]} />
				<ToonMaterial curve={false} />
			</instancedMesh>
			<instancedMesh
				args={[undefined, undefined, cars.length]}
				key={`cabin-${cars.length}`}
				ref={cabins}
			>
				<boxGeometry args={[0.26, 0.13, 0.22]} />
				<ToonMaterial color={palette.windowOff} curve={false} />
			</instancedMesh>
		</group>
	);
}
