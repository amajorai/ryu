/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { CylinderGeometry, InstancedMesh } from "three";
import {
	InstancedParts,
	type InstanceSpec,
	writeInstances,
} from "./game3d-instances.tsx";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { pick } from "./game3d-math.ts";
import {
	type AgentSwatch,
	ART_CREAM,
	HOUSE_ART,
	hexAlpha,
	type Scene3dTheme,
	type Vec3,
} from "./game3d-palette.ts";
import { linearRgb } from "./game3d-toon.ts";

const FOUNDATION_HEIGHT = 0.16;
const WALL_WIDTH = 2.5;
const WALL_DEPTH = 1.5;
const WALL_HEIGHT = 1;
const EAVE = FOUNDATION_HEIGHT + WALL_HEIGHT + 0.04;
/** The gable faces the street; the ridge runs front to back. */
const PITCH = (40 * Math.PI) / 180;
const HALF_SPAN = WALL_WIDTH / 2;
const RIDGE = HALF_SPAN * Math.tan(PITCH);
/** Big, generous roofs, the way island cottages wear them. */
const OVERHANG = 0.26;
/** The roof reaches a little further over the front door. */
const FRONT_OVERHANG = 0.38;
const SLOPE_LENGTH = (HALF_SPAN + OVERHANG) / Math.cos(PITCH);
const ROOF_DEPTH = WALL_DEPTH + OVERHANG + FRONT_OVERHANG;
const ROOF_SHIFT = (FRONT_OVERHANG - OVERHANG) / 2;
const SLAB_THICKNESS = 0.14;
/** Ink outline width for cottage parts. */
const HOUSE_INK = 0.026;
/** Lit glass and lanterns are pushed past white so they bloom. */
const LIT_GLOW = 2.4;
const NIGHT_WINDOW_GLOW = 2.3;
const LANTERN_GLOW = 3.8;
const MAILBOX_RED = HOUSE_ART.mailbox;
const PICKET = HOUSE_ART.picket;
const FRONT = WALL_DEPTH / 2;
const CHIMNEY_X = 0.62;
const CHIMNEY_Z = -0.28;
/** Roof height above the eave at the chimney, so the stack clears it. */
const CHIMNEY_BASE = EAVE + (HALF_SPAN - CHIMNEY_X) * Math.tan(PITCH);
const CHIMNEY_HEIGHT = 0.62;
const CHIMNEY_TOP = CHIMNEY_BASE + 0.4;
/**
 * A front corner of the plot, off the door axis, on the side facing the
 * village center (see `lampSide`), away from the rim forest.
 */
const LAMP: Vec3 = [1.45, 0, 1.12];
const LAMP_HEIGHT = 0.95;
const LAMP_RADIUS = 0.045;
/** Neighbors' lamps closer than this merge into one shared lamp. */
const LAMP_SHARE_DISTANCE = 1.6;
const LAMP_IRON = HOUSE_ART.lampIron;
const PUFFS_PER_HOUSE = 4;
const SMOKE_RISE = 1.3;
const SMOKE_SPEED = 0.32;
/** Puffs nearer the camera than this vanish; they fade in over `SMOKE_FADE`. */
const SMOKE_CLEAR = 4;
const SMOKE_FADE = 2;
/** Largest puff radius, so smoke never balloons over a close-up. */
const SMOKE_MAX = 0.3;
/** Real point lights are costly; only the lamps nearest spawn get one. */
const MAX_LAMP_LIGHTS = 6;
const DOOR_WOODS = HOUSE_ART.doorWoods;
const SHRUB = HOUSE_ART.shrub;

/**
 * Unit gable: a triangle 1 wide (z) and 1 tall (y) with its base on y = 0,
 * 1 long along x. Built from a three-sided cylinder, which is a prism.
 */
function GableGeometry() {
	const ref = useRef<CylinderGeometry>(null);
	useLayoutEffect(() => {
		const geometry = ref.current;
		if (!geometry) {
			return;
		}
		// Axis along x with one edge on top, then fit the triangle to 1 x 1.
		geometry.rotateZ(Math.PI / 2);
		geometry.rotateX(-Math.PI / 2);
		geometry.scale(1, 1 / 1.5, 1 / Math.sqrt(3));
		geometry.translate(0, 0.5 / 1.5, 0);
		geometry.computeVertexNormals();
	}, []);
	return <cylinderGeometry args={[1, 1, 1, 3]} ref={ref} />;
}

