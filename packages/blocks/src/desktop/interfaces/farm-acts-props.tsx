/* eslint-disable react/no-unknown-property */
import { DECK_TOP } from "./farm-acts-spots.ts";
import { FARM_3D } from "./farm-palette.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { PROP_INK } from "./game3d-props.tsx";

/** The farmhouse porch at the you-spot: a deck under a little roof, a mailbox, a gate. */
export function Porch({ at, mailbox }: { at: Vec3; mailbox: Vec3 }) {
	return (
		<group>
			<group position={at}>
				<ToonMesh
					castShadow
					color={FARM_3D.porchDeck}
					ink={PROP_INK}
					position={[0, DECK_TOP / 2, 0]}
					receiveShadow
				>
					<boxGeometry args={[1.5, DECK_TOP, 1.0]} />
				</ToonMesh>
				{[-0.65, 0.65].map((x) => (
					<ToonMesh
						castShadow
						color={FARM_3D.porchPost}
						key={x}
						position={[x, DECK_TOP + 0.6, -0.35]}
					>
						<boxGeometry args={[0.08, 1.2, 0.08]} />
					</ToonMesh>
				))}
				<ToonMesh
					castShadow
					color={FARM_3D.porchRoof}
					ink={PROP_INK}
					position={[0, DECK_TOP + 1.5, -0.45]}
					rotation={[0.45, 0, 0]}
				>
					<boxGeometry args={[1.7, 0.08, 0.8]} />
				</ToonMesh>
			</group>
			{/* The mailbox on its post, flag up. */}
			<group position={mailbox}>
				<ToonMesh color={FARM_3D.stake} position={[0, 0.35, 0]}>
					<boxGeometry args={[0.07, 0.7, 0.07]} />
				</ToonMesh>
				<ToonMesh
					castShadow
					color={FARM_3D.mailbox}
					ink={PROP_INK}
					position={[0, 0.78, 0]}
				>
					<boxGeometry args={[0.22, 0.2, 0.38]} />
				</ToonMesh>
				<ToonMesh color={FARM_3D.mailboxFlag} position={[0.13, 0.9, -0.08]}>
					<boxGeometry args={[0.02, 0.16, 0.08]} />
				</ToonMesh>
			</group>
			{/* The gate: two posts and a swung-open gate beside the porch. */}
			<group position={[at[0] - 1.45, 0, at[2] + 0.1]}>
				{[-0.35, 0.35].map((x) => (
					<ToonMesh color={FARM_3D.gate} key={x} position={[x, 0.36, 0]}>
						<boxGeometry args={[0.08, 0.72, 0.08]} />
					</ToonMesh>
				))}
				<group position={[-0.33, 0, 0]} rotation={[0, 0.9, 0]}>
					{[0.2, 0.5].map((y) => (
						<ToonMesh color={FARM_3D.gate} key={y} position={[0.3, y, 0]}>
							<boxGeometry args={[0.6, 0.06, 0.04]} />
						</ToonMesh>
					))}
				</group>
			</group>
		</group>
	);
}

/** The sundial by the benches. */
export function Sundial({ at }: { at: Vec3 }) {
	return (
		<group position={at}>
			<ToonMesh castShadow color={FARM_3D.sundial} ink={PROP_INK}>
				<cylinderGeometry args={[0.12, 0.16, 0.5, 12]} />
			</ToonMesh>
			<ToonMesh color={FARM_3D.sundial} position={[0, 0.27, 0]}>
				<cylinderGeometry args={[0.26, 0.26, 0.05, 20]} />
			</ToonMesh>
			<ToonMesh
				color={FARM_3D.gnomon}
				position={[0, 0.36, 0]}
				rotation={[0, 0, 0.6]}
			>
				<boxGeometry args={[0.03, 0.18, 0.12]} />
			</ToonMesh>
		</group>
	);
}

/** A scarecrow on a withered bed: straw, coat and hat, a red lantern, a crow. */
export function Scarecrow({ at }: { at: Vec3 }) {
	return (
		<group position={at}>
			<ToonMesh color={FARM_3D.stake} position={[0, 0.5, 0]}>
				<boxGeometry args={[0.06, 1.0, 0.06]} />
			</ToonMesh>
			<ToonMesh color={FARM_3D.stake} position={[0, 0.78, 0]}>
				<boxGeometry args={[0.7, 0.05, 0.05]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={FARM_3D.scarecrowCoat}
				ink={PROP_INK}
				position={[0, 0.7, 0]}
			>
				<boxGeometry args={[0.3, 0.32, 0.16]} />
			</ToonMesh>
			<ToonMesh color={FARM_3D.straw} position={[0, 0.98, 0]}>
				<sphereGeometry args={[0.12, 10, 8]} />
			</ToonMesh>
			<ToonMesh
				color={FARM_3D.scarecrowHat}
				ink={PROP_INK}
				position={[0, 1.1, 0]}
			>
				<coneGeometry args={[0.18, 0.18, 12]} />
			</ToonMesh>
			{/* The red lantern hangs from its arm; the crow sits on the other. */}
			<ToonMesh color={FARM_3D.lantern} position={[0.32, 0.66, 0]}>
				<boxGeometry args={[0.09, 0.13, 0.09]} />
			</ToonMesh>
			<group position={[-0.3, 0.86, 0]}>
				<ToonMesh color={FARM_3D.crow} ink={PROP_INK}>
					<sphereGeometry args={[0.07, 10, 8]} />
				</ToonMesh>
				<ToonMesh color={FARM_3D.crow} position={[0.06, 0.06, 0]}>
					<sphereGeometry args={[0.045, 8, 6]} />
				</ToonMesh>
			</group>
		</group>
	);
}
