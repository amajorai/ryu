/* eslint-disable react/no-unknown-property */
import { useMemo } from "react";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { onIsland } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import { ToonMaterial } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import { type PlantedTree, PROP_INK, TreeGrove } from "./game3d-props.tsx";
import { linearRgb } from "./game3d-toon.ts";
import type { SeasonSceneProps } from "./seasonal-diorama.tsx";
import { SEASON_3D } from "./seasonal-palette.ts";
import { Roof } from "./seasonal-village.tsx";
import { STREET, streetPoint } from "./seasonal-world.ts";

/**
 * Lunar New Year: a lantern festival street. Shophouses with red pillars
 * and green-tiled roofs line its back and market stalls its front. Four wires strung along it carry the 24
 * lanterns: a red lantern for every conversation (gold once opened, blazing
 * bright where it needs you) and a small paper one for every empty
 * place.
 */

const ART = SEASON_3D["lunar-new-year"];
const HALF_WIDTH = STREET.width / 2;
const HALF_LENGTH = STREET.length / 2;
const HOUSES = [-5.7, -1.9, 1.9, 5.7] as const;
const STALLS = [-4.8, -1.6, 1.6, 4.8] as const;
const HOUSE_DEPTH = 2.4;
const HOUSE_WIDTH = 3.4;
const HOUSE_HEIGHT = 2.7;
/** Where the shophouses stand across the street, behind it. */
const HOUSE_N = -HALF_WIDTH - HOUSE_DEPTH / 2 - 0.3;

/** A box on the street's frame: `t` along it, `n` toward the camera. */
function streetBox(
	t: number,
	n: number,
	y: number,
	size: [number, number, number],
	color?: string,
	tilt = 0
): InstanceSpec {
	const [x, z] = streetPoint(t, n);
	return {
		color,
		position: [x, y, z],
		rotation: [tilt, 0, 0],
		scale: size,
	};
}

/** Where (x, z) sits on the street: along it and across it. */
function streetCoords(x: number, z: number): [number, number] {
	return [x, z];
}

/** The shophouses behind the street: walls, pillars, two-tier roofs, windows. */
function houseParts(night: boolean) {
	const walls: InstanceSpec[] = [];
	const pillars: InstanceSpec[] = [];
	const roofs: InstanceSpec[] = [];
	const trims: InstanceSpec[] = [];
	const windows: InstanceSpec[] = [];
	const n = HOUSE_N;
	for (const [index, t] of HOUSES.entries()) {
		walls.push(
			streetBox(
				t,
				n,
				HOUSE_HEIGHT / 2,
				[HOUSE_WIDTH, HOUSE_HEIGHT, HOUSE_DEPTH],
				ART.walls[index % ART.walls.length]
			)
		);
		for (const side of [-1, 0, 1]) {
			pillars.push(
				streetBox(
					t + side * (HOUSE_WIDTH / 2 - 0.12),
					n + HOUSE_DEPTH / 2 + 0.1,
					HOUSE_HEIGHT / 2,
					[0.18, HOUSE_HEIGHT, 0.18]
				)
			);
		}
		// A tiled canopy over the shopfront, under the gabled roof.
		roofs.push(
			streetBox(
				t,
				n + HOUSE_DEPTH / 2 + 0.35,
				HOUSE_HEIGHT * 0.5,
				[HOUSE_WIDTH + 0.3, 0.12, 0.8],
				undefined,
				0.32
			)
		);
		trims.push(
			streetBox(t, n + HOUSE_DEPTH / 2 + 0.72, HOUSE_HEIGHT * 0.5 - 0.12, [
				HOUSE_WIDTH + 0.3,
				0.08,
				0.06,
			])
		);
		for (const side of [-1, 1]) {
			windows.push(
				streetBox(
					t + side * 0.85,
					n + HOUSE_DEPTH / 2 + 0.02,
					HOUSE_HEIGHT * 0.76,
					[0.9, 0.6, 0.04],
					night ? ART.glow : ART.trim
				)
			);
		}
	}
	return { pillars, roofs, trims, walls, windows };
}

