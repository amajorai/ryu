/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Group, Mesh, MeshBasicMaterial } from "three";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { type DishKind, dishFood, dishKind } from "./kitchen-dish.tsx";
import type { StationKind } from "./kitchen-model.ts";
import { type KitchenPalette, pickById } from "./kitchen-palette.ts";

/**
 * Kitchen props: counters, the three kinds of station (stove, chopping
 * board, grill), the pass, plated dishes, steam, flames and smoke. Shapes
 * are primitive (boxes, cylinders, spheres) with the World 3D cel look and
 * ink outlines, so the kitchen reads like a toy set at any size.
 */

export type Vec3 = [number, number, number];

/** Outline width for props (chefs use a touch more). */
export const PROP_INK = 0.016;
export const COUNTER_HEIGHT = 0.86;
/** How far in front of the chef the station counter sits. */
export const COUNTER_OFFSET = 0.85;
const COUNTER_WIDTH = 2.1;
const COUNTER_DEPTH = 0.9;
const TOP = COUNTER_HEIGHT + 0.08;

/** A plain counter block with a slab top and a dark kick plinth. */
export function Counter({
	depth = COUNTER_DEPTH,
	height = COUNTER_HEIGHT,
	palette,
	position,
	top,
	width,
}: {
	depth?: number;
	height?: number;
	palette: KitchenPalette;
	position: Vec3;
	top?: string;
	width: number;
}) {
	const [x, , z] = position;
	return (
		<group position={[x, 0, z]}>
			<ToonMesh
				castShadow
				color={palette.counterBody}
				ink={PROP_INK}
				position={[0, height / 2, 0]}
				receiveShadow
			>
				<boxGeometry args={[width, height, depth]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={top ?? palette.counterTop}
				ink={PROP_INK}
				position={[0, height + 0.04, 0]}
				receiveShadow
			>
				<boxGeometry args={[width + 0.08, 0.08, depth + 0.08]} />
			</ToonMesh>
			<mesh position={[0, 0.06, depth / 2 - 0.02]}>
				<boxGeometry args={[width - 0.06, 0.12, 0.06]} />
				<ToonMaterial color={palette.counterTop} />
			</mesh>
		</group>
	);
}

/** Small rising puffs (steam or smoke) above a point. */
function Puffs({
	color,
	count,
	dark,
	reduced,
	rise,
	seed,
	size,
}: {
	color: string;
	count: number;
	/** Smoke is opaque-ish and grey; steam is faint and white. */
	dark: boolean;
	reduced: boolean;
	rise: number;
	seed: number;
	size: number;
}) {
	const puffs = useRef<(Mesh | null)[]>([]);
	useFrame(({ clock }) => {
		const time = reduced ? 0.6 : clock.elapsedTime;
		for (const [index, puff] of puffs.current.entries()) {
			if (!puff) {
				continue;
			}
			const phase = (time * (dark ? 0.42 : 0.55) + index / count + seed) % 1;
			puff.position.set(
				Math.sin((phase + index) * 5.1) * 0.1 - (dark ? phase * 0.7 : 0),
				phase * rise,
				Math.cos((phase + index) * 3.7) * 0.08
			);
			const grow = size * (0.55 + phase * 1.1);
			puff.scale.setScalar(grow);
			const material = puff.material as MeshBasicMaterial;
			material.opacity = (dark ? 0.7 : 0.55) * Math.sin(phase * Math.PI);
		}
	});
	return (
		<group>
			{Array.from({ length: count }, (_, index) => (
				<mesh
					key={`puff-${index.toString()}`}
					ref={(mesh) => {
						puffs.current[index] = mesh;
					}}
				>
					<sphereGeometry args={[1, 10, 8]} />
					<meshBasicMaterial color={color} depthWrite={false} transparent />
				</mesh>
			))}
		</group>
	);
}

/** Flickering flame cones under a pot (HDR emissive, so they bloom). */
function Flames({
	palette,
	reduced,
	seed,
}: {
	palette: KitchenPalette;
	reduced: boolean;
	seed: number;
}) {
	const group = useRef<Group>(null);
	useFrame(({ clock }) => {
		const node = group.current;
		if (!node) {
			return;
		}
		const time = reduced ? 0 : clock.elapsedTime;
		for (const [index, flame] of node.children.entries()) {
			flame.scale.y = 1 + Math.sin(time * 14 + index * 2.1 + seed) * 0.25;
		}
	});
	return (
		<group position={[0, TOP + 0.04, 0]} ref={group}>
			{[0, 1, 2, 3, 4, 5].map((index) => {
				const angle = (index / 6) * Math.PI * 2;
				return (
					<mesh
						key={`flame-${index.toString()}`}
						position={[Math.cos(angle) * 0.17, 0.05, Math.sin(angle) * 0.17]}
					>
						<coneGeometry args={[0.045, 0.12, 6]} />
						<meshBasicMaterial color={palette.flame} toneMapped={false} />
					</mesh>
				);
			})}
		</group>
	);
}

/** The stove: burner plate, a pot of soup and a side pan; an oven door. */
function Stove({
	burnt,
	palette,
	reduced,
	seed,
	soup,
	working,
}: {
	burnt: boolean;
	palette: KitchenPalette;
	reduced: boolean;
	seed: number;
	soup: string;
	working: boolean;
}) {
	return (
		<group>
			<ToonMesh
				color={palette.grillTop}
				ink={PROP_INK}
				position={[0, TOP + 0.02, 0]}
			>
				<boxGeometry args={[1.5, 0.04, 0.72]} />
			</ToonMesh>
			<group position={[-0.25, 0, 0]}>
				{working ? (
					<Flames palette={palette} reduced={reduced} seed={seed} />
				) : null}
				<ToonMesh
					castShadow
					color={burnt ? palette.pan : palette.steel}
					ink={PROP_INK}
					position={[0, TOP + 0.2, 0]}
				>
					<cylinderGeometry args={[0.27, 0.24, 0.32, 20]} />
				</ToonMesh>
				<mesh position={[0, TOP + 0.355, 0]}>
					<cylinderGeometry args={[0.24, 0.24, 0.02, 20]} />
					{burnt ? (
						<meshBasicMaterial
							color={palette.status.burnt}
							toneMapped={false}
						/>
					) : (
						<ToonMaterial color={soup} />
					)}
				</mesh>
				{[-1, 1].map((side) => (
					<ToonMesh
						color={palette.pan}
						ink={PROP_INK}
						key={`handle-${side.toString()}`}
						position={[side * 0.31, TOP + 0.3, 0]}
					>
						<boxGeometry args={[0.08, 0.04, 0.12]} />
					</ToonMesh>
				))}
				{working && !burnt ? (
					<group position={[0, TOP + 0.4, 0]}>
						<Puffs
							color={palette.steam}
							count={5}
							dark={false}
							reduced={reduced}
							rise={0.9}
							seed={seed}
							size={0.07}
						/>
					</group>
				) : null}
			</group>
			<group position={[0.45, 0, 0.04]}>
				<ToonMesh
					castShadow
					color={palette.pan}
					ink={PROP_INK}
					position={[0, TOP + 0.08, 0]}
				>
					<cylinderGeometry args={[0.19, 0.17, 0.07, 18]} />
				</ToonMesh>
				<ToonMesh
					color={palette.woodDark}
					ink={PROP_INK}
					position={[0.32, TOP + 0.1, 0.06]}
					rotation={[0, -0.35, 0]}
				>
					<boxGeometry args={[0.3, 0.04, 0.06]} />
				</ToonMesh>
			</group>
			<OvenDoor palette={palette} />
		</group>
	);
}

/** Oven door on the counter front (below the stove). */
function OvenDoor({ palette }: { palette: KitchenPalette }) {
	const front = COUNTER_DEPTH / 2 + 0.01;
	return (
		<group position={[0, 0, front]}>
			<mesh position={[0, 0.47, 0]}>
				<boxGeometry args={[1.3, 0.56, 0.03]} />
				<ToonMaterial color={palette.grillTop} />
			</mesh>
			<mesh position={[0, 0.47, 0.02]}>
				<boxGeometry args={[1.0, 0.3, 0.02]} />
				<ToonMaterial color={palette.pan} />
			</mesh>
			<mesh position={[0, 0.8, 0.04]}>
				<boxGeometry args={[0.9, 0.04, 0.04]} />
				<ToonMaterial color={palette.steel} />
			</mesh>
		</group>
	);
}

/** The chopping board: a wooden board, a vegetable and its slices. */
function Board({
	palette,
	veg,
	working,
}: {
	palette: KitchenPalette;
	veg: string;
	working: boolean;
}) {
	return (
		<group>
			<ToonMesh
				castShadow
				color={palette.wood}
				ink={PROP_INK}
				position={[0, TOP + 0.03, 0]}
			>
				<boxGeometry args={[0.92, 0.06, 0.58]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={veg}
				ink={PROP_INK}
				position={[-0.2, TOP + 0.15, 0]}
				scale={[1, 0.85, 1]}
			>
				<sphereGeometry args={[0.13, 16, 12]} />
			</ToonMesh>
			{[0, 1, 2].map((index) => (
				<ToonMesh
					color={veg}
					ink={PROP_INK}
					key={`slice-${index.toString()}`}
					position={[0.08 + index * 0.08, TOP + 0.08, 0.02]}
					rotation={[0, 0, Math.PI / 2]}
				>
					<cylinderGeometry args={[0.09, 0.09, 0.03, 14]} />
				</ToonMesh>
			))}
			{working ? null : (
				<group position={[0.32, TOP + 0.075, -0.16]} rotation={[0, 0.5, 0]}>
					<Knife palette={palette} />
				</group>
			)}
			<group position={[0.82, 0, -0.08]}>
				<ToonMesh
					castShadow
					color={palette.steel}
					ink={PROP_INK}
					position={[0, TOP + 0.09, 0]}
				>
					<cylinderGeometry args={[0.16, 0.13, 0.18, 16]} />
				</ToonMesh>
				<mesh position={[0, TOP + 0.185, 0]}>
					<cylinderGeometry args={[0.14, 0.14, 0.02, 16]} />
					<ToonMaterial color={palette.food[2] ?? veg} />
				</mesh>
			</group>
		</group>
	);
}

/** A kitchen knife lying flat (blade along +x). */
export function Knife({ palette }: { palette: KitchenPalette }) {
	return (
		<group>
			<mesh position={[0.1, 0, 0]}>
				<boxGeometry args={[0.24, 0.015, 0.06]} />
				<ToonMaterial color={palette.steel} />
			</mesh>
			<mesh position={[-0.08, 0, 0]}>
				<boxGeometry args={[0.13, 0.03, 0.045]} />
				<ToonMaterial color={palette.woodDark} />
			</mesh>
		</group>
	);
}

/** A ladle: a bowl on a long handle. */
export function Ladle({ palette }: { palette: KitchenPalette }) {
	return (
		<group>
			<mesh position={[0, 0.12, 0]}>
				<cylinderGeometry args={[0.014, 0.014, 0.34, 6]} />
				<ToonMaterial color={palette.steel} />
			</mesh>
			<mesh position={[0, -0.06, 0]}>
				<sphereGeometry args={[0.055, 10, 8]} />
				<ToonMaterial color={palette.steel} />
			</mesh>
		</group>
	);
}

/** A spatula: a flat steel head on a wooden handle. */
export function Spatula({ palette }: { palette: KitchenPalette }) {
	return (
		<group>
			<mesh position={[0, 0.1, 0]}>
				<cylinderGeometry args={[0.016, 0.016, 0.24, 6]} />
				<ToonMaterial color={palette.woodDark} />
			</mesh>
			<mesh position={[0, -0.05, 0]}>
				<boxGeometry args={[0.11, 0.1, 0.012]} />
				<ToonMaterial color={palette.steel} />
			</mesh>
		</group>
	);
}

/** The grill: a dark plate with bars, two patties and embers when lit. */
function Grill({
	palette,
	working,
}: {
	palette: KitchenPalette;
	working: boolean;
}) {
	return (
		<group>
			<ToonMesh
				castShadow
				color={palette.grillTop}
				ink={PROP_INK}
				position={[0, TOP + 0.04, 0]}
			>
				<boxGeometry args={[1.2, 0.08, 0.66]} />
			</ToonMesh>
			{working ? (
				<mesh position={[0, TOP + 0.085, 0]}>
					<boxGeometry args={[1.08, 0.01, 0.54]} />
					<meshBasicMaterial color={palette.flame} toneMapped={false} />
				</mesh>
			) : null}
			{[-0.4, -0.2, 0, 0.2, 0.4].map((x) => (
				<mesh key={`bar-${x.toString()}`} position={[x, TOP + 0.1, 0]}>
					<boxGeometry args={[0.04, 0.03, 0.58]} />
					<ToonMaterial color={palette.steel} />
				</mesh>
			))}
			{[-0.22, 0.24].map((x) => (
				<ToonMesh
					castShadow
					color={palette.woodDark}
					ink={PROP_INK}
					key={`patty-${x.toString()}`}
					position={[x, TOP + 0.14, 0.02]}
				>
					<cylinderGeometry args={[0.14, 0.14, 0.06, 16]} />
				</ToonMesh>
			))}
			<OvenDoor palette={palette} />
		</group>
	);
}

/**
 * One chef's station: the counter in front of the chef with its appliance,
 * smoke when an order burnt, and a hover outline when picked.
 */
export function Station({
	burnt,
	id,
	kind,
	palette,
	position,
	reduced,
	working,
}: {
	burnt: boolean;
	id: string;
	kind: StationKind;
	palette: KitchenPalette;
	position: Vec3;
	reduced: boolean;
	working: boolean;
}) {
	const seed = (pickById([0, 1, 2, 3, 4, 5, 6, 7], id) ?? 0) / 8;
	const food = pickById(palette.food, id) ?? palette.flame;
	return (
		<group position={position}>
			<Counter
				palette={palette}
				position={[0, 0, 0]}
				top={kind === "board" ? palette.counterTop : palette.steel}
				width={COUNTER_WIDTH}
			/>
			{kind === "stove" ? (
				<Stove
					burnt={burnt}
					palette={palette}
					reduced={reduced}
					seed={seed}
					soup={food}
					working={working}
				/>
			) : null}
			{kind === "board" ? (
				<Board palette={palette} veg={food} working={working} />
			) : null}
			{kind === "grill" ? <Grill palette={palette} working={working} /> : null}
			{burnt ? (
				<group position={[kind === "stove" ? -0.4 : -0.3, TOP + 0.3, 0]}>
					<Puffs
						color={palette.smoke}
						count={9}
						dark
						reduced={reduced}
						rise={2.2}
						seed={seed}
						size={0.2}
					/>
					{palette.mode === "dark" ? (
						<pointLight
							color={palette.status.burnt}
							decay={2}
							distance={2.6}
							intensity={2.4}
							position={[0, 0.1, 0.2]}
						/>
					) : null}
					<mesh position={[0, -0.3, 0]} rotation={[-Math.PI / 2, 0, 0]}>
						<ringGeometry args={[0.32, 0.42, 28]} />
						<meshBasicMaterial
							color={palette.status.burnt}
							toneMapped={false}
							transparent
						/>
					</mesh>
				</group>
			) : null}
		</group>
	);
}

/** A plated dish on the pass, glowing in the ready colour. */
export function Dish({
	hovered,
	id,
	onHover,
	onServe,
	palette,
	position,
	reduced,
}: {
	hovered: boolean;
	id: string;
	onHover: (id: string | null) => void;
	onServe: (id: string) => void;
	palette: KitchenPalette;
	position: Vec3;
	reduced: boolean;
}) {
	const lift = useRef<Group>(null);
	const glow = useRef<Mesh>(null);
	const kind = dishKind(id);
	const food = dishFood(palette, id);
	useFrame(({ clock }, delta) => {
		const node = lift.current;
		if (node) {
			const target = hovered ? 0.1 : 0;
			node.position.y += (target - node.position.y) * Math.min(1, delta * 12);
		}
		const ring = glow.current;
		if (ring) {
			const pulse = reduced
				? 0.8
				: 0.65 + Math.sin(clock.elapsedTime * 3) * 0.2;
			(ring.material as MeshBasicMaterial).opacity = hovered ? 1 : pulse;
		}
	});
	return (
		<group position={position}>
			<mesh position={[0, 0.012, 0]} ref={glow} rotation={[-Math.PI / 2, 0, 0]}>
				<ringGeometry args={[0.34, 0.44, 32]} />
				<meshBasicMaterial
					color={palette.status.ready}
					depthWrite={false}
					toneMapped={false}
					transparent
				/>
			</mesh>
			<group
				onClick={(event) => {
					event.stopPropagation();
					onServe(id);
				}}
				onPointerOut={() => onHover(null)}
				onPointerOver={(event) => {
					event.stopPropagation();
					onHover(id);
				}}
				ref={lift}
			>
				<ToonMesh
					castShadow
					color={palette.plate}
					ink={PROP_INK}
					position={[0, 0.03, 0]}
				>
					<cylinderGeometry args={[0.3, 0.24, 0.05, 24]} />
				</ToonMesh>
				<DishFood food={food} kind={kind} palette={palette} />
			</group>
		</group>
	);
}

function DishFood({
	food,
	kind,
	palette,
}: {
	food: string;
	kind: DishKind;
	palette: KitchenPalette;
}) {
	if (kind === "bowl") {
		return (
			<group position={[0, 0.06, 0]}>
				<ToonMesh
					castShadow
					color={palette.plate}
					ink={PROP_INK}
					position={[0, 0.07, 0]}
				>
					<cylinderGeometry args={[0.2, 0.13, 0.14, 20]} />
				</ToonMesh>
				<mesh position={[0, 0.135, 0]}>
					<cylinderGeometry args={[0.18, 0.18, 0.02, 20]} />
					<ToonMaterial color={food} />
				</mesh>
				<mesh position={[0.06, 0.15, 0.03]}>
					<sphereGeometry args={[0.04, 10, 8]} />
					<ToonMaterial color={palette.food[2] ?? food} />
				</mesh>
			</group>
		);
	}
	if (kind === "burger") {
		return (
			<group position={[0, 0.06, 0]}>
				<ToonMesh color={palette.wood} ink={PROP_INK} position={[0, 0.03, 0]}>
					<cylinderGeometry args={[0.16, 0.16, 0.06, 18]} />
				</ToonMesh>
				<ToonMesh
					color={palette.food[2] ?? food}
					ink={PROP_INK}
					position={[0, 0.07, 0]}
				>
					<cylinderGeometry args={[0.18, 0.18, 0.02, 18]} />
				</ToonMesh>
				<ToonMesh
					color={palette.woodDark}
					ink={PROP_INK}
					position={[0, 0.1, 0]}
				>
					<cylinderGeometry args={[0.16, 0.16, 0.05, 18]} />
				</ToonMesh>
				<ToonMesh
					castShadow
					color={palette.wood}
					ink={PROP_INK}
					position={[0, 0.14, 0]}
					scale={[1, 0.6, 1]}
				>
					<sphereGeometry
						args={[0.165, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2]}
					/>
				</ToonMesh>
			</group>
		);
	}
	return (
		<group position={[0, 0.07, 0]}>
			{[0, 1, 2, 3, 4].map((index) => {
				const angle = (index / 5) * Math.PI * 2;
				return (
					<ToonMesh
						color={index % 2 === 0 ? (palette.food[2] ?? food) : food}
						ink={PROP_INK}
						key={`leaf-${index.toString()}`}
						position={[Math.cos(angle) * 0.1, 0.03, Math.sin(angle) * 0.1]}
					>
						<sphereGeometry args={[0.075, 12, 10]} />
					</ToonMesh>
				);
			})}
			<ToonMesh color={food} ink={PROP_INK} position={[0, 0.07, 0]}>
				<sphereGeometry args={[0.07, 12, 10]} />
			</ToonMesh>
		</group>
	);
}