export interface HouseParts {
	frames: InstanceSpec[];
	gables: InstanceSpec[];
	glass: InstanceSpec[];
	lamps: Vec3[];
	/** Lit glass (the agent is working): drawn bright enough to bloom. */
	litGlass: InstanceSpec[];
	planterFlowers: InstanceSpec[];
	roofs: InstanceSpec[];
	/** Mailbox bodies and the round parts of the door and windows. */
	rounds: InstanceSpec[];
	shrubs: InstanceSpec[];
	stone: InstanceSpec[];
	timber: InstanceSpec[];
	walls: InstanceSpec[];
	wood: InstanceSpec[];
}

function offset(origin: Vec3, local: Vec3): Vec3 {
	return [origin[0] + local[0], origin[1] + local[1], origin[2] + local[2]];
}

/** One cottage: where it stands, its colours and its little variations. */
export interface CottageSpec {
	/** Chimney on the right (1) or the left (-1). */
	chimneySide: 1 | -1;
	/** Front door wood colour. */
	door: string;
	/** The windows glow (its agent is working). */
	lit: boolean;
	/** Centre of the cottage at ground level; the door faces +z. */
	origin: Vec3;
	/**
	 * Progress shown in the windows instead of `lit`: one window lights per
	 * share of `done` out of `total` steps (front left, front right, attic,
	 * then the side windows), so a run fills the house as it goes. The
	 * chimney still follows `lit`.
	 */
	pips?: { done: number; total: number };
	/** A wooden porch with shrubs, or a single doorstep. */
	porch: boolean;
	/** Uniform size (1 is World 3D's cottage, 2.5 wide). */
	scale?: number;
	/** Seed for the planter flowers. */
	seed: number;
	/** Roof colours: the agent's swatch. */
	swatch: AgentSwatch;
	/** A front yard (mailbox, pickets) and a lamp on this side. */
	yard?: 1 | -1;
}

/** A cottage's windows, in the order `pips` lights them. */
export const COTTAGE_WINDOWS = 5;

/** How many of a cottage's windows glow. */
export function litWindows(cottage: Pick<CottageSpec, "lit" | "pips">): number {
	const { pips } = cottage;
	if (!pips) {
		return cottage.lit ? COTTAGE_WINDOWS : 0;
	}
	if (pips.total <= 0) {
		return 0;
	}
	const share = Math.max(0, Math.min(pips.done, pips.total)) / pips.total;
	return Math.round(share * COTTAGE_WINDOWS);
}

/** The chimney's top, for smoke. */
export function chimneyTop(cottage: CottageSpec): Vec3 {
	const s = cottage.scale ?? 1;
	return offset(cottage.origin, [
		cottage.chimneySide * CHIMNEY_X * s,
		(CHIMNEY_TOP + 0.05) * s,
		CHIMNEY_Z * s,
	]);
}

/** A door wood picked by seed. */
export function doorWood(seed: number): string {
	return pick(DOOR_WOODS, seed);
}

/** Shingle courses per roof side; alternating tones read as tiled rows. */
const COURSES = 3;

/** A point `along` the slope from the ridge, lifted `lift` off the roof. */
function onSlope(side: number, along: number, lift: number): [number, number] {
	return [
		side * (Math.cos(PITCH) * along + Math.sin(PITCH) * lift),
		EAVE + RIDGE - Math.sin(PITCH) * along + Math.cos(PITCH) * lift,
	];
}

function addRoof(parts: HouseParts, origin: Vec3, swatch: AgentSwatch) {
	const course = SLOPE_LENGTH / COURSES;
	for (const side of [1, -1]) {
		for (let index = 0; index < COURSES; index++) {
			// Lower courses sit a touch prouder, like overlapping tiles.
			const [x, y] = onSlope(
				side,
				course * (index + 0.5),
				SLAB_THICKNESS / 2 + index * 0.016
			);
			parts.roofs.push({
				color: swatch.roof[index % 2],
				position: offset(origin, [x, y, ROOF_SHIFT]),
				rotation: [0, 0, -side * PITCH],
				scale: [course + 0.04, SLAB_THICKNESS, ROOF_DEPTH],
			});
		}
		// Barge board trimming the front gable edge.
		const [x, y] = onSlope(side, SLOPE_LENGTH / 2, SLAB_THICKNESS + 0.04);
		parts.roofs.push({
			color: swatch.ridge,
			position: offset(origin, [x, y, FRONT + FRONT_OVERHANG + 0.02]),
			rotation: [0, 0, -side * PITCH],
			scale: [SLOPE_LENGTH + 0.06, 0.09, 0.08],
		});
	}
	// Ridge cap along the top.
	parts.roofs.push({
		color: swatch.ridge,
		position: offset(origin, [0, EAVE + RIDGE + 0.09, ROOF_SHIFT]),
		rotation: [0, 0, Math.PI / 4],
		scale: [0.16, 0.16, ROOF_DEPTH + 0.06],
	});
	// The cream gable wall under the roof, front and back.
	parts.gables.push({
		position: offset(origin, [0, EAVE - 0.01, 0]),
		rotation: [0, Math.PI / 2, 0],
		scale: [WALL_DEPTH, RIDGE, WALL_WIDTH],
	});
}

