/* eslint-disable react/no-unknown-property */
import { type ReactNode, useLayoutEffect, useRef } from "react";
import type { InstancedMesh } from "three";
import { InkMaterial } from "./game3d-materials.tsx";
import { mathKit } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { ART_WHITE } from "./game3d-palette.ts";
import { hullGeometry } from "./game3d-toon.ts";

/** One copy of a repeated mesh: where it stands, how it is turned and sized. */
export interface InstanceSpec {
	color?: string;
	position: Vec3;
	rotation?: Vec3;
	scale?: Vec3 | number;
}

const WHITE = ART_WHITE;

/** Writes every instance's transform and color into an instanced mesh. */
export function writeInstances(
	mesh: InstancedMesh,
	items: readonly InstanceSpec[]
): void {
	const { color, euler, matrix, position, quaternion, scale } = mathKit(mesh);
	for (const [index, item] of items.entries()) {
		position.set(...item.position);
		euler.set(...(item.rotation ?? [0, 0, 0]));
		quaternion.setFromEuler(euler);
		if (typeof item.scale === "number") {
			scale.setScalar(item.scale);
		} else {
			scale.set(...(item.scale ?? [1, 1, 1]));
		}
		matrix.compose(position, quaternion, scale);
		mesh.setMatrixAt(index, matrix);
		if (color) {
			mesh.setColorAt(index, color.set(item.color ?? WHITE));
		}
	}
	mesh.count = items.length;
	mesh.instanceMatrix.needsUpdate = true;
	if (mesh.instanceColor) {
		mesh.instanceColor.needsUpdate = true;
	}
	mesh.computeBoundingSphere();
}

/**
 * Makes `hull` an ink outline of `mesh`: the welded hull of its geometry,
 * drawing from the very same instance transforms and colors, so it follows
 * every per-frame update at no extra upload. Returns a cleanup.
 */
export function shareHull(mesh: InstancedMesh, hull: InstancedMesh) {
	const geometry = hullGeometry(mesh.geometry);
	hull.geometry = geometry;
	hull.instanceMatrix = mesh.instanceMatrix;
	hull.instanceColor = mesh.instanceColor;
	hull.count = mesh.count;
	hull.frustumCulled = false;
	return () => geometry.dispose();
}

/**
 * Draws many copies of one geometry + material in a single draw call. The
 * geometry and material are the children, e.g.
 * `<InstancedParts items={…}><boxGeometry /><ToonMaterial /></InstancedParts>`.
 * `ink` adds an outline of that width in a second draw call.
 */
export function InstancedParts({
	castShadow = false,
	children,
	fade = false,
	ink = 0,
	inkColor,
	items,
	receiveShadow = false,
}: {
	castShadow?: boolean;
	children: ReactNode;
	/** The outline fades with a see-through material (pass `fade` to it too). */
	fade?: boolean;
	ink?: number;
	/** The surface color when the material (not the instances) carries it. */
	inkColor?: string;
	items: readonly InstanceSpec[];
	receiveShadow?: boolean;
}) {
	const ref = useRef<InstancedMesh>(null);
	const hullRef = useRef<InstancedMesh>(null);
	useLayoutEffect(() => {
		const mesh = ref.current;
		if (!mesh) {
			return;
		}
		writeInstances(mesh, items);
		const hull = hullRef.current;
		if (hull) {
			return shareHull(mesh, hull);
		}
	}, [items]);
	if (items.length === 0) {
		return null;
	}
	return (
		<>
			<instancedMesh
				args={[undefined, undefined, items.length]}
				castShadow={castShadow}
				key={items.length}
				receiveShadow={receiveShadow}
				ref={ref}
			>
				{children}
			</instancedMesh>
			{ink > 0 ? (
				<instancedMesh
					args={[undefined, undefined, items.length]}
					key={`ink:${items.length}`}
					ref={hullRef}
				>
					<InkMaterial color={inkColor} fade={fade} width={ink} />
				</instancedMesh>
			) : null}
		</>
	);
}
