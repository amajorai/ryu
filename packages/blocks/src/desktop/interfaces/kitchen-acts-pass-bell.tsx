/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { Group } from "three";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type { KitchenPalette } from "./kitchen-palette.ts";
import { PROP_INK } from "./kitchen-props.tsx";

const RING_SECONDS = 1.2;

/**
 * The pass bell: rings once (a short wobble) when a chef arrives to ask,
 * keyed on the asks carried into the queue (a chef already there with a
 * new ask rings it again); still under reduced motion.
 */
export function PassBell({
	at,
	palette,
	reduced,
	ringKey,
}: {
	at: Vec3;
	palette: KitchenPalette;
	reduced: boolean;
	ringKey: string;
}) {
	const bell = useRef<Group>(null);
	const ringing = useRef<number | null>(null);
	const heard = useRef<Set<string> | null>(null);
	useEffect(() => {
		const askers = new Set(ringKey.split("|").filter(Boolean));
		const before = heard.current;
		heard.current = askers;
		if (reduced || before === null) {
			return;
		}
		if ([...askers].some((id) => !before.has(id))) {
			// A chef walks round the pass first: ring as it settles.
			ringing.current = -1;
		}
	}, [reduced, ringKey]);
	useFrame(({ clock, invalidate }) => {
		const group = bell.current;
		const start = ringing.current;
		if (!group || start === null) {
			return;
		}
		if (start < 0) {
			ringing.current = clock.elapsedTime + 2.5;
			invalidate();
			return;
		}
		const t = clock.elapsedTime - start;
		if (t < 0) {
			invalidate();
			return;
		}
		if (t > RING_SECONDS) {
			group.rotation.z = 0;
			ringing.current = null;
			return;
		}
		group.rotation.z = Math.sin(t * 28) * 0.35 * (1 - t / RING_SECONDS);
		invalidate();
	});
	return (
		<group position={at}>
			<ToonMesh
				color={palette.steel}
				ink={PROP_INK}
				position={[0, 0.015, 0]}
				scale={[0.16, 0.03, 0.16]}
			>
				<cylinderGeometry args={[1, 1, 1, 18]} />
			</ToonMesh>
			<group ref={bell}>
				<ToonMesh
					color={palette.lamp}
					ink={PROP_INK}
					position={[0, 0.09, 0]}
					scale={0.1}
				>
					<sphereGeometry args={[1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
				</ToonMesh>
				<ToonMesh color={palette.lamp} position={[0, 0.2, 0]} scale={0.025}>
					<sphereGeometry args={[1, 8, 6]} />
				</ToonMesh>
			</group>
		</group>
	);
}