/**
 * A round window: a thick cream ring, glass, and a cross mullion. `facing`
 * says which wall it sits in (front, or a side wall to the `side`).
 */
function addWindow(
	parts: HouseParts,
	at: Vec3,
	lit: boolean,
	facing: "front" | "side",
	side = 1,
	radius = 0.22
) {
	const front = facing === "front";
	const out = (depth: number): Vec3 =>
		front
			? [at[0], at[1], at[2] + depth]
			: [at[0] + side * depth, at[1], at[2]];
	// Cylinders stand on y; turn them to face out of the wall.
	const rotation: Vec3 = front ? [Math.PI / 2, 0, 0] : [0, 0, Math.PI / 2];
	parts.rounds.push({
		color: ART_CREAM,
		position: out(0),
		rotation,
		scale: [radius, 0.06, radius],
	});
	(lit ? parts.litGlass : parts.glass).push({
		position: out(0.025),
		rotation,
		scale: [radius * 0.78, 0.04, radius * 0.78],
	});
	const flat = (width: number, height: number, depth: number): Vec3 =>
		front ? [width, height, depth] : [depth, height, width];
	parts.frames.push({
		position: out(0.05),
		scale: flat(0.035, radius * 1.6, 0.02),
	});
	parts.frames.push({
		position: out(0.05),
		scale: flat(radius * 1.6, 0.035, 0.02),
	});
}

function addFrontFace(
	parts: HouseParts,
	origin: Vec3,
	theme: Scene3dTheme,
	/** How many windows glow, in COTTAGE_WINDOWS order. */
	lit: number,
	style: { door: string; porch: boolean },
	seed: number
) {
	// An arched door with its frame, a knob, and a step or a little porch.
	parts.timber.push({
		position: offset(origin, [0, FOUNDATION_HEIGHT + 0.33, FRONT + 0.02]),
		scale: [0.62, 0.66, 0.06],
	});
	parts.rounds.push({
		color: theme.wallTrim,
		position: offset(origin, [0, FOUNDATION_HEIGHT + 0.66, FRONT + 0.02]),
		rotation: [Math.PI / 2, 0, 0],
		scale: [0.31, 0.06, 0.31],
	});
	parts.wood.push({
		color: style.door,
		position: offset(origin, [0, FOUNDATION_HEIGHT + 0.3, FRONT + 0.05]),
		scale: [0.48, 0.6, 0.06],
	});
	parts.rounds.push({
		color: style.door,
		position: offset(origin, [0, FOUNDATION_HEIGHT + 0.6, FRONT + 0.05]),
		rotation: [Math.PI / 2, 0, 0],
		scale: [0.24, 0.06, 0.24],
	});
	parts.planterFlowers.push({
		color: HOUSE_ART.planterFlower,
		position: offset(origin, [0.15, FOUNDATION_HEIGHT + 0.38, FRONT + 0.09]),
		scale: 0.03,
	});
	if (style.porch) {
		parts.wood.push({
			color: theme.door,
			position: offset(origin, [0, 0.06, FRONT + 0.26]),
			scale: [1.5, 0.12, 0.5],
		});
		for (const side of [-1, 1]) {
			parts.shrubs.push({
				color: SHRUB,
				position: offset(origin, [side * 0.92, 0.2, FRONT + 0.3]),
				rotation: [side, side * 2, 0],
				scale: [0.2, 0.18, 0.2],
			});
		}
	} else {
		parts.stone.push({
			position: offset(origin, [0, 0.04, FRONT + 0.22]),
			scale: [0.78, 0.08, 0.36],
		});
	}
	// Round front windows with a cross mullion and a flower box under each.
	for (const [index, side] of [-1, 1].entries()) {
		const x = side * 0.8;
		const y = FOUNDATION_HEIGHT + 0.58;
		addWindow(
			parts,
			offset(origin, [x, y, FRONT + 0.02]),
			index < lit,
			"front"
		);
		parts.wood.push({
			color: theme.door,
			position: offset(origin, [x, y - 0.3, FRONT + 0.1]),
			scale: [0.54, 0.12, 0.18],
		});
		for (let index = 0; index < 3; index++) {
			parts.planterFlowers.push({
				color: pick(theme.flowers, seed + index + side),
				position: offset(origin, [
					x + (index - 1) * 0.16,
					y - 0.2,
					FRONT + 0.1,
				]),
				rotation: [index, side, 0],
				scale: 0.075,
			});
		}
	}
	// A little round attic window in the gable.
	addWindow(
		parts,
		offset(origin, [0, EAVE + RIDGE * 0.36, FRONT + 0.02]),
		lit > 2,
		"front",
		1,
		0.15
	);
	// One window on each side wall.
	for (const [index, side] of [-1, 1].entries()) {
		addWindow(
			parts,
			offset(origin, [side * (HALF_SPAN + 0.02), FOUNDATION_HEIGHT + 0.58, 0]),
			3 + index < lit,
			"side",
			side
		);
	}
}

