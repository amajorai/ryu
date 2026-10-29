/* eslint-disable react/no-unknown-property */
import { OrbitControls } from "@react-three/drei";
import {
	Canvas,
	type ThreeEvent,
	useFrame,
	useThree,
} from "@react-three/fiber";
import {
	type ComponentRef,
	type ReactNode,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
} from "react";
import type {
	Group,
	Mesh,
	PerspectiveCamera,
	ShaderMaterial,
	Vector3,
} from "three";
import { BACK_SIDE } from "./game3d-math.ts";
import {
	type AgentSwatch,
	agentSwatches,
	type Scene3dTheme,
	swatchOf,
	TOON_LIGHT,
} from "./game3d-palette.ts";
import { sceneTheme } from "./game3d-stage.tsx";
import { type MemberLooks, useVillagerLooks } from "./game3d-villager.tsx";
import {
	PlanetsActLayer,
	type PlanetsActView,
	stationStripBox,
} from "./planets-acts.tsx";
import {
	type Box,
	COLUMN_BODY_SCALE,
	COLUMN_ELEVATION,
	columnFrame,
	columnRoom,
	FOV,
	focusFrame,
	type HudLayout,
	type Moon,
	moonOffset,
	OVERVIEW_AZIMUTH,
	OVERVIEW_BODY_SCALE,
	OVERVIEW_INTRO_SCALE,
	orbitAngle,
	orbitPoint,
	overlapArea,
	overviewElevation,
	overviewFrame,
	overviewReach,
	type Planet,
	type PlanetSystem,
	planetVariant,
	SUN_RADIUS,
} from "./planets-model.ts";
import { moonKey, type OverlayRegistry, STAR_ID } from "./planets-overlay.tsx";
import {
	mixRgb,
	type PlanetLook,
	type PlanetsPalette,
	planetLook,
	planetLookIn,
	type Rgb,
	teamColor,
	unitRgb,
} from "./planets-palette.ts";
import {
	discBox,
	moonSides,
	mostlyUnder,
	type Placement,
	placeLabel,
	type Side,
} from "./planets-placement.ts";
import {
	BAND_FRAGMENT,
	BAND_VERTEX,
	BILLBOARD_VERTEX,
	DISC_FRAGMENT,
	DISC_VERTEX,
	GLOW_FRAGMENT,
	HALO_FRAGMENT,
	LINE_FRAGMENT,
	LINE_VERTEX,
	MOON_FRAGMENT,
	PLANET_FRAGMENT,
	RING_FRAGMENT,
	RING_VERTEX,
	STAR_FRAGMENT,
	STAR_VERTEX,
	SUN_FRAGMENT,
	SURFACE_VERTEX,
} from "./planets-shaders.ts";
import { PlanetsKitLight, PlanetTop, SunFace } from "./planets-world.tsx";

/**
 * The Planets scene (lazy-loaded): the star, planets on their orbits, moons,
 * starfield, and an orbit camera that flies to whatever is focused. All
 * motion is driven from one clock that freezes under reduced motion. The
 * DOM overlay (name plates and moon targets) is positioned from here, in the
 * same frame, so labels never trail their bodies.
 *
 * Runtime classes come from objects React Three Fiber created (`clone()`),
 * so the scene imports three for types only and shares R3F's copy.
 */

/** three's blending and side constants, without a runtime import of three. */
const NORMAL_BLENDING = 1;
const ADDITIVE_BLENDING = 2;
const DOUBLE_SIDE = 2;

/** Overview: looking from this azimuth (the elevation follows the aspect). */
const AZIMUTH = OVERVIEW_AZIMUTH;
const FOCUS_ELEVATION = 0.38;
/**
 * How far around from the star the camera sits when visiting a planet: the
 * first of these (with an elevation) that leaves every moon in sight.
 */
const FOCUS_VIEWS: readonly (readonly [number, number])[] = [
	[0.62, FOCUS_ELEVATION],
	[0.95, FOCUS_ELEVATION],
	[0.3, FOCUS_ELEVATION],
	[0.62, 0.62],
	[1.25, FOCUS_ELEVATION],
	[0.0, FOCUS_ELEVATION],
	[0.95, 0.62],
	[0.3, 0.62],
	[0.62, 0.16],
	[1.25, 0.62],
];
/** How quickly bodies ease between overview and true scale (per second). */
const SCALE_RATE = 3.2;
/** A visited planet: at least this many extents away, with room around it. */
const FOCUS_LIMITS = { margin: 1.5, minDistance: 8, minExtents: 3.2 } as const;
/** Visiting the star: looking down this far at the inner system. */
const STAR_ELEVATION = 0.55;
const FLIGHT_SECONDS = 1.35;
const INTRO_SECONDS = 1.1;
const ZOOM_SECONDS = 0.35;
/** Share of a flight after which the camera counts as landed (titles show). */
const LANDING = 0.8;
const MIN_DISTANCE = 3.2;
const ORBIT_SEGMENTS = 192;
/** Noise octaves for surfaces: fewer on software renderers. */
const LOW_DEFINES = { OCTAVES: 3 };
const HIGH_DEFINES = { OCTAVES: 5 };

type Controls = ComponentRef<typeof OrbitControls>;
type Vec3 = [number, number, number];

export interface CameraApi {
	overview: () => void;
	zoom: (factor: number) => void;
}

export interface PlanetsSceneProps {
	/**
	 * Whether frames are drawn (default true). Off while the host covers the
	 * interface with a page: nothing else stops the loop then.
	 */
	active?: boolean;
	/** The act layer (station, probes, planet signs), when the host sends asks. */
	acts?: PlanetsActView | null;
	cameraApi: RefObject<CameraApi | null>;
	/** A planet id, `STAR_ID`, or null for the overview. */
	focusId: string | null;
	/** The body the pointer (or keyboard focus) is on; it holds still. */
	hoverRef: RefObject<string | null>;
	/** Where the HUD sits over the scene: the picture is framed around it. */
	hud: HudLayout;
	onHover: (bodyId: string | null) => void;
	/** The first frame has been drawn (the loading placeholder can go). */
	onReady: () => void;
	onSelect: (bodyId: string) => void;
	/** Orbits' and moons' share of the stock speed (`ORBIT_PACE`); 1 by default. */
	orbitPace?: number;
	palette: PlanetsPalette;
	quality: "high" | "low";
	reduced: boolean;
	registry: RefObject<OverlayRegistry>;
	system: PlanetSystem;
}

/** Mutable simulation state shared by the frame callbacks. */
interface Sim {
	angles: Map<string, number>;
	/** Bodies' drawn scale: `OVERVIEW_BODY_SCALE` in the overview, 1 when visiting. */
	bodyScale: number;
	/** The camera is on its way somewhere (labels wait until it lands). */
	flying: boolean;
	moonClocks: Map<string, number>;
	moonGroups: Map<string, Group>;
	planetGroups: Map<string, Group>;
	positions: Map<string, Vec3>;
	time: number;
}

type UniformValues = Record<string, unknown>;
type Uniforms<T extends UniformValues> = { [K in keyof T]: { value: T[K] } };

/** A shader's uniforms, and a way to animate them on the live material. */
interface Shader<T extends UniformValues> {
	/** Reads a uniform as last set (or as given). */
	get: <K extends keyof T>(name: K) => T[K];
	/** Attach to the `<shaderMaterial>`. */
	ref: RefObject<ShaderMaterial | null>;
	/** Writes a uniform on the material (for the frame loop). */
	set: <K extends keyof T>(name: K, value: T[K]) => void;
	/** Pass as the material's `uniforms`. */
	uniforms: Uniforms<T>;
}

/**
 * Uniforms for one material. React Three Fiber copies the uniforms it is
 * given into the material's own objects, so animated values must be written
 * on the material itself (`set`), not on the object handed over. The object
 * is rebuilt (and so re-applied) only when the given values change, such as
 * after a theme switch.
 */
function useUniforms<T extends UniformValues>(values: T): Shader<T> {
	const ref = useRef<ShaderMaterial | null>(null);
	const cache = useRef<{ key: string; shader: Shader<T> } | null>(null);
	const key = JSON.stringify(values);
	if (cache.current?.key !== key) {
		const uniforms = {} as Uniforms<T>;
		for (const name of Object.keys(values) as (keyof T)[]) {
			uniforms[name] = { value: values[name] };
		}
		cache.current = {
			key,
			shader: {
				get: (name) => uniforms[name].value,
				ref,
				set: (name, value) => {
					uniforms[name].value = value;
					const live = ref.current?.uniforms[name as string];
					if (live) {
						live.value = value;
					}
				},
				uniforms,
			},
		};
	}
	return cache.current.shader;
}

