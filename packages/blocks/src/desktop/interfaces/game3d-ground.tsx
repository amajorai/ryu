/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { type ReactNode, useMemo, useRef } from "react";
import type { Group } from "three";
import { GrassBlades, growBlades, type LawnTile } from "./game3d-grass.tsx";
import {
	cliffMesh,
	groundMesh,
	type IslandShape,
	islandShape,
	type MeshData,
	onIsland,
	shoreBand,
	shoreDistance,
} from "./game3d-island.ts";
import { lawnAlbedo, mixRgb, type Rgb } from "./game3d-lawn.ts";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { DOUBLE_SIDE } from "./game3d-math.ts";
import { type Scene3dTheme, SHORE_ART } from "./game3d-palette.ts";
import {
	CURVE_UNIFORMS,
	linearRgb,
	QUALITY,
	type RenderQuality,
} from "./game3d-toon.ts";

/**
 * The kit's ground: a rounded island with a wobbly shore, a patchy cel
 * lawn, a rocky earth cliff underneath and a turquoise sea (indigo at
 * night) with foam lapping at the shore, out to every edge of the frame.
 *
 * - `IsoIsland` is the diorama's plinth: a game gives the size of its
 *   playable area and may paint the ground (fields, yards, paving) with
 *   `paint`.
 * - `IslandGrass` grows the swaying lawn over it, except where `avoid`
 *   says (under buildings, on fields and paths).
 * - `Sea`, `FollowingPlane` and `MeshGeometry` are the pieces World 3D
 *   builds its own island from.
 */

/** The cliff's foot, under the sea. */
export const CLIFF_BOTTOM = -1.6;
export const WATER_LEVEL = -0.95;
/** The sea travels with the bend center; finely cut so it bends smoothly. */
const WATER_SIZE = 180;
const WATER_SEGMENTS = 72;

const MESH_IDS = new WeakMap<MeshData, number>();
let nextMeshId = 0;

/** A stable key per mesh, so a new mesh remounts its geometry. */
function meshKey(data: MeshData): number {
	let id = MESH_IDS.get(data);
	if (id === undefined) {
		nextMeshId += 1;
		id = nextMeshId;
		MESH_IDS.set(data, id);
	}
	return id;
}

/** Typed-array mesh data as a buffer geometry. */
export function MeshGeometry({ data }: { data: MeshData }) {
	return (
		<bufferGeometry key={meshKey(data)}>
			<bufferAttribute args={[data.position, 3]} attach="attributes-position" />
			<bufferAttribute args={[data.normal, 3]} attach="attributes-normal" />
			{data.color ? (
				<bufferAttribute args={[data.color, 3]} attach="attributes-color" />
			) : null}
			<bufferAttribute args={[data.index, 1]} attach="index" />
		</bufferGeometry>
	);
}

/**
 * A finely cut plane that stays centered under the bend, so however far
 * the player walks the ground plane around the island still curves away.
 */
export function FollowingPlane({
	children,
	color,
	y,
}: {
	children?: ReactNode;
	color: string;
	y: number;
}) {
	const ref = useRef<Group>(null);
	useFrame(() => {
		const center = CURVE_UNIFORMS.ryuCurveCenter.value;
		ref.current?.position.set(Math.round(center.x), y, Math.round(center.y));
	});
	return (
		<group ref={ref}>
			<mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
				<planeGeometry
					args={[WATER_SIZE, WATER_SIZE, WATER_SEGMENTS, WATER_SEGMENTS]}
				/>
				<ToonMaterial color={color} />
			</mesh>
			{children}
		</group>
	);
}