function addStructure(
	parts: HouseParts,
	origin: Vec3,
	theme: Scene3dTheme,
	chimneySide: number
) {
	parts.stone.push({
		position: offset(origin, [0, FOUNDATION_HEIGHT / 2, 0]),
		scale: [WALL_WIDTH + 0.3, FOUNDATION_HEIGHT, WALL_DEPTH + 0.3],
	});
	parts.walls.push({
		color: theme.wall,
		position: offset(origin, [0, FOUNDATION_HEIGHT + WALL_HEIGHT / 2, 0]),
		scale: [WALL_WIDTH, WALL_HEIGHT, WALL_DEPTH],
	});
	// Timber frame: corner posts and a beam where the gable starts.
	for (const sx of [-1, 1]) {
		for (const sz of [-1, 1]) {
			parts.timber.push({
				position: offset(origin, [
					sx * HALF_SPAN,
					FOUNDATION_HEIGHT + WALL_HEIGHT / 2,
					sz * FRONT,
				]),
				scale: [0.12, WALL_HEIGHT, 0.12],
			});
		}
	}
	parts.timber.push({
		position: offset(origin, [0, EAVE - 0.02, 0]),
		scale: [WALL_WIDTH + 0.1, 0.1, WALL_DEPTH + 0.1],
	});
	// Chimney and its cap, on the side this house prefers.
	const side = chimneySide;
	parts.stone.push({
		color: theme.chimney,
		position: offset(origin, [
			side * CHIMNEY_X,
			CHIMNEY_TOP - CHIMNEY_HEIGHT / 2,
			CHIMNEY_Z,
		]),
		scale: [0.28, CHIMNEY_HEIGHT, 0.28],
	});
	parts.stone.push({
		color: theme.foundation,
		position: offset(origin, [side * CHIMNEY_X, CHIMNEY_TOP, CHIMNEY_Z]),
		scale: [0.36, 0.08, 0.36],
	});
}

/**
 * The front yard: a mailbox by the path on the side away from the lamp, and
 * a little picket fence along both sides of the plot.
 */
function addYard(parts: HouseParts, origin: Vec3, lampSideX: 1 | -1) {
	const mail = -lampSideX;
	const post: Vec3 = [mail * 1.12, 0, FRONT + 0.62];
	parts.wood.push({
		color: HOUSE_ART.mailPost,
		position: offset(origin, [post[0], 0.24, post[2]]),
		scale: [0.06, 0.48, 0.06],
	});
	parts.rounds.push({
		color: MAILBOX_RED,
		position: offset(origin, [post[0], 0.53, post[2]]),
		rotation: [Math.PI / 2, 0, 0],
		scale: [0.12, 0.3, 0.12],
	});
	parts.wood.push({
		color: MAILBOX_RED,
		position: offset(origin, [post[0], 0.47, post[2]]),
		scale: [0.24, 0.12, 0.3],
	});
	parts.wood.push({
		color: HOUSE_ART.flag,
		position: offset(origin, [post[0] + mail * 0.13, 0.64, post[2] - 0.06]),
		scale: [0.02, 0.16, 0.1],
	});
	for (const side of [-1, 1]) {
		const x = side * 1.56;
		for (let index = 0; index < 6; index++) {
			const z = -0.62 + index * 0.27;
			parts.wood.push({
				color: PICKET,
				position: offset(origin, [x, 0.17, z]),
				scale: [0.06, 0.34, 0.08],
			});
		}
		parts.wood.push({
			color: PICKET,
			position: offset(origin, [x, 0.22, 0.06]),
			scale: [0.04, 0.05, 1.5],
		});
	}
}