function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Bodies' swollen overview scale: a portrait column swells them less. */
function overviewScale(system: PlanetSystem): number {
	return system.column ? COLUMN_BODY_SCALE : OVERVIEW_BODY_SCALE;
}

function direction(azimuth: number, elevation: number): Vec3 {
	return [
		Math.sin(azimuth) * Math.cos(elevation),
		Math.sin(elevation),
		Math.cos(azimuth) * Math.cos(elevation),
	];
}

export default function PlanetsScene(props: PlanetsSceneProps) {
	const { active = true, quality } = props;
	return (
		<Canvas
			camera={{ far: 3000, fov: FOV, near: 0.1, position: [0, 60, 80] }}
			dpr={quality === "high" ? [1, 2] : [1, 1]}
			flat
			frameloop={active ? "always" : "never"}
			gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
			style={{ inset: 0, position: "absolute" }}
		>
			<SystemContents {...props} />
		</Canvas>
	);
}

function SystemContents({
	acts = null,
	cameraApi,
	focusId,
	hud,
	hoverRef,
	onHover,
	onReady,
	onSelect,
	orbitPace = 1,
	palette,
	quality,
	reduced,
	registry,
	system,
}: PlanetsSceneProps) {
	const sim = useRef<Sim>({
		angles: new Map(),
		bodyScale: focusId === null ? overviewScale(system) : 1,
		flying: true,
		moonClocks: new Map(),
		moonGroups: new Map(),
		planetGroups: new Map(),
		positions: new Map(),
		time: 0,
	});
	const focusRef = useRef(focusId);
	focusRef.current = focusId;
	const night = palette.mode === "dark";
	const theme = sceneTheme(night);
	const planetIds = useMemo(
		() => system.planets.map((planet) => planet.id),
		[system.planets]
	);
	const { looks } = useVillagerLooks(planetIds, night);
	const swatches = useMemo(() => agentSwatches(planetIds), [planetIds]);

	// Planets keep their angle across snapshot updates; new ones start at phase.
	for (const planet of system.planets) {
		if (!sim.current.angles.has(planet.id)) {
			sim.current.angles.set(planet.id, orbitAngle(planet, 0));
		}
	}

	return (
		<>
			<PlanetsKitLight theme={theme} />
			<Starfield
				palette={palette}
				quality={quality}
				reduced={reduced}
				sim={sim}
			/>
			<Disc palette={palette} radius={system.systemRadius} />
			<Sun
				onHover={onHover}
				onSelect={onSelect}
				palette={palette}
				reduced={reduced}
				sim={sim}
			/>
			<group>
				{system.starMoons.map((moon) => (
					<MoonBody
						bodyId={STAR_ID}
						key={moonKey(STAR_ID, moon.threadId)}
						moon={moon}
						palette={palette}
						reduced={reduced}
						sim={sim}
					/>
				))}
			</group>
			{system.planets.map((planet) => (
				<OrbitLine
					color={
						planet.teamId
							? teamColor(
									palette,
									system.teams.find((team) => team.id === planet.teamId)
										?.colorIndex ?? 0
								)
							: palette.sky.orbit
					}
					emphasis={focusId === planet.id}
					key={`orbit-${planet.id}`}
					palette={palette}
					planet={planet}
					sim={sim}
					team={planet.teamId !== null}
				/>
			))}
			{system.planets.map((planet) => (
				<PlanetBody
					focused={focusId === planet.id}
					hoverRef={hoverRef}
					key={planet.id}
					look={planetLookIn(system, planet.id)}
					night={night}
					onHover={onHover}
					onSelect={onSelect}
					palette={palette}
					planet={planet}
					quality={quality}
					reduced={reduced}
					sim={sim}
					swatch={swatchOf(swatches, planet.id)}
					theme={theme}
					villager={looks.get(planet.id)}
				/>
			))}
			<SystemDriver
				focusRef={focusRef}
				hoverRef={hoverRef}
				pace={orbitPace}
				reduced={reduced}
				sim={sim}
				system={system}
			/>
			<CameraRig
				cameraApi={cameraApi}
				focusId={focusId}
				hud={hud}
				reduced={reduced}
				sim={sim}
				system={system}
			/>
			<OverlaySync
				focusRef={focusRef}
				hud={hud}
				registry={registry}
				sim={sim}
				station={Boolean(acts)}
				system={system}
			/>
			{acts ? (
				<PlanetsActLayer
					azimuth={AZIMUTH}
					reduced={reduced}
					sim={sim}
					system={system}
					view={acts}
				/>
			) : null}
			<FirstFrame onReady={onReady} />
		</>
	);
}

/**
 * Reports once the first frame is on screen: the frame callback runs just
 * before the canvas draws, so the report waits for the task after it (by
 * then the shaders have compiled and the picture is showing).
 */
function FirstFrame({ onReady }: { onReady: () => void }) {
	const reported = useRef(false);
	useFrame(() => {
		if (reported.current) {
			return;
		}
		reported.current = true;
		window.setTimeout(onReady, 0);
	});
	return null;
}

/** Advances the clock, orbits and moons, and places every body. */
function SystemDriver({
	focusRef,
	hoverRef,
	pace,
	reduced,
	sim,
	system,
}: {
	focusRef: RefObject<string | null>;
	hoverRef: RefObject<string | null>;
	pace: number;
	reduced: boolean;
	sim: RefObject<Sim>;
	system: PlanetSystem;
}) {
	useFrame((_, rawDelta) => {
		const state = sim.current;
		// Long frames (a backgrounded tab) never teleport the planets.
		const delta = reduced ? 0 : Math.min(rawDelta, 0.1);
		state.time += delta;
		// Orbits and moons run at the orbit speed setting's pace.
		const travel = delta * pace;
		const hovered = hoverRef.current;
		const focused = focusRef.current;
		// Bodies swell in the overview and ease back to true scale on a visit.
		const goal = focused === null ? overviewScale(system) : 1;
		state.bodyScale = reduced
			? goal
			: state.bodyScale +
				(goal - state.bodyScale) * Math.min(1, rawDelta * SCALE_RATE);
		const scale = state.bodyScale;
		// The visited body's moons hold still too, so their titles can be read.
		const placeMoons = (bodyId: string, moons: readonly Moon[]) => {
			const held = hovered === bodyId || focused === bodyId;
			const clock = (state.moonClocks.get(bodyId) ?? 0) + (held ? 0 : travel);
			state.moonClocks.set(bodyId, clock);
			for (const moon of moons) {
				const group = state.moonGroups.get(moonKey(bodyId, moon.threadId));
				if (group) {
					const [x, y, z] = moonOffset(moon, clock);
					group.position.set(x, y, z);
					if (bodyId === STAR_ID) {
						// The star's moons grow in place; their orbits stay clear of the planets.
						group.scale.setScalar(scale);
					}
				}
			}
		};
		for (const planet of system.planets) {
			const held = hovered === planet.id || focused === planet.id;
			// A portrait column holds every planet still in its place.
			const angle = system.column
				? planet.phase
				: (state.angles.get(planet.id) ?? planet.phase) +
					(held ? 0 : planet.orbitSpeed * travel);
			state.angles.set(planet.id, angle);
			const point = orbitPoint(planet.orbitRadius, angle);
			state.positions.set(planet.id, point);
			const group = state.planetGroups.get(planet.id);
			group?.position.set(...point);
			group?.scale.setScalar(scale);
			placeMoons(planet.id, planet.moons);
		}
		placeMoons(STAR_ID, system.starMoons);
	}, -3);
	return null;
}

interface Pose {
	position: Vec3;
	/** Pixels the picture slides right and down (the overview's framing). */
	shift: [number, number];
	target: Vec3;
}

