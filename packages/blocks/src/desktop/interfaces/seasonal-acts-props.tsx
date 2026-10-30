/* eslint-disable react/no-unknown-property */
import type { StationNext } from "./game3d-act-stage.tsx";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { NextSign } from "./game3d-signs.tsx";
import { storey } from "./seasonal-acts-stations.ts";
import type { Season } from "./seasonal-model.ts";
import { SEASON_3D, SEASON_ACT_ART } from "./seasonal-palette.ts";
import type { WorldDoor } from "./seasonal-world.ts";

/**
 * Tomorrow's door: where the kit's next sign stands, an agent with a
 * scheduled run gets the season's prop for it (a little closed door, an
 * uncarved pumpkin, an unlit lantern). Only a run counts: an act's next
 * words can name a plan step instead, which keeps the kit's sign.
 */
export function TomorrowDoor({ at, season }: { at: Vec3; season: Season }) {
	const art = SEASON_ACT_ART[season];
	if (season === "halloween") {
		return (
			<group name="tomorrow-door" position={at}>
				<ToonMesh
					castShadow
					color={art.nextDoor}
					ink={0.015}
					position={[0, 0.16, 0]}
					scale={[0.22, 0.16, 0.22]}
				>
					<sphereGeometry args={[1, 12, 8]} />
				</ToonMesh>
				<ToonMesh
					color={art.nextDoorTrim}
					position={[0, 0.35, 0]}
					scale={[0.03, 0.07, 0.03]}
				>
					<cylinderGeometry args={[1, 1, 1, 6]} />
				</ToonMesh>
			</group>
		);
	}
	if (season === "lunar-new-year") {
		return (
			<group name="tomorrow-door" position={at}>
				<ToonMesh
					color={art.nextDoorTrim}
					position={[0, 0.3, 0]}
					scale={[0.025, 0.6, 0.025]}
				>
					<cylinderGeometry args={[1, 1, 1, 6]} />
				</ToonMesh>
				<ToonMesh
					castShadow
					color={art.nextDoor}
					ink={0.015}
					position={[0, 0.5, 0.08]}
					scale={[0.16, 0.14, 0.16]}
				>
					<sphereGeometry args={[1, 12, 8]} />
				</ToonMesh>
			</group>
		);
	}
	return (
		<group name="tomorrow-door" position={at}>
			<ToonMesh
				castShadow
				color={art.nextDoorTrim}
				ink={0.015}
				position={[0, 0.3, 0]}
				scale={[0.36, 0.6, 0.06]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={art.nextDoor}
				position={[0, 0.29, 0.02]}
				scale={[0.28, 0.52, 0.04]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={art.nextDoorTrim}
				position={[0.08, 0.28, 0.05]}
				scale={[0.03, 0.03, 0.03]}
			>
				<sphereGeometry args={[1, 8, 6]} />
			</ToonMesh>
		</group>
	);
}

/**
 * The season's `ActStation renderNext`: tomorrow's door when the agent has
 * a scheduled run (`next.run`), otherwise the kit's sign for its next words.
 */
export function seasonNext(season: Season) {
	return (next: StationNext) =>
		next.run ? (
			<TomorrowDoor at={next.at} season={season} />
		) : (
			<NextSign at={next.at} showText={false} text={next.text} />
		);
}

/** Where the little tree over the sleigh mailbox stands. */
export const LITTLE_TREE: Vec3 = [-7.1, 0, 4.4];

/** A little decorated fir: two tiers and a star. */
export function LittleTree({ at }: { at: Vec3 }) {
	const art = SEASON_3D.advent;
	return (
		<group position={at}>
			<ToonMesh color={art.timber} position={[0, 0.15, 0]}>
				<cylinderGeometry args={[0.08, 0.1, 0.3, 8]} />
			</ToonMesh>
			{[0, 1].map((tier) => (
				<ToonMesh
					castShadow
					color={art.needles}
					ink={0.015}
					key={tier}
					position={[0, 0.55 + tier * 0.4, 0]}
				>
					<coneGeometry args={[0.6 - tier * 0.18, 0.7, 14]} />
				</ToonMesh>
			))}
			<mesh position={[0, 1.4, 0]} rotation={[0, Math.PI / 4, 0]}>
				<octahedronGeometry args={[0.12, 0]} />
				<meshBasicMaterial color={art.star} toneMapped={false} />
			</mesh>
		</group>
	);
}

/** The sleigh mailbox under the little tree: a red box on runners. */
export function SleighMailbox({ at }: { at: Vec3 }) {
	const art = SEASON_ACT_ART.advent;
	return (
		<group position={at} rotation={[0, Math.PI / 4, 0]}>
			{[-0.2, 0.2].map((x) => (
				<ToonMesh
					color={art.runner}
					ink={0.012}
					key={x}
					position={[x, 0.05, 0]}
					scale={[0.05, 0.05, 0.9]}
				>
					<boxGeometry />
				</ToonMesh>
			))}
			<ToonMesh
				castShadow
				color={art.post}
				ink={0.02}
				position={[0, 0.38, 0]}
				scale={[0.55, 0.55, 0.7]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={art.postTrim}
				ink={0.01}
				position={[0, 0.5, 0.36]}
				scale={[0.36, 0.06, 0.02]}
			>
				<boxGeometry />
			</ToonMesh>
		</group>
	);
}

/** The witch's cauldron at the patch's gate, a green glow on top. */
export function Cauldron({ at }: { at: Vec3 }) {
	const art = SEASON_ACT_ART.halloween;
	return (
		<group position={at}>
			<ToonMesh
				castShadow
				color={art.post}
				ink={0.02}
				position={[0, 0.34, 0]}
				scale={[0.42, 0.34, 0.42]}
			>
				<sphereGeometry args={[1, 14, 10]} />
			</ToonMesh>
			<mesh position={[0, 0.6, 0]} scale={[0.32, 0.04, 0.32]}>
				<cylinderGeometry args={[1, 1, 1, 14]} />
				<meshBasicMaterial color={art.postTrim} toneMapped={false} />
			</mesh>
		</group>
	);
}

/** The festival post box at the street's end: a green pillar box. */
export function PostBox({ at }: { at: Vec3 }) {
	const art = SEASON_ACT_ART["lunar-new-year"];
	return (
		<group position={at}>
			<ToonMesh
				castShadow
				color={art.post}
				ink={0.02}
				position={[0, 0.5, 0]}
				scale={[0.26, 0.5, 0.26]}
			>
				<cylinderGeometry args={[1, 1, 2, 14]} />
			</ToonMesh>
			<ToonMesh
				color={art.postTrim}
				ink={0.01}
				position={[0, 1.04, 0]}
				scale={[0.3, 0.1, 0.3]}
			>
				<sphereGeometry args={[1, 14, 8]} />
			</ToonMesh>
		</group>
	);
}

/**
 * What covers a stopped run's place: frost over the advent door or window
 * (frosted shut), a cobweb over the pumpkin, a dark cover over the lantern.
 */
export function StoppedCover({
	place,
	season,
}: {
	place: WorldDoor;
	season: Season;
}) {
	const art = SEASON_ACT_ART[season];
	const [x, y, z] = place.at;
	if (season === "advent") {
		const front = place.yaw === 0;
		const tall = storey(place) === 0 ? 1.1 : 0.72;
		return (
			<group position={front ? [x, y, z + 0.06] : [x + 0.06, y, z]}>
				<mesh scale={front ? [0.95, tall, 0.04] : [0.04, tall, 0.95]}>
					<boxGeometry />
					<meshBasicMaterial
						color={art.cover}
						opacity={0.82}
						toneMapped={false}
						transparent
					/>
				</mesh>
				{[-0.3, -0.1, 0.1, 0.3].map((along) => (
					<ToonMesh
						color={art.coverEdge}
						key={along}
						position={
							front
								? [along, tall / 2 - 0.08, 0.04]
								: [0.04, tall / 2 - 0.08, along]
						}
						rotation={[Math.PI, 0, 0]}
						scale={[0.05, 0.22, 0.05]}
					>
						<coneGeometry args={[1, 1, 6]} />
					</ToonMesh>
				))}
			</group>
		);
	}
	if (season === "halloween") {
		// A cobweb strung over the pumpkin: a few pale threads.
		return (
			<group position={[x, 0.55, z]}>
				{[0, Math.PI / 3, (2 * Math.PI) / 3].map((turn) => (
					<ToonMesh
						color={art.cover}
						key={turn}
						rotation={[0, turn, Math.PI / 2]}
						scale={[0.68, 0.68, 0.68]}
					>
						<torusGeometry args={[1, 0.012, 4, 24, Math.PI]} />
					</ToonMesh>
				))}
			</group>
		);
	}
	return (
		<ToonMesh color={art.cover} position={[x, y, z]} scale={[0.4, 0.36, 0.4]}>
			<sphereGeometry args={[1, 14, 10]} />
		</ToonMesh>
	);
}