/**
 * Where two neighbors' lamps would stand side by side (the middle of the
 * village, where the lamp sides flip), they share one lamp between the plots
 * instead, so night pools never stack into a hot spot.
 */
export function shareLamps(lamps: readonly Vec3[]): Vec3[] {
	const shared: Vec3[] = [];
	const used = new Set<number>();
	for (const [index, lamp] of lamps.entries()) {
		if (used.has(index)) {
			continue;
		}
		const partner = lamps.findIndex(
			(other, at) =>
				at > index &&
				!used.has(at) &&
				Math.hypot(other[0] - lamp[0], other[2] - lamp[2]) < LAMP_SHARE_DISTANCE
		);
		const other = lamps[partner];
		if (other) {
			used.add(partner);
			shared.push([
				(lamp[0] + other[0]) / 2,
				lamp[1],
				(lamp[2] + other[2]) / 2,
			]);
		} else {
			shared.push(lamp);
		}
	}
	return shared;
}

const PART_KEYS = [
	"frames",
	"gables",
	"glass",
	"litGlass",
	"planterFlowers",
	"rounds",
	"roofs",
	"shrubs",
	"stone",
	"timber",
	"walls",
	"wood",
] as const satisfies readonly (keyof HouseParts)[];

/** Grows a part built at unit size about the cottage's origin. */
function grown(spec: InstanceSpec, origin: Vec3, s: number): InstanceSpec {
	const [x, y, z] = spec.position;
	const scale = spec.scale ?? 1;
	return {
		...spec,
		position: [
			origin[0] + (x - origin[0]) * s,
			origin[1] + (y - origin[1]) * s,
			origin[2] + (z - origin[2]) * s,
		],
		scale:
			typeof scale === "number"
				? scale * s
				: [scale[0] * s, scale[1] * s, scale[2] * s],
	};
}

/** Every cottage's parts, ready for `CottageMeshes`. */
export function buildCottages(
	cottages: readonly CottageSpec[],
	theme: Scene3dTheme
): HouseParts {
	const parts: HouseParts = {
		frames: [],
		gables: [],
		glass: [],
		lamps: [],
		litGlass: [],
		planterFlowers: [],
		rounds: [],
		roofs: [],
		shrubs: [],
		stone: [],
		timber: [],
		walls: [],
		wood: [],
	};
	for (const cottage of cottages) {
		const { origin } = cottage;
		const s = cottage.scale ?? 1;
		const starts = PART_KEYS.map((key) => parts[key].length);
		addStructure(parts, origin, theme, cottage.chimneySide);
		addRoof(parts, origin, cottage.swatch);
		addFrontFace(
			parts,
			origin,
			theme,
			litWindows(cottage),
			cottage,
			cottage.seed
		);
		if (cottage.yard) {
			addYard(parts, origin, cottage.yard);
			parts.lamps.push(
				offset(origin, [cottage.yard * LAMP[0] * s, LAMP[1], LAMP[2] * s])
			);
		}
		if (s !== 1) {
			for (const [slot, key] of PART_KEYS.entries()) {
				const list = parts[key];
				for (let item = starts[slot] ?? 0; item < list.length; item++) {
					const spec = list[item];
					if (spec) {
						list[item] = grown(spec, origin, s);
					}
				}
			}
		}
	}
	parts.lamps = shareLamps(parts.lamps);
	return parts;
}

/**
 * Cottages in the kit's look (cream timber-framed walls with siding, a
 * thick gabled roof in the agent's colours with a ridge cap, a chimney,
 * an arched door, round windows with flower boxes): every part instanced
 * across all of them. Windows glow while their agent works and every
 * window is warm at night; working cottages' chimneys smoke.
 */