interface Flight {
	duration: number;
	from: Pose;
	start: number;
	to: Pose;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/** A pose between two poses: the view swings around rather than cutting through. */
function blendPose(from: Pose, to: Pose, t: number): Pose {
	const target: Vec3 = [
		lerp(from.target[0], to.target[0], t),
		lerp(from.target[1], to.target[1], t),
		lerp(from.target[2], to.target[2], t),
	];
	const fromOffset = from.position.map(
		(value, index) => value - (from.target[index] ?? 0)
	);
	const toOffset = to.position.map(
		(value, index) => value - (to.target[index] ?? 0)
	);
	const fromLength = Math.hypot(...fromOffset) || 1;
	const toLength = Math.hypot(...toOffset) || 1;
	const mixed = fromOffset.map((value, index) =>
		lerp(value / fromLength, (toOffset[index] ?? 0) / toLength, t)
	);
	const mixedLength = Math.hypot(...mixed) || 1;
	const length = lerp(fromLength, toLength, t);
	return {
		position: [
			target[0] + ((mixed[0] ?? 0) / mixedLength) * length,
			target[1] + ((mixed[1] ?? 0) / mixedLength) * length,
			target[2] + ((mixed[2] ?? 0) / mixedLength) * length,
		],
		shift: [
			lerp(from.shift[0], to.shift[0], t),
			lerp(from.shift[1], to.shift[1], t),
		],
		target,
	};
}

/**
 * Orbit controls plus camera flights: to the overview, to the star, or to a
 * planet (seen from the star's side, so its day side faces you). A drag or
 * scroll cancels a flight; reduced motion cuts straight to the new view.
 */
function CameraRig({
	cameraApi,
	focusId,
	hud,
	reduced,
	sim,
	system,
}: {
	cameraApi: RefObject<CameraApi | null>;
	focusId: string | null;
	hud: HudLayout;
	reduced: boolean;
	sim: RefObject<Sim>;
	system: PlanetSystem;
}) {
	const controls = useRef<Controls>(null);
	const camera = useThree((state) => state.camera) as PerspectiveCamera;
	const size = useThree((state) => state.size);
	const flight = useRef<Flight | null>(null);
	const shift = useRef<[number, number]>([0, 0]);
	const pendingFocus = useRef(true);
	const framed = useRef(true);
	const introduced = useRef(false);
	const elevation = overviewElevation(size.width, size.height);
	const reach = overviewReach(system);
	// Framing searches many camera distances (tens of milliseconds), so it
	// reruns only when the system, the viewport or the HUD actually change.
	const frame = useMemo(
		() =>
			overviewFrame(
				reach,
				{ height: size.height, width: size.width },
				FOV,
				elevation,
				hud
			),
		[reach, size.width, size.height, elevation, hud]
	);
	// A portrait column is framed top-down, the star near the top.
	const column = useMemo(
		() =>
			system.column
				? columnFrame(
						system,
						{ height: size.height, width: size.width },
						FOV,
						COLUMN_ELEVATION,
						columnRoom(hud, size.height)
					)
				: null,
		[system, size.width, size.height, hud]
	);
	const overview = column ? column.distance : frame.distance;
	// The star's own view: the star, its moons and the innermost orbit.
	const inner = system.planets[0];
	const innerReach = inner ? inner.orbitRadius + inner.extent : SUN_RADIUS * 3;
	const starElevation = Math.max(STAR_ELEVATION, elevation - 0.15);
	const starFrame = useMemo(
		() =>
			overviewFrame(
				innerReach,
				{ height: size.height, width: size.width },
				FOV,
				starElevation,
				hud
			),
		[innerReach, size.width, size.height, starElevation, hud]
	);

	const currentPose = (): Pose => {
		const target = controls.current?.target;
		return {
			position: [camera.position.x, camera.position.y, camera.position.z],
			shift: [shift.current[0], shift.current[1]],
			target: target ? [target.x, target.y, target.z] : [0, 0, 0],
		};
	};
	const apply = (pose: Pose) => {
		camera.position.set(...pose.position);
		controls.current?.target.set(...pose.target);
		camera.lookAt(...pose.target);
		shift.current = pose.shift;
	};
	const fly = (to: Pose, seconds: number) => {
		if (reduced || seconds <= 0) {
			flight.current = null;
			apply(to);
			return;
		}
		flight.current = {
			duration: seconds,
			from: currentPose(),
			// Real time, so a slow frame lands further along instead of stretching the flight.
			start: performance.now() / 1000,
			to,
		};
	};
	const overviewPose = (scale = 1): Pose => {
		if (column) {
			const dir = direction(AZIMUTH, COLUMN_ELEVATION);
			const distance = column.distance * scale;
			const target: Vec3 = [
				Math.sin(AZIMUTH) * column.toward,
				0,
				Math.cos(AZIMUTH) * column.toward,
			];
			return {
				position: [
					target[0] + dir[0] * distance,
					target[1] + dir[1] * distance,
					target[2] + dir[2] * distance,
				],
				shift: column.shift,
				target,
			};
		}
		const dir = direction(AZIMUTH, elevation);
		const distance = overview * scale;
		return {
			position: [dir[0] * distance, dir[1] * distance, dir[2] * distance],
			shift: [frame.shiftX, frame.shiftY],
			target: [0, 0, 0],
		};
	};
	const focusPose = (id: string | null): Pose | null => {
		if (id === null) {
			return overviewPose();
		}
		if (id === STAR_ID) {
			const current = currentPose();
			const azimuth = Math.atan2(current.position[0], current.position[2]);
			const dir = direction(azimuth, starElevation);
			const distance = starFrame.distance;
			return {
				position: [dir[0] * distance, dir[1] * distance, dir[2] * distance],
				shift: [starFrame.shiftX, starFrame.shiftY],
				target: [0, 0, 0],
			};
		}
		const planet = system.planets.find((item) => item.id === id);
		const at = sim.current.positions.get(id);
		if (!(planet && at)) {
			return null;
		}
		// Centred in the free region, with room for its moons' titles.
		const fit = focusFrame(planet.extent, size, FOV, hud, FOCUS_LIMITS);
		const distance = fit.distance;
		// Look from the star's side, swung around a little, so the lit
		// hemisphere and a crescent of night both show, from wherever no moon
		// hides behind the planet (its moons hold still while it is visited).
		const dir = clearView(
			planet,
			at,
			distance,
			sim.current.moonClocks.get(planet.id) ?? 0
		);
		return {
			position: [
				at[0] + dir[0] * distance,
				at[1] + dir[1] * distance,
				at[2] + dir[2] * distance,
			],
			shift: [fit.shiftX, fit.shiftY],
			target: at,
		};
	};

	useEffect(() => {
		pendingFocus.current = true;
	}, [focusId]);

	// Keep the view framed when the viewport changes (a panel opens or
	// closes), unless a drag or zoom has taken the camera elsewhere.
	useEffect(() => {
		if (
			!(introduced.current && framed.current) ||
			size.width * size.height <= 0
		) {
			return;
		}
		pendingFocus.current = true;
	}, [
		overview,
		frame.shiftX,
		frame.shiftY,
		column?.toward,
		hud,
		size.width,
		size.height,
	]);

	// Drop the view offset when the scene goes away.
	useEffect(
		() => () => {
			camera.clearViewOffset();
		},
		[camera]
	);

	cameraApi.current = {
		overview: () => {
			framed.current = true;
			fly(overviewPose(), FLIGHT_SECONDS);
		},
		zoom: (factor) => {
			const pose = currentPose();
			const offset: Vec3 = [
				pose.position[0] - pose.target[0],
				pose.position[1] - pose.target[1],
				pose.position[2] - pose.target[2],
			];
			const length = Math.hypot(...offset);
			const next = Math.max(
				MIN_DISTANCE,
				Math.min(overview * 1.8, length * factor)
			);
			const scale = next / Math.max(length, 1e-6);
			framed.current = false;
			fly(
				{
					position: [
						pose.target[0] + offset[0] * scale,
						pose.target[1] + offset[1] * scale,
						pose.target[2] + offset[2] * scale,
					],
					shift: pose.shift,
					target: pose.target,
				},
				ZOOM_SECONDS
			);
		},
	};

	useFrame(() => {
		const control = controls.current;
		if (!control) {
			return;
		}
		if (!introduced.current) {
			introduced.current = true;
			pendingFocus.current = false;
			if (focusId === null && !reduced) {
				apply(overviewPose(OVERVIEW_INTRO_SCALE));
				fly(overviewPose(), INTRO_SECONDS);
			} else {
				apply(focusPose(focusId) ?? overviewPose());
			}
		}
		if (pendingFocus.current) {
			const pose = focusPose(focusId);
			if (pose) {
				pendingFocus.current = false;
				framed.current = true;
				fly(pose, FLIGHT_SECONDS);
			}
		}
		const active = flight.current;
		// Moon titles come up as the camera eases in to land, not after.
		let landing = false;
		if (active) {
			const t = Math.min(
				1,
				(performance.now() / 1000 - active.start) / active.duration
			);
			apply(blendPose(active.from, active.to, easeInOutCubic(t)));
			landing = t >= LANDING;
			if (t >= 1) {
				flight.current = null;
			}
		}
		sim.current.flying =
			(flight.current !== null && !landing) || pendingFocus.current;
		control.update();
		const [x, y] = shift.current;
		if (Math.abs(x) + Math.abs(y) < 0.5) {
			if (camera.view?.enabled) {
				camera.clearViewOffset();
			}
		} else {
			camera.setViewOffset(
				size.width,
				size.height,
				-x,
				-y,
				size.width,
				size.height
			);
		}
	}, -1);

	return (
		<OrbitControls
			dampingFactor={0.08}
			enableDamping={!reduced}
			enablePan={false}
			makeDefault
			maxDistance={overview * 1.8}
			maxPolarAngle={1.5}
			minDistance={MIN_DISTANCE}
			minPolarAngle={0.12}
			onStart={() => {
				flight.current = null;
				framed.current = false;
			}}
			ref={controls}
			rotateSpeed={0.55}
			zoomSpeed={0.8}
		/>
	);
}

/** True when, seen from `from`, a moon at `moon` is behind the sphere. */
function hidden(from: Vec3, centre: Vec3, radius: number, moon: Vec3): boolean {
	const toMoon: Vec3 = [
		moon[0] - from[0],
		moon[1] - from[1],
		moon[2] - from[2],
	];
	const toCentre: Vec3 = [
		centre[0] - from[0],
		centre[1] - from[1],
		centre[2] - from[2],
	];
	const moonDistance = Math.hypot(...toMoon);
	const centreDistance = Math.hypot(...toCentre);
	if (moonDistance <= centreDistance || moonDistance === 0) {
		return false;
	}
	// How far the planet's centre sits off the line of sight to the moon.
	const along =
		(toCentre[0] * toMoon[0] +
			toCentre[1] * toMoon[1] +
			toCentre[2] * toMoon[2]) /
		moonDistance;
	const off = Math.sqrt(Math.max(0, centreDistance ** 2 - along ** 2));
	return off < radius * 1.08;
}

/**
 * Every other view worth trying when none of `FOCUS_VIEWS` shows all the
 * moons: a sweep around the planet at a few elevations, nearest the
 * preferred swing first.
 */
const SWEEP_VIEWS: readonly (readonly [number, number])[] = (() => {
	const views: [number, number][] = [];
	const steps = 24;
	for (const elevation of [FOCUS_ELEVATION, 0.62, 0.16, 0.9]) {
		for (let index = 0; index < steps; index += 1) {
			views.push([(index / steps) * Math.PI * 2 - Math.PI, elevation]);
		}
	}
	const preferred = FOCUS_VIEWS[0]?.[0] ?? 0;
	return views.sort(
		(a, b) => Math.abs(a[0] - preferred) - Math.abs(b[0] - preferred)
	);
})();

/**
 * The view direction for visiting `planet` (standing `distance` away) that
 * keeps the most moons in sight, trying `FOCUS_VIEWS` in order and then a
 * sweep all the way around. A moon counts as hidden when any of it is
 * behind the planet (or its ring), not only its centre.
 */
function clearView(
	planet: Planet,
	at: Vec3,
	distance: number,
	clock: number
): Vec3 {
	const toStar = Math.atan2(-at[0], -at[2]);
	const moons = planet.moons.map((moon) => {
		const [x, y, z] = moonOffset(moon, clock);
		return [at[0] + x, at[1] + y, at[2] + z] as Vec3;
	});
	const blocker = planet.radius + (planet.moons[0]?.radius ?? 0) * 1.2;
	let best: { dir: Vec3; hiddenCount: number } | null = null;
	for (const [swing, elevation] of [...FOCUS_VIEWS, ...SWEEP_VIEWS]) {
		const dir = direction(toStar + swing, elevation);
		const eye: Vec3 = [
			at[0] + dir[0] * distance,
			at[1] + dir[1] * distance,
			at[2] + dir[2] * distance,
		];
		let hiddenCount = 0;
		for (const moon of moons) {
			if (hidden(eye, at, blocker, moon)) {
				hiddenCount += 1;
			}
		}
		if (hiddenCount === 0) {
			return dir;
		}
		if (!best || hiddenCount < best.hiddenCount) {
			best = { dir, hiddenCount };
		}
	}
	return best?.dir ?? direction(toStar + 0.62, FOCUS_ELEVATION);
}

interface Projected {
	/** Behind the camera. */
	behind: boolean;
	distance: number;
	radius: number;
	x: number;
	y: number;
}

interface LabelState {
	/** The label element (a plate or a moon's title) and its measured size. */
	element: HTMLElement | null;
	height: number;
	side: Side | null;
	text: string;
	width: number;
}

/** Finds and measures a wrapper's label; sizes are cached until its text changes. */
function labelOf(
	cache: WeakMap<HTMLElement, LabelState>,
	wrapper: HTMLElement,
	selector: string
): LabelState {
	let state = cache.get(wrapper);
	if (!state) {
		state = {
			element: wrapper.querySelector<HTMLElement>(selector),
			height: 0,
			side: null,
			text: "",
			width: 0,
		};
		cache.set(wrapper, state);
	}
	const element = state.element;
	if (element) {
		const text = element.textContent ?? "";
		if (text !== state.text || state.width === 0) {
			const width = element.offsetWidth;
			const height = element.offsetHeight;
			if (width > 0) {
				state.text = text;
				state.width = width;
				state.height = height;
			}
		}
	}
	return state;
}

const SCENE_MARGIN = 8;
/** Clear space between a moon (with its glow) and its title. */
const MOON_LABEL_GAP = 6;
/** Plates sit under their body unless something is there. */
const PLATE_SIDES: readonly Side[] = ["below", "above", "right", "left"];

function hudBoxes(hud: HudLayout): Box[] {
	return [hud.card, hud.controls, hud.legend].filter(
		(box): box is Box => box !== null
	);
}

/** The act layer's in-scene plates (station plates, alarms, boards). */
const ACT_PLATES = "[data-iso-target], [data-iso-plate]";

/**
 * Where the act layer's plates stand, px in the scene (as last drawn), so
 * the name plates can step clear of them. `root` is where the scene's HTML
 * plates are mounted (the canvas's event root).
 */
function actPlateBoxes(canvas: HTMLCanvasElement, root: Element | null): Box[] {
	if (!root) {
		return [];
	}
	const origin = canvas.getBoundingClientRect();
	const boxes: Box[] = [];
	for (const plate of root.querySelectorAll(ACT_PLATES)) {
		const rect = plate.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			boxes.push({
				bottom: rect.bottom - origin.top,
				left: rect.left - origin.left,
				right: rect.right - origin.left,
				top: rect.top - origin.top,
			});
		}
	}
	return boxes;
}

