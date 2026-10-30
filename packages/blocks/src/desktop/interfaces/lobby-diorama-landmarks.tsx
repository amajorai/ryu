/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Group } from "three";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { ADDITIVE_BLENDING } from "./game3d-math.ts";
import { FACE_CAMERA } from "./game3d-villager.tsx";
import { LOBBY_3D } from "./lobby-palette.ts";
import { PODIUM_HEIGHT, PODIUM_RADIUS } from "./lobby-world.ts";

/** The play portal: a stone base, a gold ring and a glowing gate. */
export function Portal({
	at,
	night,
	reducedMotion,
}: {
	at: [number, number];
	night: boolean;
	reducedMotion: boolean;
}) {
	const sparks = useRef<Group>(null);
	useFrame(({ clock }) => {
		const group = sparks.current;
		if (!group || reducedMotion) {
			return;
		}
		group.rotation.z = clock.elapsedTime * 0.6;
	});
	const sparkles = useMemo<InstanceSpec[]>(
		() =>
			Array.from({ length: 8 }, (_, index) => {
				const angle = (index / 8) * Math.PI * 2;
				return {
					color: LOBBY_3D.portalCore,
					position: [Math.cos(angle) * 0.86, Math.sin(angle) * 0.86, 0.06],
					scale: index % 2 === 0 ? 0.07 : 0.045,
				};
			}),
		[]
	);
	return (
		<group position={[at[0], 0, at[1]]} rotation={[0, FACE_CAMERA, 0]}>
			<mesh castShadow position={[0, 0.14, 0]} receiveShadow>
				<cylinderGeometry args={[1.2, 1.32, 0.28, 32]} />
				<ToonMaterial color={LOBBY_3D.portalBase} />
			</mesh>
			<mesh castShadow position={[0, 0.34, 0]} receiveShadow>
				<cylinderGeometry args={[0.9, 1, 0.14, 32]} />
				<ToonMaterial color={LOBBY_3D.podiumStep} />
			</mesh>
			<group position={[0, 1.55, 0]}>
				<mesh castShadow>
					<torusGeometry args={[1.08, 0.13, 14, 48]} />
					<ToonMaterial color={LOBBY_3D.portalRing} rim={0.3} />
				</mesh>
				<mesh>
					<circleGeometry args={[0.98, 40]} />
					<CurvedBasicMaterial
						color={night ? LOBBY_3D.portalGlowNight : LOBBY_3D.portalGlow}
						opacity={0.9}
						toneMapped={false}
						transparent
					/>
				</mesh>
				<mesh position={[0, 0, 0.02]}>
					<circleGeometry args={[0.5, 32]} />
					<CurvedBasicMaterial
						blending={ADDITIVE_BLENDING}
						color={LOBBY_3D.portalCore}
						depthWrite={false}
						opacity={0.55}
						toneMapped={false}
						transparent
					/>
				</mesh>
				<group ref={sparks}>
					<InstancedParts items={sparkles}>
						<sphereGeometry args={[1, 10, 8]} />
						<meshBasicMaterial toneMapped={false} />
					</InstancedParts>
				</group>
			</group>
		</group>
	);
}

/** The podium: a wide step, the drum, a gold rim and a lit top. */
export function Podium({ night }: { night: boolean }) {
	return (
		<group>
			<mesh castShadow position={[0, 0.08, 0]} receiveShadow>
				<cylinderGeometry
					args={[PODIUM_RADIUS + 0.4, PODIUM_RADIUS + 0.5, 0.16, 56]}
				/>
				<ToonMaterial color={LOBBY_3D.podiumStep} />
			</mesh>
			<mesh castShadow position={[0, PODIUM_HEIGHT / 2, 0]} receiveShadow>
				<cylinderGeometry
					args={[PODIUM_RADIUS, PODIUM_RADIUS + 0.06, PODIUM_HEIGHT, 56]}
				/>
				<ToonMaterial
					color={night ? LOBBY_3D.podiumNight : LOBBY_3D.podium}
					rim={0.2}
				/>
			</mesh>
			<mesh position={[0, PODIUM_HEIGHT + 0.006, 0]} receiveShadow>
				<cylinderGeometry
					args={[PODIUM_RADIUS - 0.12, PODIUM_RADIUS - 0.12, 0.02, 56]}
				/>
				<ToonMaterial
					color={night ? LOBBY_3D.podiumTopNight : LOBBY_3D.podiumTop}
				/>
			</mesh>
			<mesh position={[0, PODIUM_HEIGHT, 0]} rotation={[-Math.PI / 2, 0, 0]}>
				<torusGeometry args={[PODIUM_RADIUS - 0.06, 0.06, 8, 72]} />
				<ToonMaterial color={LOBBY_3D.podiumRim} rim={0.3} />
			</mesh>
		</group>
	);
}

/** A lit disc on the podium under the selected member (they stay fully opaque). */
export function SelectedGlow({ at }: { at: [number, number] }) {
	return (
		<mesh
			position={[at[0], PODIUM_HEIGHT + 0.02, at[1]]}
			rotation={[-Math.PI / 2, 0, 0]}
		>
			<circleGeometry args={[0.62, 40]} />
			<CurvedBasicMaterial
				blending={ADDITIVE_BLENDING}
				color={LOBBY_3D.spotlight}
				depthWrite={false}
				opacity={0.45}
				toneMapped={false}
				transparent
			/>
		</mesh>
	);
}