export function Cottages({
	cottages,
	lamps = true,
	reducedMotion,
	theme,
}: {
	cottages: readonly CottageSpec[];
	/** Each yard's lamp post (the kit's other lamps can stand in). */
	lamps?: boolean;
	reducedMotion: boolean;
	theme: Scene3dTheme;
}) {
	const parts = useMemo(
		() => buildCottages(cottages, theme),
		[cottages, theme]
	);
	const chimneys = useMemo(
		() => cottages.filter((cottage) => cottage.lit).map(chimneyTop),
		[cottages]
	);
	return (
		<group>
			<CottageMeshes parts={parts} theme={theme} />
			{lamps ? <CottageLamps lamps={parts.lamps} theme={theme} /> : null}
			{chimneys.length > 0 ? (
				<ChimneySmoke
					chimneys={chimneys}
					color={theme.night ? theme.skyHorizon : theme.smoke}
					night={theme.night}
					reducedMotion={reducedMotion}
				/>
			) : null}
		</group>
	);
}

/** See-through cottages keep a hint of their shape. */
const GHOST_OPACITY = 0.28;

/**
 * The instanced meshes for a set of cottages. A ghost set is see-through,
 * casts no shadow and never hides what stands behind it.
 */
export function CottageMeshes({
	ghost = false,
	parts,
	theme,
}: {
	ghost?: boolean;
	parts: HouseParts;
	theme: Scene3dTheme;
}) {
	const see = ghost
		? { depthWrite: false, opacity: GHOST_OPACITY, transparent: true }
		: { fade: true };
	const solid = !ghost;
	const ink = ghost ? 0 : HOUSE_INK;
	return (
		<group>
			<InstancedParts
				castShadow={solid}
				fade={solid}
				ink={ink}
				items={parts.walls}
				receiveShadow
			>
				<boxGeometry />
				<ToonMaterial siding {...see} />
			</InstancedParts>
			<InstancedParts
				castShadow={solid}
				fade={solid}
				ink={ink}
				inkColor={theme.wall}
				items={parts.gables}
				receiveShadow
			>
				<GableGeometry />
				<ToonMaterial color={theme.wall} siding {...see} />
			</InstancedParts>
			<InstancedParts
				castShadow={solid}
				fade={solid}
				ink={ink}
				items={parts.roofs}
				receiveShadow
			>
				<boxGeometry />
				<ToonMaterial {...see} />
			</InstancedParts>
			<InstancedParts
				castShadow={solid}
				fade={solid}
				ink={ink * 0.8}
				inkColor={theme.wallTrim}
				items={parts.timber}
				receiveShadow
			>
				<boxGeometry />
				<ToonMaterial color={theme.wallTrim} {...see} />
			</InstancedParts>
			<InstancedParts
				castShadow={solid}
				fade={solid}
				ink={ink}
				inkColor={theme.foundation}
				items={parts.stone}
				receiveShadow
			>
				<boxGeometry />
				<ToonMaterial color={theme.foundation} {...see} />
			</InstancedParts>
			<InstancedParts
				castShadow={solid}
				fade={solid}
				ink={ink * 0.8}
				items={parts.wood}
				receiveShadow
			>
				<boxGeometry />
				<ToonMaterial {...see} />
			</InstancedParts>
			<InstancedParts
				castShadow={solid}
				fade={solid}
				ink={ink * 0.8}
				items={parts.rounds}
				receiveShadow
			>
				<cylinderGeometry args={[1, 1, 1, 16]} />
				<ToonMaterial {...see} />
			</InstancedParts>
			<InstancedParts castShadow={solid} ink={ink} items={parts.shrubs}>
				<sphereGeometry args={[1, 10, 7]} />
				<ToonMaterial {...see} />
			</InstancedParts>
			<InstancedParts items={parts.frames}>
				<boxGeometry />
				<ToonMaterial color={ART_CREAM} {...see} />
			</InstancedParts>
			<InstancedParts items={parts.glass}>
				<cylinderGeometry args={[1, 1, 1, 16]} />
				{theme.night ? (
					// Every window glows warm at night, bright enough to bloom.
					<CurvedBasicMaterial
						color={glow(theme.windowIdle, NIGHT_WINDOW_GLOW)}
						toneMapped={false}
						{...(ghost ? see : {})}
					/>
				) : (
					<ToonMaterial
						color={theme.windowIdle}
						emissive={theme.windowIdle}
						emissiveIntensity={0.25}
						{...see}
					/>
				)}
			</InstancedParts>
			<InstancedParts items={parts.litGlass}>
				<cylinderGeometry args={[1, 1, 1, 16]} />
				<CurvedBasicMaterial
					color={glow(theme.windowWorking, LIT_GLOW)}
					toneMapped={false}
					{...(ghost ? see : {})}
				/>
			</InstancedParts>
			<InstancedParts items={parts.planterFlowers}>
				<sphereGeometry args={[1, 7, 5]} />
				<ToonMaterial {...see} />
			</InstancedParts>
		</group>
	);
}

