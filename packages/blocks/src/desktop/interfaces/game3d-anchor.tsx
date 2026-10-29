import { useFrame } from "@react-three/fiber";
import { type ReactNode, useRef } from "react";
import type { Group } from "three";
import type { Vec3 } from "./game3d-palette.ts";
import { curveDrop } from "./game3d-toon.ts";

/** A body's ground position, for anchors and villagers that follow it. */
export type FollowBody = () => { x: number; z: number } | undefined;

/**
 * A group that sits on a curved stage's ground: every frame its height is
 * `position[1]` minus the curve's drop under it (`curveDrop`, zero where
 * the curve uniform is zero, so a flat stage is unchanged). With `follow`
 * its x and z track that body as it walks (`position[0]` and `[2]` are then
 * ignored), and its children sit relative to it.
 */
export function CurvedAnchor({
	children,
	follow,
	position,
}: {
	children: ReactNode;
	/** A body to stay over as it walks (its ground x and z). */
	follow?: FollowBody;
	position: Vec3;
}) {
	const ref = useRef<Group>(null);
	useFrame(() => {
		const group = ref.current;
		if (!group) {
			return;
		}
		const body = follow?.();
		if (body) {
			group.position.x = body.x;
			group.position.z = body.z;
		}
		group.updateWorldMatrix(true, false);
		const world = group.matrixWorld.elements;
		group.position.y = position[1] - curveDrop(world[12] ?? 0, world[14] ?? 0);
	}, -0.5);
	return (
		<group position={position} ref={ref}>
			{children}
		</group>
	);
}
