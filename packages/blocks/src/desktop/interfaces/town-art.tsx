/* eslint-disable react/no-unknown-property */
import {
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useRef,
} from "react";
import type { Mesh } from "three";
import { InkMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { hullGeometry } from "./game3d-toon.ts";

/**
 * Shared bits of the Town scene: the simulation clock every animation reads
 * (so the HUD's speed control and reduced motion stop all of it at once),
 * one cel-shaded mesh with an ink outline, and a gable prism for roofs.
 * Like the World modules, nothing here imports three at runtime.
 */

export type Vec3 = [number, number, number];

/** Outline width for buildings and props. */
export const INK = 0.018;

export interface SimClock {
	/** Simulated seconds: advances with the speed control, frozen at pause. */
	time: number;
}

const SimContext = createContext<{ current: SimClock }>({
	current: { time: 0 },
});

export function SimProvider({
	children,
	clock,
}: {
	children: ReactNode;
	clock: { current: SimClock };
}) {
	return <SimContext.Provider value={clock}>{children}</SimContext.Provider>;
}

/** The simulation clock (a ref: read it inside `useFrame`). */
export function useSim(): { current: SimClock } {
	return useContext(SimContext);
}

/** One cel-shaded mesh with an optional ink outline; geometry is the child. */
export function TownMesh({
	castShadow = true,
	children,
	color,
	ink = INK,
	position,
	receiveShadow = true,
	rotation,
	scale,
	siding = false,
}: {
	castShadow?: boolean;
	children: ReactNode;
	color: string;
	ink?: number;
	position?: Vec3;
	receiveShadow?: boolean;
	rotation?: Vec3;
	scale?: Vec3 | number;
	/** Clapboard siding with a skirting board (cottage walls). */
	siding?: boolean;
}) {
	const main = useRef<Mesh>(null);
	const hull = useRef<Mesh>(null);
	useLayoutEffect(() => {
		if (!(ink > 0 && main.current && hull.current)) {
			return;
		}
		const geometry = hullGeometry(main.current.geometry);
		hull.current.geometry = geometry;
		return () => geometry.dispose();
	}, [ink]);
	return (
		<group position={position} rotation={rotation} scale={scale}>
			<mesh castShadow={castShadow} receiveShadow={receiveShadow} ref={main}>
				{children}
				<ToonMaterial color={color} curve={false} siding={siding} />
			</mesh>
			{ink > 0 ? (
				<mesh ref={hull}>
					<InkMaterial color={color} width={ink} />
				</mesh>
			) : null}
		</group>
	);
}

/**
 * A gable: a triangular prism whose ridge runs along x, `width` long,
 * spanning `depth` across z and `height` tall, sitting on y = 0.
 */
export function Gable({
	color,
	depth,
	height,
	position,
	width,
}: {
	color: string;
	depth: number;
	height: number;
	position: Vec3;
	width: number;
}) {
	// A three-sided cylinder of radius 1 turned so one edge points up: its
	// triangle is 1.5 tall and sqrt(3) wide, with the base at y = -0.5.
	return (
		<group
			position={[position[0], position[1] + height / 3, position[2]]}
			scale={[1, height / 1.5, depth / Math.sqrt(3)]}
		>
			<TownMesh color={color} rotation={[-Math.PI / 2, 0, Math.PI / 2]}>
				<cylinderGeometry args={[1, 1, width, 3]} />
			</TownMesh>
		</group>
	);
}