/** A hex color as linear RGB scaled past white, so it blooms. */
function glow(hex: string, gain: number): [number, number, number] {
	const [r, g, b] = linearRgb(hex);
	return [r * gain, g * gain, b * gain];
}

/** Peak opacity of a lamp's light pool on the ground. */
const POOL_OPACITY = 0.35;

/**
 * Warm light pool: lamp-colored at the center, fading smoothly to nothing,
 * so it reads as light on the ground rather than a painted disc.
 */
function useLampPoolCanvas(): HTMLCanvasElement | null {
	return useMemo(() => {
		if (typeof document === "undefined") {
			return null;
		}
		const canvas = document.createElement("canvas");
		canvas.width = 128;
		canvas.height = 128;
		const context = canvas.getContext("2d");
		if (!context) {
			return null;
		}
		const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
		gradient.addColorStop(0, hexAlpha(HOUSE_ART.windowPool, 1));
		gradient.addColorStop(0.3, hexAlpha(HOUSE_ART.windowPool, 0.7));
		gradient.addColorStop(0.65, hexAlpha(HOUSE_ART.windowPool, 0.22));
		gradient.addColorStop(1, hexAlpha(HOUSE_ART.windowPool, 0));
		context.fillStyle = gradient;
		context.fillRect(0, 0, 128, 128);
		return canvas;
	}, []);
}

export function CottageLamps({
	lamps,
	theme,
}: {
	lamps: Vec3[];
	theme: Scene3dTheme;
}) {
	const pool = useLampPoolCanvas();
	const poles = useMemo(
		() =>
			lamps.map((lamp) => ({
				position: offset(lamp, [0, LAMP_HEIGHT / 2, 0]),
				scale: [LAMP_RADIUS, LAMP_HEIGHT, LAMP_RADIUS] as Vec3,
			})),
		[lamps]
	);
	const heads = useMemo(
		() =>
			lamps.map((lamp) => ({
				position: offset(lamp, [0, LAMP_HEIGHT + 0.08, 0]),
				scale: [0.16, 0.2, 0.16] as Vec3,
			})),
		[lamps]
	);
	const bases = useMemo(
		() =>
			lamps.map((lamp) => ({
				position: offset(lamp, [0, 0.07, 0]),
				scale: [0.09, 0.14, 0.09] as Vec3,
			})),
		[lamps]
	);
	const caps = useMemo(
		() =>
			lamps.map((lamp) => ({
				position: offset(lamp, [0, LAMP_HEIGHT + 0.24, 0]),
				scale: [0.15, 0.12, 0.15] as Vec3,
			})),
		[lamps]
	);
	const pools = useMemo(
		() =>
			lamps.map((lamp) => ({
				position: offset(lamp, [0, 0.06, 0.1]),
				rotation: [-Math.PI / 2, 0, 0] as Vec3,
				scale: 3.4,
			})),
		[lamps]
	);
	const lit = theme.night ? lamps.slice(0, MAX_LAMP_LIGHTS) : [];
	return (
		<group>
			<InstancedParts
				castShadow
				ink={HOUSE_INK * 0.6}
				inkColor={LAMP_IRON}
				items={poles}
			>
				<cylinderGeometry args={[0.8, 1, 1, 10]} />
				<ToonMaterial color={LAMP_IRON} />
			</InstancedParts>
			<InstancedParts items={bases}>
				<cylinderGeometry args={[1, 1.15, 1, 12]} />
				<ToonMaterial color={LAMP_IRON} />
			</InstancedParts>
			<InstancedParts ink={HOUSE_INK * 0.6} inkColor={LAMP_IRON} items={caps}>
				<coneGeometry args={[1, 1, 12]} />
				<ToonMaterial color={LAMP_IRON} />
			</InstancedParts>
			<InstancedParts items={heads}>
				<sphereGeometry args={[0.6, 16, 12]} />
				{theme.night ? (
					<CurvedBasicMaterial
						color={glow(theme.lantern, LANTERN_GLOW)}
						toneMapped={false}
					/>
				) : (
					<ToonMaterial
						color={HOUSE_ART.lampBulb}
						emissive={HOUSE_ART.lampBulbGlow}
						emissiveIntensity={0.35}
					/>
				)}
			</InstancedParts>
			{theme.night && pool ? (
				<InstancedParts items={pools}>
					<planeGeometry args={[1, 1, 4, 4]} />
					<CurvedBasicMaterial
						depthWrite={false}
						opacity={POOL_OPACITY}
						polygonOffset
						polygonOffsetFactor={-2}
						toneMapped={false}
						transparent
					>
						<canvasTexture args={[pool]} attach="map" />
					</CurvedBasicMaterial>
				</InstancedParts>
			) : null}
			{lit.map((lamp) => (
				<pointLight
					color={HOUSE_ART.lampLight}
					decay={1.6}
					distance={7}
					intensity={1.5}
					key={lamp.join(",")}
					position={offset(lamp, [0, LAMP_HEIGHT + 0.05, 0])}
				/>
			))}
		</group>
	);
}