/**
 * Moves the DOM name plates and moon targets onto their bodies each frame.
 * A plate or moon is hidden when a nearer body covers it, when it would sit
 * under the HUD, or when it is off screen. Plates take the side of their
 * body that is clear of other bodies and plates; the moons of the body being
 * visited show their titles (once the camera has landed), each placed away
 * from its planet and clear of the others.
 */
function OverlaySync({
	focusRef,
	hud,
	registry,
	sim,
	station,
	system,
}: {
	focusRef: RefObject<string | null>;
	hud: HudLayout;
	registry: RefObject<OverlayRegistry>;
	sim: RefObject<Sim>;
	/** The act layer's station is up (a phone's strip keeps plates clear). */
	station: boolean;
	system: PlanetSystem;
}) {
	const scratch = useRef<Vector3 | null>(null);
	const labels = useRef(new WeakMap<HTMLElement, LabelState>());
	useFrame(({ camera, events, gl, size }) => {
		const lens = camera as PerspectiveCamera;
		lens.updateMatrixWorld();
		scratch.current ??= lens.position.clone();
		const v = scratch.current;
		const halfTan = Math.tan((lens.fov * Math.PI) / 360);
		const project = (point: Vec3, radius: number): Projected => {
			v.set(...point);
			const distance = lens.position.distanceTo(v);
			v.project(lens);
			return {
				behind: v.z > 1,
				distance,
				radius:
					(radius / Math.max(distance * halfTan, 1e-6)) * (size.height / 2),
				x: (v.x * 0.5 + 0.5) * size.width,
				y: (-v.y * 0.5 + 0.5) * size.height,
			};
		};
		const cover = hudBoxes(hud);
		const connected: unknown = events.connected;
		const acted = actPlateBoxes(
			gl.domElement,
			connected instanceof Element ? connected : gl.domElement.parentElement
		);
		const strip = station
			? stationStripBox(size, system.column === true)
			: null;
		if (strip) {
			acted.push(strip);
		}
		const bounds: Box = {
			bottom: size.height - SCENE_MARGIN,
			left: SCENE_MARGIN,
			right: size.width - SCENE_MARGIN,
			top: SCENE_MARGIN,
		};
		const { bodyScale, moonGroups, positions } = sim.current;
		const focus = focusRef.current;
		const settled = !sim.current.flying;

		// Every body on screen, nearest first: they hide what is behind them.
		const sun = project([0, 0, 0], SUN_RADIUS);
		const bodies = new Map<string, Projected>([[STAR_ID, sun]]);
		for (const planet of system.planets) {
			const point = positions.get(planet.id);
			if (point) {
				bodies.set(planet.id, project(point, planet.radius * bodyScale));
			}
		}
		const blockers = [...bodies.entries()].filter(
			([, body]) => !body.behind && body.radius > 1
		);
		const covered = (
			at: { distance: number; x: number; y: number },
			ownId: string | null
		) =>
			blockers.some(
				([id, body]) =>
					id !== ownId &&
					at.distance > body.distance &&
					Math.hypot(at.x - body.x, at.y - body.y) < body.radius * 0.92
			);
		const offscreen = (x: number, y: number) =>
			x < -40 || y < -40 || x > size.width + 40 || y > size.height + 40;
		const discs = blockers.map(([id, body]) => ({
			box: discBox({ radius: body.radius, x: body.x, y: body.y }),
			id,
		}));
		// The star's face (its whole disc) is never covered by a planet's plate.
		const starFace =
			!sun.behind && sun.radius > 1
				? [discBox({ radius: sun.radius, x: sun.x, y: sun.y }, 1)]
				: [];

		const hide = (element: HTMLElement) => {
			if (element.dataset.hidden !== "true") {
				element.dataset.hidden = "true";
			}
		};
		const show = (
			element: HTMLElement,
			at: { radius: number; x: number; y: number }
		) => {
			if (element.dataset.hidden !== "false") {
				element.dataset.hidden = "false";
			}
			element.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0)`;
			element.style.setProperty(
				"--body-r",
				`${Math.max(4, at.radius).toFixed(1)}px`
			);
		};
		const setLabel = (
			element: HTMLElement,
			label: LabelState,
			placement: Placement,
			at: { x: number; y: number }
		) => {
			label.side = placement.side;
			element.style.setProperty(
				"--label-x",
				`${(placement.box.left - at.x).toFixed(1)}px`
			);
			element.style.setProperty(
				"--label-y",
				`${(placement.box.top - at.y).toFixed(1)}px`
			);
		};

		// Plates: the star, then the visited planet, then nearest first.
		const placed: Box[] = [];
		const plateOrder = [...bodies.entries()].sort(([idA, a], [idB, b]) => {
			if (idA === focus || idB === focus) {
				return idA === focus ? -1 : 1;
			}
			if (idA === STAR_ID || idB === STAR_ID) {
				return idA === STAR_ID ? -1 : 1;
			}
			return a.distance - b.distance;
		});
		for (const [id, at] of plateOrder) {
			const element =
				id === STAR_ID
					? registry.current.sun
					: registry.current.planets.get(id);
			if (!element) {
				continue;
			}
			if (at.behind || offscreen(at.x, at.y) || covered(at, id)) {
				hide(element);
				continue;
			}
			const label = labelOf(labels.current, element, "[data-plate]");
			if (label.width === 0) {
				// Not measured yet (it was hidden): show it once, centred below.
				show(element, at);
				continue;
			}
			const anchor = { radius: Math.max(4, at.radius), x: at.x, y: at.y };
			const placement = placeLabel({
				anchor,
				bounds,
				// Other worlds' faces (and the star's whole face) outweigh plates.
				keepClear: [
					...(id === STAR_ID ? [] : starFace),
					...discs.filter((disc) => disc.id !== id).map((disc) => disc.box),
				],
				obstacles: [
					// Its own body too, so sliding inside the scene never covers it.
					...discs.map((disc) => disc.box),
					...placed,
					...acted,
					...cover,
				],
				previous: label.side,
				sides: PLATE_SIDES,
				size: { height: label.height, width: label.width },
			});
			if (
				mostlyUnder(placement.box, cover) ||
				mostlyUnder(discBox(anchor), cover)
			) {
				hide(element);
				continue;
			}
			// Crowded (a narrow view): a planet's plate that would sit on another
			// plate steps aside; the star's and the visited planet's always show.
			const area = label.width * label.height;
			const crowded = placed.reduce(
				(total, box) => total + overlapArea(placement.box, box),
				0
			);
			if (id !== STAR_ID && id !== focus && crowded > area * 0.3) {
				hide(element);
				continue;
			}
			show(element, at);
			setLabel(element, label, placement, at);
			placed.push(placement.box);
		}

		// Moons: hit targets over each, with titles for the visited body's.
		const placeMoons = (
			bodyId: string,
			moons: readonly Moon[],
			body: Projected | undefined,
			origin: Vec3,
			/** Planets' moon orbits grow with the body; the star's do not. */
			orbitScale: number
		) => {
			const pinned = settled && focus === bodyId;
			const titled: Box[] = [];
			for (const moon of moons) {
				const key = moonKey(bodyId, moon.threadId);
				const group = moonGroups.get(key);
				const element = registry.current.moons.get(key);
				if (!(group && element && body)) {
					continue;
				}
				const at = project(
					[
						origin[0] + group.position.x * orbitScale,
						origin[1] + group.position.y * orbitScale,
						origin[2] + group.position.z * orbitScale,
					],
					moon.radius * bodyScale
				);
				const anchor = { radius: Math.max(4, at.radius), x: at.x, y: at.y };
				if (
					at.behind ||
					offscreen(at.x, at.y) ||
					covered(at, null) ||
					mostlyUnder(discBox(anchor), cover)
				) {
					hide(element);
					continue;
				}
				show(element, at);
				const label = labelOf(labels.current, element, "[data-label]");
				const flag = pinned ? "pinned" : "hover";
				if (element.dataset.label !== flag) {
					element.dataset.label = flag;
				}
				if (label.width === 0) {
					continue;
				}
				const placement = placeLabel({
					anchor,
					bounds,
					obstacles: [
						discBox({ radius: body.radius, x: body.x, y: body.y }, 0.95),
						...(pinned ? [...placed, ...titled] : []),
						...cover,
					],
					// The moon itself (and its glow) always stays uncovered.
					own: discBox(
						{ ...anchor, radius: anchor.radius + MOON_LABEL_GAP },
						1
					),
					previous: label.side,
					sides: moonSides(anchor, body),
					size: { height: label.height, width: label.width },
				});
				setLabel(element, label, placement, at);
				if (pinned) {
					titled.push(placement.box);
				}
			}
		};
		placeMoons(STAR_ID, system.starMoons, sun, [0, 0, 0], 1);
		for (const planet of system.planets) {
			const point = positions.get(planet.id);
			if (point) {
				placeMoons(
					planet.id,
					planet.moons,
					bodies.get(planet.id),
					point,
					bodyScale
				);
			}
		}
	});
	return null;
}

function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 4_294_967_296;
	};
}

function Starfield({
	palette,
	quality,
	reduced,
	sim,
}: {
	palette: PlanetsPalette;
	quality: "high" | "low";
	reduced: boolean;
	sim: RefObject<Sim>;
}) {
	const count = quality === "high" ? 1800 : 1100;
	const dpr = useThree((state) => state.viewport.dpr);
	const attributes = useMemo(() => {
		const random = seeded(7);
		const positions = new Float32Array(count * 3);
		const sizes = new Float32Array(count);
		const tones = new Float32Array(count);
		const phases = new Float32Array(count);
		for (let index = 0; index < count; index += 1) {
			const u = random() * 2 - 1;
			const theta = random() * Math.PI * 2;
			const ring = Math.sqrt(1 - u * u);
			const radius = 900 + random() * 300;
			positions[index * 3] = ring * Math.cos(theta) * radius;
			positions[index * 3 + 1] = u * radius;
			positions[index * 3 + 2] = ring * Math.sin(theta) * radius;
			const bright = random();
			sizes[index] = bright > 0.97 ? 3.4 + random() * 1.4 : 1 + random() * 1.7;
			tones[index] = random() > 0.8 ? 0.4 + random() * 0.6 : random() * 0.15;
			phases[index] = random();
		}
		return { phases, positions, sizes, tones };
	}, [count]);
	const shader = useUniforms({
		uColorA: unitRgb(palette.sky.stars[0]),
		uColorB: unitRgb(palette.sky.stars[1]),
		uOpacity: palette.sky.starOpacity,
		uPixelRatio: dpr,
		uTime: 0,
	});
	useFrame(() => {
		if (!reduced) {
			shader.set("uTime", sim.current.time);
		}
	});
	return (
		<points frustumCulled={false}>
			<bufferGeometry>
				<bufferAttribute
					args={[attributes.positions, 3]}
					attach="attributes-position"
				/>
				<bufferAttribute
					args={[attributes.sizes, 1]}
					attach="attributes-aSize"
				/>
				<bufferAttribute
					args={[attributes.tones, 1]}
					attach="attributes-aTone"
				/>
				<bufferAttribute
					args={[attributes.phases, 1]}
					attach="attributes-aPhase"
				/>
			</bufferGeometry>
			<shaderMaterial
				blending={palette.additive ? ADDITIVE_BLENDING : NORMAL_BLENDING}
				depthWrite={false}
				fragmentShader={STAR_FRAGMENT}
				ref={shader.ref}
				transparent
				uniforms={shader.uniforms}
				vertexShader={STAR_VERTEX}
			/>
		</points>
	);
}

function Disc({
	palette,
	radius,
}: {
	palette: PlanetsPalette;
	radius: number;
}) {
	const shader = useUniforms({
		uAlpha: palette.mode === "dark" ? 0.09 : 0.22,
		uColor: unitRgb(palette.sky.disc),
		uRadius: radius * 1.05,
	});
	return (
		<mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
			<circleGeometry args={[radius * 1.05, 96]} />
			<shaderMaterial
				blending={palette.additive ? ADDITIVE_BLENDING : NORMAL_BLENDING}
				depthWrite={false}
				fragmentShader={DISC_FRAGMENT}
				ref={shader.ref}
				side={DOUBLE_SIDE}
				transparent
				uniforms={shader.uniforms}
				vertexShader={DISC_VERTEX}
			/>
		</mesh>
	);
}

/** Values for a glow billboard (see `Glow`). */
function glowValues(
	color: Rgb,
	alpha: number,
	falloff: number,
	size: number,
	rays = 0,
	push = 0
) {
	return {
		uAlpha: alpha,
		uColor: unitRgb(color),
		uFalloff: falloff,
		uPush: push,
		uRays: rays,
		uSize: size,
		uTime: 0,
	};
}

/** A moon's farthest reach past its body's surface (outer shell plus its size). */
const MOON_REACH = 1.6;

/** How far a body's haze sits behind it: past its outer moons, at any scale. */
function hazePush(radius: number): number {
	return (radius + MOON_REACH) * OVERVIEW_BODY_SCALE;
}

type GlowShader = Shader<ReturnType<typeof glowValues>>;

function Glow({ additive, shader }: { additive: boolean; shader: GlowShader }) {
	return (
		<mesh frustumCulled={false} raycast={() => null}>
			<planeGeometry args={[1, 1]} />
			<shaderMaterial
				blending={additive ? ADDITIVE_BLENDING : NORMAL_BLENDING}
				depthWrite={false}
				fragmentShader={GLOW_FRAGMENT}
				ref={shader.ref}
				transparent
				uniforms={shader.uniforms}
				vertexShader={BILLBOARD_VERTEX}
			/>
		</mesh>
	);
}

function pointerHandlers(
	bodyId: string,
	onHover: (bodyId: string | null) => void,
	onSelect: (bodyId: string) => void
) {
	return {
		onClick: (event: ThreeEvent<MouseEvent>) => {
			event.stopPropagation();
			onSelect(bodyId);
		},
		onPointerOut: () => {
			document.body.style.cursor = "";
			onHover(null);
		},
		onPointerOver: (event: ThreeEvent<PointerEvent>) => {
			event.stopPropagation();
			document.body.style.cursor = "pointer";
			onHover(bodyId);
		},
	};
}

/** The star's front bloom, in star radii across: just past its limb. */
const SUN_BLOOM = 2.7;

function Sun({
	onHover,
	onSelect,
	palette,
	reduced,
	sim,
}: {
	onHover: (bodyId: string | null) => void;
	onSelect: (bodyId: string) => void;
	palette: PlanetsPalette;
	reduced: boolean;
	sim: RefObject<Sim>;
}) {
	const { sun } = palette;
	const surface = useUniforms({
		uCore: unitRgb(sun.core),
		uEdge: unitRgb(sun.edge),
		uMid: unitRgb(sun.mid),
		uTime: 0,
	});
	// The corona and the wide halo sit behind the star by their own radius,
	// so a planet or moon inside them (seen up close, beside the star) is
	// never washed over; a tight bloom stays in front to soften the limb.
	const coronaSize = SUN_RADIUS * 4.6 * sun.coronaScale;
	const haloSize = SUN_RADIUS * 13 * sun.coronaScale;
	const corona = useUniforms(
		glowValues(
			sun.glow,
			0.95 * sun.glowStrength,
			1.7,
			coronaSize,
			0.45,
			coronaSize / 2
		)
	);
	const halo = useUniforms(
		glowValues(
			sun.glow,
			0.42 * sun.haloStrength,
			3.4,
			haloSize,
			0,
			haloSize / 2
		)
	);
	const bloom = useUniforms(
		glowValues(sun.glow, 0.7 * sun.glowStrength, 1.3, SUN_RADIUS * SUN_BLOOM)
	);
	useEffect(
		() => () => {
			document.body.style.cursor = "";
		},
		[]
	);
	useFrame(() => {
		if (reduced) {
			return;
		}
		const time = sim.current.time;
		surface.set("uTime", time);
		corona.set("uTime", time);
	});
	return (
		<group>
			<mesh {...pointerHandlers(STAR_ID, onHover, onSelect)}>
				<sphereGeometry args={[SUN_RADIUS, 64, 48]} />
				<shaderMaterial
					fragmentShader={SUN_FRAGMENT}
					ref={surface.ref}
					uniforms={surface.uniforms}
					vertexShader={SURFACE_VERTEX}
				/>
			</mesh>
			<InkHull radius={SUN_RADIUS} width={0.025} />
			<Glow additive={palette.additive} shader={halo} />
			<Glow additive={palette.additive} shader={corona} />
			<SunFace
				palette={palette}
				radius={SUN_RADIUS}
				reduced={reduced}
				time={sim}
			/>
			<Glow additive={palette.additive} shader={bloom} />
		</group>
	);
}

const NO_HOLE: [number, number, number] = [0, 0, 0];

function OrbitLine({
	color,
	emphasis,
	palette,
	planet,
	sim,
	team,
}: {
	color: Rgb;
	emphasis: boolean;
	palette: PlanetsPalette;
	planet: Planet;
	sim: RefObject<Sim>;
	team: boolean;
}) {
	const radius = planet.orbitRadius;
	const scratch = useRef<Vector3 | null>(null);
	const points = useMemo(() => {
		const array = new Float32Array(ORBIT_SEGMENTS * 3);
		for (let index = 0; index < ORBIT_SEGMENTS; index += 1) {
			const [x, y, z] = orbitPoint(
				radius,
				(index / ORBIT_SEGMENTS) * Math.PI * 2
			);
			array[index * 3] = x;
			array[index * 3 + 1] = y;
			array[index * 3 + 2] = z;
		}
		return array;
	}, [radius]);
	const base = palette.sky.orbitOpacity;
	let alpha = team ? base * 2.1 : base;
	if (emphasis) {
		alpha = Math.min(0.9, alpha * 2.2);
	}
	const line = useUniforms({
		uAlpha: alpha,
		uColor: unitRgb(color),
		uFar: radius * 3,
		uHole: NO_HOLE,
	});
	// A team's orbit also wears a soft band in the team's color, so it reads
	// apart from plain orbits in every theme (the legend's swatch is the band).
	const halfWidth = Math.max(0.28, radius * 0.012);
	const band = useUniforms({
		uAlpha: palette.mode === "dark" ? 0.2 : 0.26,
		uColor: unitRgb(color),
		uFar: radius * 3,
		uHalf: halfWidth,
		uHole: NO_HOLE,
		uRadius: radius,
	});
	// The visited planet's own orbit stops at its limb (see `HOLE`). Measured
	// here, after the camera has moved this frame, so the gap never trails.
	useFrame(({ camera, gl, size }) => {
		const at = emphasis ? sim.current.positions.get(planet.id) : undefined;
		let value = NO_HOLE;
		if (at) {
			const lens = camera as PerspectiveCamera;
			lens.updateMatrixWorld();
			scratch.current ??= lens.position.clone();
			const v = scratch.current.set(...at);
			const distance = lens.position.distanceTo(v);
			v.project(lens);
			const ratio = gl.getPixelRatio();
			const halfTan = Math.tan((lens.fov * Math.PI) / 360);
			const disc =
				((planet.radius * sim.current.bodyScale) /
					Math.max(distance * halfTan, 1e-6)) *
				(size.height / 2);
			value =
				v.z > 1
					? NO_HOLE
					: [
							(v.x * 0.5 + 0.5) * size.width * ratio,
							(v.y * 0.5 + 0.5) * size.height * ratio,
							disc * ratio,
						];
		}
		const shown = line.get("uHole");
		if (
			shown[0] === value[0] &&
			shown[1] === value[1] &&
			shown[2] === value[2]
		) {
			return;
		}
		line.set("uHole", value);
		band.set("uHole", value);
	});
	return (
		<group>
			<lineLoop>
				<bufferGeometry>
					<bufferAttribute args={[points, 3]} attach="attributes-position" />
				</bufferGeometry>
				<shaderMaterial
					depthWrite={false}
					fragmentShader={LINE_FRAGMENT}
					ref={line.ref}
					transparent
					uniforms={line.uniforms}
					vertexShader={LINE_VERTEX}
				/>
			</lineLoop>
			{team ? (
				<mesh
					position={[0, -0.01, 0]}
					raycast={() => null}
					rotation={[-Math.PI / 2, 0, 0]}
				>
					<ringGeometry
						args={[radius - halfWidth, radius + halfWidth, ORBIT_SEGMENTS, 1]}
					/>
					<shaderMaterial
						blending={palette.additive ? ADDITIVE_BLENDING : NORMAL_BLENDING}
						depthWrite={false}
						fragmentShader={BAND_FRAGMENT}
						ref={band.ref}
						side={DOUBLE_SIDE}
						transparent
						uniforms={band.uniforms}
						vertexShader={BAND_VERTEX}
					/>
				</mesh>
			) : null}
		</group>
	);
}

const KIND_INDEX: Record<Planet["kind"], number> = {
	gas: 1,
	ice: 2,
	ocean: 3,
	ringed: 4,
	rocky: 0,
};

/** A ring's inner edge, as a multiple of its planet's radius. */
const RING_INNER = 1.22;
/**
 * How far a ringed world leans its ring away from the overview camera: a
 * ring seen at the overview's own angle sits around the planet like a flat
 * dish; leaned back it is a Saturn-style band whose near arc crosses the
 * planet's face.
 */
const RING_LEAN = 0.42;

/**
 * A planet's axial tilt. Ringed worlds lean towards the overview's azimuth
 * instead, so their ring always reads as a band across the planet.
 */
function Tilt({ children, planet }: { children: ReactNode; planet: Planet }) {
	if (planet.kind !== "ringed") {
		return (
			<group rotation={[planet.axialTilt, 0, planet.axialTilt * 0.4]}>
				{children}
			</group>
		);
	}
	return (
		<group rotation={[0, AZIMUTH, 0]}>
			<group rotation={[-RING_LEAN, 0, planet.axialTilt * 0.25]}>
				{children}
			</group>
		</group>
	);
}

function PlanetBody({
	focused,
	hoverRef,
	look: given,
	night,
	onHover,
	onSelect,
	palette,
	planet,
	quality,
	reduced,
	sim,
	swatch,
	theme,
	villager,
}: {
	focused: boolean;
	hoverRef: RefObject<string | null>;
	/** The planet in its agent's colour. */
	look: PlanetLook | undefined;
	night: boolean;
	onHover: (bodyId: string | null) => void;
	onSelect: (bodyId: string) => void;
	palette: PlanetsPalette;
	planet: Planet;
	quality: "high" | "low";
	reduced: boolean;
	sim: RefObject<Sim>;
	swatch: AgentSwatch;
	theme: Scene3dTheme;
	/** The agent's villager, standing on top. */
	villager: MemberLooks | undefined;
}) {
	const look: PlanetLook =
		given ?? planetLook(planet.kind, planetVariant(planet.id, 3));
	const spinRef = useRef<Mesh>(null);
	const seed = (planetVariant(planet.id, 97) + 3) / 17;
	const surface = useUniforms({
		uA: unitRgb(look.a),
		uAtmosphere: unitRgb(look.atmosphere),
		uAtmosphereStrength: planet.working ? 0.95 : 0.55,
		uB: unitRgb(look.b),
		uC: unitRgb(look.c),
		uKind: KIND_INDEX[planet.kind],
		uNight: palette.night,
		uSeed: seed,
		uTime: 0,
	});
	const ring = useUniforms({
		// Pale rings vanish against a pale sky; deepen them by day.
		uColor: unitRgb(
			palette.mode === "light" ? mixRgb(look.ring, look.b, 0.5) : look.ring
		),
		uInner: planet.radius * RING_INNER,
		uNight: palette.night,
		uOuter: planet.radius * 2.15,
		uSeed: seed,
	});
	// Billboards ignore the group's scale, so their sizes follow the bodies'
	// overview swell by hand each frame.
	const atmosphereSize = planet.radius * (planet.working ? 3.8 : 3.1);
	const haloSize = planet.radius * 2.36;
	const atmosphere = useUniforms(
		glowValues(
			planet.working ? palette.status.working : look.atmosphere,
			(planet.working ? 0.8 : 0.34) * palette.glowScale,
			planet.working ? 1.6 : 2.4,
			atmosphereSize,
			0,
			hazePush(planet.radius)
		)
	);
	const halo = useUniforms({
		uAlpha: 0,
		uColor: unitRgb(palette.ring),
		// A thin outline just off the surface: the visited (or hovered) world.
		uSize: haloSize,
		uWidth: 0.035,
	});

	useFrame((_, delta) => {
		const mesh = spinRef.current;
		if (mesh && !reduced) {
			mesh.rotation.y += planet.spin * Math.min(delta, 0.1);
		}
		const time = sim.current.time;
		const scale = sim.current.bodyScale;
		surface.set("uTime", time);
		atmosphere.set("uSize", atmosphereSize * scale);
		halo.set("uSize", haloSize * scale);
		if (planet.working && !reduced) {
			atmosphere.set(
				"uAlpha",
				(0.6 + 0.22 * Math.sin(time * 2.4)) * palette.glowScale
			);
		}
		const hovered = hoverRef.current === planet.id;
		let target = 0;
		if (focused) {
			target = 0.75;
		} else if (hovered) {
			target = 0.5;
		}
		const shown = halo.get("uAlpha");
		halo.set(
			"uAlpha",
			reduced ? target : shown + (target - shown) * Math.min(1, delta * 10)
		);
	});

	const segments = quality === "high" ? [72, 48] : [44, 30];
	return (
		<group
			ref={(group) => {
				if (group) {
					sim.current.planetGroups.set(planet.id, group);
				} else {
					sim.current.planetGroups.delete(planet.id);
				}
			}}
		>
			<Glow additive={palette.additive} shader={atmosphere} />
			<Tilt planet={planet}>
				<mesh ref={spinRef} {...pointerHandlers(planet.id, onHover, onSelect)}>
					<sphereGeometry args={[planet.radius, segments[0], segments[1]]} />
					<shaderMaterial
						defines={quality === "high" ? HIGH_DEFINES : LOW_DEFINES}
						fragmentShader={PLANET_FRAGMENT}
						ref={surface.ref}
						uniforms={surface.uniforms}
						vertexShader={SURFACE_VERTEX}
					/>
				</mesh>
				<InkHull radius={planet.radius} width={PLANET_INK} />
				{planet.kind === "ringed" ? (
					<mesh
						raycast={() => null}
						// After the atmosphere's glow, so the near arc reads across the face.
						renderOrder={2}
						rotation={[-Math.PI / 2, 0, 0]}
					>
						<ringGeometry
							args={[planet.radius * RING_INNER, planet.radius * 2.15, 128, 1]}
						/>
						<shaderMaterial
							depthWrite={false}
							fragmentShader={RING_FRAGMENT}
							ref={ring.ref}
							side={DOUBLE_SIDE}
							transparent
							uniforms={ring.uniforms}
							vertexShader={RING_VERTEX}
						/>
					</mesh>
				) : null}
			</Tilt>
			<PlanetTop
				looks={villager}
				night={night}
				palette={palette}
				planet={planet}
				reduced={reduced}
				swatch={swatch}
				theme={theme}
			/>
			<mesh frustumCulled={false} raycast={() => null}>
				<planeGeometry args={[1, 1]} />
				<shaderMaterial
					depthWrite={false}
					fragmentShader={HALO_FRAGMENT}
					ref={halo.ref}
					transparent
					uniforms={halo.uniforms}
					vertexShader={BILLBOARD_VERTEX}
				/>
			</mesh>
			{planet.moons.map((moon) => (
				<MoonBody
					bodyId={planet.id}
					key={moonKey(planet.id, moon.threadId)}
					moon={moon}
					palette={palette}
					reduced={reduced}
					sim={sim}
				/>
			))}
		</group>
	);
}

/** How strongly a moon's status shows on its surface (tint and rim light). */
const STATUS_STRENGTH: Record<Moon["status"], number> = {
	attention: 1,
	quiet: 0.25,
	waiting: 0.45,
	working: 0.9,
	"your-turn": 1,
};

const MOON_GLOW: Record<Moon["status"], number> = {
	attention: 0.8,
	quiet: 0,
	waiting: 0,
	working: 0.55,
	"your-turn": 0.7,
};

/** A live run's pulse: a thin halo that grows and fades, once per period. */
const PULSE_SECONDS = 1.8;
const PULSE_GROWTH = 0.6;
const PULSE_ALPHA = 0.5;
/** The working moon's still ring, as a multiple of its radius (diameter). */
const STEADY_RING = 3.3;
/** The still ring around a moon that needs you, seen up close. */
const NEEDS_YOU_RING = 0.85;
/** A moon's glow fades in between these camera distances (close-up to overview). */
const GLOW_NEAR = 24;
const GLOW_FAR = 64;

function MoonBody({
	bodyId,
	moon,
	palette,
	reduced,
	sim,
}: {
	bodyId: string;
	moon: Moon;
	palette: PlanetsPalette;
	reduced: boolean;
	sim: RefObject<Sim>;
}) {
	const color = palette.status[moon.status];
	const key = moonKey(bodyId, moon.threadId);
	const surface = useUniforms({
		uColor: unitRgb(color),
		uFar: 1,
		uNight: palette.night,
		uSeed: moon.phase * 3,
		uStatus: STATUS_STRENGTH[moon.status],
	});
	const glowSize = moon.radius * (palette.additive ? 5 : 4.2);
	const glow = useUniforms(
		glowValues(
			color,
			MOON_GLOW[moon.status] * palette.moonGlowScale,
			2.2,
			glowSize
		)
	);
	// A live run sends out a thin, fading halo (like the legend's working
	// ring), so it never reads as "your turn" in themes whose accent is green.
	// Under reduced motion the still ring below says it on its own.
	const ring = useUniforms({
		uAlpha: PULSE_ALPHA * 0.7,
		uColor: unitRgb(color),
		uSize: moon.radius * 3.4,
		uWidth: 0.06,
	});
	// ...and always wears a still ring, the legend's working glyph, so a
	// still picture (or reduced motion) tells it apart by shape too.
	const steady = useUniforms({
		uAlpha: palette.additive ? 0.85 : 0.95,
		uColor: unitRgb(color),
		uSize: moon.radius * STEADY_RING,
		uWidth: 0.16,
	});
	const working = moon.status === "working";
	const needsYou = moon.status === "attention" || moon.status === "your-turn";
	const baseGlow = MOON_GLOW[moon.status] * palette.moonGlowScale;
	// Moons that need you keep most of their glow up close, too.
	const nearGlow = needsYou ? 0.62 : 0.3;
	useFrame(({ camera }) => {
		// Billboards ignore the group's scale: follow the overview swell.
		const scale = sim.current.bodyScale;
		glow.set("uSize", glowSize * scale);
		steady.set("uSize", moon.radius * STEADY_RING * scale);
		// The glow is what makes a far-off moon readable; up close the moon
		// itself shows, so the haze fades back to a rim.
		const group = sim.current.moonGroups.get(key);
		const world = group?.matrixWorld.elements;
		const distance = world
			? Math.hypot(
					camera.position.x - (world[12] ?? 0),
					camera.position.y - (world[13] ?? 0),
					camera.position.z - (world[14] ?? 0)
				)
			: GLOW_FAR;
		const farness = Math.min(
			1,
			Math.max(0, (distance - GLOW_NEAR) / (GLOW_FAR - GLOW_NEAR))
		);
		surface.set("uFar", farness);
		if (needsYou) {
			// Up close a moon can sit against its own planet's face, where a
			// glow hardly shows: a fine ring in its status colour keeps it apart.
			ring.set("uSize", moon.radius * 2.7 * scale);
			ring.set("uAlpha", NEEDS_YOU_RING * (1 - farness));
		}
		let pulseGlow = 1;
		if (working && !reduced) {
			const cycle =
				(sim.current.time / PULSE_SECONDS + moon.phase / (Math.PI * 2)) % 1;
			ring.set(
				"uSize",
				moon.radius * STEADY_RING * scale * (1 + PULSE_GROWTH * cycle)
			);
			ring.set("uAlpha", PULSE_ALPHA * (1 - cycle) ** 1.5);
			pulseGlow = 0.75 + 0.25 * Math.cos(cycle * Math.PI * 2);
		}
		glow.set(
			"uAlpha",
			baseGlow * (nearGlow + (1 - nearGlow) * farness) * pulseGlow
		);
	});
	return (
		<group
			ref={(group) => {
				if (group) {
					sim.current.moonGroups.set(key, group);
				} else {
					sim.current.moonGroups.delete(key);
				}
			}}
		>
			<mesh raycast={() => null}>
				<sphereGeometry args={[moon.radius, 32, 20]} />
				<shaderMaterial
					fragmentShader={MOON_FRAGMENT}
					ref={surface.ref}
					uniforms={surface.uniforms}
					vertexShader={SURFACE_VERTEX}
				/>
			</mesh>
			<InkHull radius={moon.radius} width={MOON_INK} />
			{MOON_GLOW[moon.status] > 0 ? (
				<Glow additive={palette.additive} shader={glow} />
			) : null}
			{working ? (
				<mesh frustumCulled={false} raycast={() => null}>
					<planeGeometry args={[1, 1]} />
					<shaderMaterial
						depthWrite={false}
						fragmentShader={HALO_FRAGMENT}
						ref={steady.ref}
						transparent
						uniforms={steady.uniforms}
						vertexShader={BILLBOARD_VERTEX}
					/>
				</mesh>
			) : null}
			{(working && !reduced) || needsYou ? (
				<mesh frustumCulled={false} raycast={() => null}>
					<planeGeometry args={[1, 1]} />
					<shaderMaterial
						depthWrite={false}
						fragmentShader={HALO_FRAGMENT}
						ref={ring.ref}
						transparent
						uniforms={ring.uniforms}
						vertexShader={BILLBOARD_VERTEX}
					/>
				</mesh>
			) : null}
		</group>
	);
}

/** Ink outline widths for planets and moons, as a share of their radius. */
const PLANET_INK = 0.035;
const MOON_INK = 0.07;

/**
 * The game kit's ink outline for a sphere: the same sphere, a little
 * larger, drawn from the back in the kit's ink colour.
 */
function InkHull({ radius, width }: { radius: number; width: number }) {
	return (
		<mesh raycast={() => null} scale={1 + width}>
			<sphereGeometry args={[radius, 32, 20]} />
			<meshBasicMaterial color={TOON_LIGHT.ink} side={BACK_SIDE} />
		</mesh>
	);
}