/** The market stalls along the front: counters, posts and awnings. */
function stallParts() {
	const counters: InstanceSpec[] = [];
	const posts: InstanceSpec[] = [];
	const awnings: InstanceSpec[] = [];
	const n = HALF_WIDTH + 1.2;
	for (const [index, t] of STALLS.entries()) {
		counters.push(streetBox(t, n, 0.4, [2, 0.8, 0.9]));
		for (const side of [-1, 1]) {
			posts.push(streetBox(t + side * 0.92, n - 0.38, 0.8, [0.08, 1.6, 0.08]));
		}
		awnings.push(
			streetBox(
				t,
				n - 0.2,
				1.62,
				[2.3, 0.08, 1.4],
				ART.awnings[index % ART.awnings.length],
				-0.28
			)
		);
	}
	return { awnings, counters, posts };
}

/** The wires along the street and the poles at their ends. */
function wireParts() {
	const wires: InstanceSpec[] = [];
	const poles: InstanceSpec[] = [];
	for (const [index, n] of STREET.offsets.entries()) {
		const y = STREET.heights[index] ?? 3;
		wires.push(streetBox(0, n, y, [HALF_LENGTH * 2 - 0.4, 0.03, 0.03]));
		for (const side of [-1, 1]) {
			poles.push(
				streetBox(side * (HALF_LENGTH - 0.2), n, (y + 0.2) / 2, [
					0.14,
					y + 0.2,
					0.14,
				])
			);
		}
	}
	return { poles, wires };
}

/** Every lantern: body, caps, tassel and string. */
function lanternParts({ doors, world }: SeasonSceneProps) {
	const lit: InstanceSpec[] = [];
	const plain: InstanceSpec[] = [];
	const caps: InstanceSpec[] = [];
	const strings: InstanceSpec[] = [];
	const hot: InstanceSpec[] = [];
	for (const place of world.doors) {
		const door = doors[place.number - 1];
		const filled = door?.thread != null;
		const size = filled ? 1 : 0.62;
		const [x, y, z] = place.at;
		let color: string = ART.lanternEmpty;
		if (filled) {
			color = door?.opened ? ART.lanternOpened : ART.lantern;
		}
		// Lanterns with a conversation are lit, the ones that need you blazing;
		// empty paper ones are not.
		let bucket = filled ? lit : plain;
		if (door?.mark === "needs-you") {
			bucket = hot;
			color = ART.hot;
		}
		bucket.push({
			color,
			position: [x, y, z],
			scale: [0.46 * size, 0.38 * size, 0.46 * size],
		});
		for (const cap of [0.38, -0.38]) {
			caps.push({
				position: [x, y + cap * size, z],
				scale: [0.24 * size, 0.07, 0.24 * size],
			});
		}
		caps.push({
			position: [x, y - 0.52 * size, z],
			scale: [0.025, 0.22 * size, 0.025],
		});
		strings.push({
			position: [x, y + STREET.drop / 2 + 0.15, z],
			scale: [0.012, STREET.drop - 0.25, 0.012],
		});
	}
	return { caps, hot, lit, plain, strings };
}

/** Blossom trees behind the houses and round the rim. */
function blossoms(scene: SeasonSceneProps): PlantedTree[] {
	const trees: PlantedTree[] = [];
	const columns = Math.ceil(scene.shape.halfWidth);
	const rows = Math.ceil(scene.shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const hash = jitter(x, y, 3);
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			const [t, n] = streetCoords(fx, fz);
			const behind = n < -HALF_WIDTH - HOUSE_DEPTH - 0.8;
			const beyond = Math.abs(t) > HALF_LENGTH + 0.8;
			if (
				!(onIsland(scene.shape, fx, fz, 0.6) && (behind || beyond)) ||
				n > HALF_WIDTH + 2.4 ||
				hash > 0.55
			) {
				continue;
			}
			trees.push({
				at: [fx, 0, fz],
				kind: hash < 0.3 ? "blossom" : "fruit",
				scale: 0.75 + jitter(x, y, 9) * 0.3,
				seed: Math.round(hash * 1000),
			});
		}
	}
	return trees;
}