/** Puffs drift up from the chimneys of houses whose agent is working. */
export function ChimneySmoke({
	chimneys,
	color,
	night,
	reducedMotion,
}: {
	chimneys: Vec3[];
	color: string;
	/**
	 * Night smoke is a pale, low wisp in the horizon's color (never dark
	 * blots across the moon), not lit white puffs.
	 */
	night: boolean;
	reducedMotion: boolean;
}) {
	const ref = useRef<InstancedMesh>(null);
	const count = chimneys.length * PUFFS_PER_HOUSE;
	const puffs = useMemo(() => {
		const items: InstanceSpec[] = [];
		for (const chimney of chimneys) {
			for (let index = 0; index < PUFFS_PER_HOUSE; index++) {
				items.push(
					puffAt(chimney, index, index / PUFFS_PER_HOUSE, night ? 0.55 : 1)
				);
			}
		}
		return items;
	}, [chimneys, night]);
	useFrame(({ camera, clock }) => {
		const mesh = ref.current;
		if (!mesh) {
			return;
		}
		const time = reducedMotion ? 0 : clock.elapsedTime * SMOKE_SPEED;
		const eye = camera.position;
		const items: InstanceSpec[] = [];
		for (const [house, chimney] of chimneys.entries()) {
			for (let index = 0; index < PUFFS_PER_HOUSE; index++) {
				const phase = reducedMotion
					? index / PUFFS_PER_HOUSE
					: (time + index / PUFFS_PER_HOUSE + house * 0.37) % 1;
				const puff = puffAt(chimney, index, phase, night ? 0.55 : 1);
				// Puffs close to a close-up camera thin out instead of
				// drifting across faces as big blurs.
				const near = Math.hypot(
					puff.position[0] - eye.x,
					puff.position[1] - eye.y,
					puff.position[2] - eye.z
				);
				const keep = Math.min(
					1,
					Math.max(0, (near - SMOKE_CLEAR) / SMOKE_FADE)
				);
				items.push({ ...puff, scale: (puff.scale as number) * keep });
			}
		}
		writeInstances(mesh, items);
	});
	useEffect(() => {
		if (ref.current) {
			writeInstances(ref.current, puffs);
		}
	}, [puffs]);
	return (
		<instancedMesh args={[undefined, undefined, count]} key={count} ref={ref}>
			<sphereGeometry args={[1, 14, 10]} />
			{night ? (
				<CurvedBasicMaterial
					color={color}
					depthWrite={false}
					opacity={0.35}
					transparent
				/>
			) : (
				<ToonMaterial
					color={color}
					depthWrite={false}
					emissive={color}
					emissiveIntensity={0.3}
					opacity={0.7}
					transparent
				/>
			)}
		</instancedMesh>
	);
}

/** One puff, `phase` of the way up; `rise` scales how high smoke climbs. */
function puffAt(
	chimney: Vec3,
	index: number,
	phase: number,
	rise = 1
): InstanceSpec {
	const grow = 0.08 + phase * 0.2;
	// Thins out as it rises, so the top puffs melt into the sky.
	const fade = 1 - phase ** 2;
	return {
		position: [
			chimney[0] + Math.sin(phase * 4 + index) * 0.08 + phase * 0.3,
			chimney[1] + phase * SMOKE_RISE * rise,
			chimney[2] - phase * 0.1,
		],
		scale: Math.min(SMOKE_MAX, grow * fade),
	};
}
