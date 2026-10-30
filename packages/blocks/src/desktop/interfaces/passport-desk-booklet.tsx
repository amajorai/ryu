/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { type ReactNode, useRef } from "react";
import type { Group } from "three";
import { ToonMesh } from "./game3d-materials.tsx";
import { PROP_INK } from "./game3d-props.tsx";
import { FACE_CAMERA } from "./game3d-villager.tsx";
import {
	BLOCK_H,
	BOARD_H,
	type DeskLayout,
	deskExtent,
	FACE_SCALE,
	LEAF_SECONDS,
	LIP,
	PAGE_D,
	PAGE_TOP,
	PAGE_W,
} from "./passport-desk-layout.ts";
import { type DeskArt, tabInk } from "./passport-palette.ts";

/** Plank seams across the desk, a board's width apart. */
const SEAMS = Array.from({ length: 21 }, (_, index) => (index - 10) * 3.2);

/** The desk, the blotter, and the booklet's boards and page blocks. */
export function DeskAndBooklet({
	art,
	closed,
	layout,
}: {
	art: DeskArt;
	closed: boolean;
	layout: DeskLayout;
}) {
	const extent = deskExtent(layout);
	const blotter = {
		depth: extent.maxB - extent.minB - 1.2,
		middle: (extent.maxB + extent.minB) / 2 - 0.3,
		width: layout.ring.a * 2 + 1.8,
	};
	const spread = layout.mode === "spread";
	const pageWidth = spread ? PAGE_W * 2 : PAGE_W;
	// The strip runs from the booklet's back edge to the back row.
	const strip = layout.ring.b - layout.halfB;
	return (
		<group rotation={[0, FACE_CAMERA, 0]}>
			<ToonMesh color={art.desk} position={[0, -0.25, 0]} receiveShadow>
				<boxGeometry args={[120, 0.5, 120]} />
			</ToonMesh>
			{SEAMS.map((z) => (
				<ToonMesh color={art.deskGrain} key={z} position={[0, 0.002, z]}>
					<boxGeometry args={[120, 0.004, 0.06]} />
				</ToonMesh>
			))}
			<ToonMesh
				color={art.blotter}
				ink={PROP_INK}
				position={[0, 0.015, blotter.middle]}
				receiveShadow
			>
				<boxGeometry args={[blotter.width, 0.03, blotter.depth]} />
			</ToonMesh>
			{/* The clip strip between the back row and the booklet. */}
			<ToonMesh
				color={art.strip}
				position={[0, 0.034, -layout.halfB - strip / 2]}
				receiveShadow
			>
				<boxGeometry args={[pageWidth + LIP * 2, 0.008, strip - 0.2]} />
			</ToonMesh>
			{closed ? (
				<ToonMesh
					castShadow
					color={art.cover}
					ink={PROP_INK}
					position={[spread ? PAGE_W / 2 : 0, PAGE_TOP / 2 + 0.03, 0]}
					receiveShadow
				>
					<boxGeometry args={[PAGE_W + LIP * 2, PAGE_TOP, PAGE_D + LIP * 2]} />
				</ToonMesh>
			) : (
				<group position={[0, 0.03, 0]}>
					<ToonMesh
						castShadow
						color={art.cover}
						ink={PROP_INK}
						position={[0, BOARD_H / 2, 0]}
						receiveShadow
					>
						<boxGeometry
							args={[pageWidth + LIP * 2, BOARD_H, PAGE_D + LIP * 2]}
						/>
					</ToonMesh>
					{(spread ? [-PAGE_W / 2, PAGE_W / 2] : [0]).map((x) => (
						<group key={x} position={[x, 0, 0]}>
							<ToonMesh
								castShadow
								color={art.pageEdge}
								ink={PROP_INK * 0.6}
								position={[0, BOARD_H + BLOCK_H / 2 - 0.006, 0]}
								receiveShadow
							>
								<boxGeometry args={[PAGE_W - 0.04, BLOCK_H - 0.012, PAGE_D]} />
							</ToonMesh>
							<ToonMesh
								color={art.paper}
								position={[0, PAGE_TOP - 0.004, 0]}
								receiveShadow
							>
								<boxGeometry args={[PAGE_W - 0.06, 0.008, PAGE_D - 0.04]} />
							</ToonMesh>
						</group>
					))}
					{spread ? (
						<ToonMesh color={art.coverEdge} position={[0, PAGE_TOP, 0]}>
							<boxGeometry args={[0.05, 0.006, PAGE_D]} />
						</ToonMesh>
					) : null}
				</group>
			)}
		</group>
	);
}

/** The index tabs: a paper tab per station, in its country's ink. */
export function IndexTabs({
	art,
	layout,
}: {
	art: DeskArt;
	layout: DeskLayout;
}) {
	return (
		<group position={[0, 0.03, 0]} rotation={[0, FACE_CAMERA, 0]}>
			{layout.stations.map((station) => {
				const across = station.edge === "top";
				return (
					<ToonMesh
						castShadow
						color={
							station.country
								? tabInk(art, station.country.style.ink)
								: art.tabPlain
						}
						ink={PROP_INK * 0.6}
						key={station.id}
						position={[
							station.tab[0],
							BOARD_H + BLOCK_H * 0.55,
							station.tab[1],
						]}
					>
						<boxGeometry
							args={across ? [0.8, 0.03, 0.62] : [0.62, 0.03, 0.8]}
						/>
					</ToonMesh>
				);
			})}
		</group>
	);
}

/** A page face, laid flat on the paper at `middle` across the desk. */
export function FaceOnPage({
	children,
	lift = PAGE_TOP,
	middle,
}: {
	children: ReactNode;
	lift?: number;
	middle: number;
}) {
	return (
		<group rotation={[0, FACE_CAMERA, 0]}>
			<group
				position={[middle, lift + 0.035, 0]}
				rotation={[-Math.PI / 2, 0, 0]}
			>
				<Html
					distanceFactor={400 * FACE_SCALE}
					pointerEvents="none"
					transform
					zIndexRange={[2, 0]}
				>
					{children}
				</Html>
			</group>
		</group>
	);
}

/**
 * The leaf that turns between two spreads: it lifts from the right-hand
 * page (forward) or the left (back) and swings over the spine.
 */
export function TurningLeaf({
	art,
	direction,
	onDone,
}: {
	art: DeskArt;
	direction: 1 | -1;
	onDone: () => void;
}) {
	const hinge = useRef<Group>(null);
	const elapsed = useRef(0);
	const done = useRef(false);
	useFrame((_, delta) => {
		const node = hinge.current;
		if (!node || done.current) {
			return;
		}
		elapsed.current += delta;
		const t = Math.min(1, elapsed.current / LEAF_SECONDS);
		const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
		node.rotation.z = direction === 1 ? eased * Math.PI : (1 - eased) * Math.PI;
		if (t >= 1) {
			done.current = true;
			onDone();
		}
	});
	return (
		<group rotation={[0, FACE_CAMERA, 0]}>
			<group
				position={[0, PAGE_TOP + 0.04, 0]}
				ref={hinge}
				rotation={[0, 0, direction === 1 ? 0 : Math.PI]}
			>
				<ToonMesh color={art.paper} position={[PAGE_W / 2, 0.004, 0]}>
					<boxGeometry args={[PAGE_W - 0.06, 0.006, PAGE_D - 0.04]} />
				</ToonMesh>
				<ToonMesh color={art.paperBack} position={[PAGE_W / 2, -0.003, 0]}>
					<boxGeometry args={[PAGE_W - 0.06, 0.006, PAGE_D - 0.04]} />
				</ToonMesh>
			</group>
		</group>
	);
}