/** The sea, with pale foam bands lapping at the shore. */
export function Sea({ color, shape }: { color: string; shape: IslandShape }) {
	const foam = useMemo(
		() => ({
			inner: shoreBand(shape, WATER_LEVEL + 0.03, 0.12, 0.5),
			outer: shoreBand(shape, WATER_LEVEL + 0.02, 0.85, 1.15),
		}),
		[shape]
	);
	return (
		<group>
			<FollowingPlane color={color} y={WATER_LEVEL} />
			<mesh>
				<MeshGeometry data={foam.inner} />
				<CurvedBasicMaterial color={SHORE_ART.foamInner} side={DOUBLE_SIDE} />
			</mesh>
			<mesh>
				<MeshGeometry data={foam.outer} />
				<CurvedBasicMaterial
					color={SHORE_ART.foamOuter}
					opacity={0.7}
					side={DOUBLE_SIDE}
					transparent
				/>
			</mesh>
		</group>
	);
}

export function smooth(from: number, to: number, value: number): number {
	const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
	return t * t * (3 - 2 * t);
}

/** The island a diorama of `width` x `depth` world units stands on. */
export function islandFor(
	width: number,
	depth: number,
	margin = 2
): IslandShape {
	return islandShape({ height: depth, width }, true, margin);
}

/**
 * The diorama's island: lawn (or whatever `paint` lays down) on top, the
 * earth and rock cliff, and the sea with foam all around.
 */
export function IsoIsland({
	paint,
	shape,
	theme,
}: {
	/** Ground color at (x, z) in linear RGB, or null for lawn. */
	paint?: (x: number, z: number) => Rgb | null;
	shape: IslandShape;
	theme: Scene3dTheme;
}) {
	const meshes = useMemo(() => {
		const height = (x: number, z: number) =>
			-smooth(-0.8, 0, shoreDistance(shape, x, z)) * 0.14;
		const fallback = linearRgb(theme.grass[0]);
		const ground = groundMesh(
			shape,
			height,
			(x, z) => paint?.(x, z) ?? lawnAlbedo(theme, x, z) ?? fallback,
			0.25
		);
		const lip = mixRgb(fallback, linearRgb(theme.cliff), 0.35);
		const cliff = linearRgb(theme.cliff);
		const deep = linearRgb(theme.cliffDeep);
		const wall = cliffMesh(shape, height, CLIFF_BOTTOM, (_, __, t) => {
			if (t < 0.12) {
				return lip;
			}
			return mixRgb(cliff, deep, smooth(0.2, 1, t));
		});
		return { ground, wall };
	}, [paint, shape, theme]);
	return (
		<group>
			<mesh receiveShadow>
				<MeshGeometry data={meshes.ground} />
				<ToonMaterial vertexColors />
			</mesh>
			<mesh receiveShadow>
				<MeshGeometry data={meshes.wall} />
				<ToonMaterial vertexColors />
			</mesh>
			{theme.water ? (
				<Sea color={theme.water} shape={shape} />
			) : (
				<FollowingPlane color={theme.sky} y={CLIFF_BOTTOM - 0.7} />
			)}
		</group>
	);
}

/**
 * The swaying lawn over an island, kept off whatever `avoid` marks (fields,
 * floors, paving) and a little in from the shore, within the quality's
 * blade budget.
 */
export function IslandGrass({
	avoid,
	quality,
	reducedMotion,
	shape,
	theme,
}: {
	avoid?: (x: number, z: number) => boolean;
	quality: RenderQuality;
	reducedMotion: boolean;
	shape: IslandShape;
	theme: Scene3dTheme;
}) {
	const budget = QUALITY[quality];
	const blades = useMemo(() => {
		const tiles: LawnTile[] = [];
		const columns = Math.ceil(shape.halfWidth);
		const rows = Math.ceil(shape.halfDepth);
		for (let y = -rows; y <= rows; y++) {
			for (let x = -columns; x <= columns; x++) {
				if (!onIsland(shape, x, y, 0.1) || avoid?.(x, y)) {
					continue;
				}
				tiles.push({ cx: x, cz: y, weight: 1, x, y });
			}
		}
		return growBlades({
			keep: (_, x, z) => onIsland(shape, x, z, 0.12) && !avoid?.(x, z),
			max: budget.maxGrass,
			perTile: budget.grassPerTile,
			theme,
			tiles,
		});
	}, [avoid, budget, shape, theme]);
	return (
		<GrassBlades blades={blades} reducedMotion={reducedMotion} theme={theme} />
	);
}