export function LanternStreet(scene: SeasonSceneProps) {
	const { night, quality, reducedMotion, shape, theme } = scene;
	const paint = useMemo(() => {
		const paving = linearRgb(night ? ART.pavingNight : ART.paving);
		const kerb = linearRgb(ART.kerb);
		return (x: number, z: number): Rgb | null => {
			const [t, n] = streetCoords(x, z);
			if (Math.abs(t) > HALF_LENGTH + 1.6) {
				return null;
			}
			const across = Math.abs(n);
			if (across < HALF_WIDTH) {
				return paving;
			}
			return across < HALF_WIDTH + 0.3 ? kerb : null;
		};
	}, [night]);
	const avoid = useMemo(
		() => (x: number, z: number) => {
			const [t, n] = streetCoords(x, z);
			if (Math.abs(t) > HALF_LENGTH + 1.8) {
				return false;
			}
			return n > -HALF_WIDTH - HOUSE_DEPTH - 0.6 && n < HALF_WIDTH + 1.9;
		},
		[]
	);
	const houses = useMemo(() => houseParts(night), [night]);
	const stalls = useMemo(() => stallParts(), []);
	const wires = useMemo(() => wireParts(), []);
	const lanterns = useMemo(() => lanternParts(scene), [scene]);
	const trees = useMemo(() => blossoms(scene), [scene]);
	return (
		<group>
			<IsoIsland paint={paint} shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reducedMotion}
				shape={shape}
				theme={theme}
			/>
			<TreeGrove theme={theme} trees={trees} />
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={ART.counter}
				items={houses.walls}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={houses.pillars}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.pillar} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={ART.roof}
				items={houses.roofs}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.roof} rim={0.2} />
			</InstancedParts>
			<InstancedParts items={houses.trims}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.trim} />
			</InstancedParts>
			<InstancedParts items={houses.windows}>
				<boxGeometry args={[1, 1, 1]} />
				<meshBasicMaterial toneMapped={!night} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={ART.counter}
				items={stalls.counters}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.counter} planks />
			</InstancedParts>
			<InstancedParts castShadow items={stalls.posts}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.counter} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={ART.pillar}
				items={stalls.awnings}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			{HOUSES.map((t) => {
				const [x, z] = streetPoint(t, HOUSE_N);
				return (
					<Roof
						at={[x, z]}
						color={ART.roof}
						halfDepth={HOUSE_DEPTH / 2 + 0.2}
						halfWidth={HOUSE_WIDTH / 2 + 0.1}
						key={t}
						ridge={1.1}
						snow={ART.roofTiles}
						wall={HOUSE_HEIGHT}
						wallColor={ART.walls[0]}
					/>
				);
			})}
			<InstancedParts items={wires.wires}>
				<boxGeometry args={[1, 1, 1]} />
				<meshBasicMaterial color={ART.wire} />
			</InstancedParts>
			<InstancedParts castShadow items={wires.poles}>
				<cylinderGeometry args={[1, 1, 1, 8]} />
				<ToonMaterial color={ART.pole} />
			</InstancedParts>
			<InstancedParts items={lanterns.strings}>
				<boxGeometry args={[1, 1, 1]} />
				<meshBasicMaterial color={ART.wire} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={ART.lantern}
				items={lanterns.lit}
			>
				<sphereGeometry args={[1, 16, 12]} />
				<ToonMaterial
					emissive={ART.glow}
					emissiveIntensity={night ? 0.55 : 0.12}
					rim={0.3}
				/>
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={ART.lanternEmpty}
				items={lanterns.plain}
			>
				<sphereGeometry args={[1, 14, 10]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={lanterns.caps}>
				<cylinderGeometry args={[1, 1, 1, 10]} />
				<ToonMaterial color={ART.lanternCap} />
			</InstancedParts>
			<InstancedParts items={lanterns.hot}>
				<sphereGeometry args={[1, 16, 12]} />
				<meshBasicMaterial toneMapped={false} />
			</InstancedParts>
		</group>
	);
}
