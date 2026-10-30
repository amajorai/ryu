/* eslint-disable react/no-unknown-property */
import { RoundedBox } from "@react-three/drei";
import type { CabinetWords } from "./arcade-acts.tsx";
import {
	emissive,
	Lettering,
	MARQUEE_SIGN_Y,
	ReelSymbol3d,
	reelIcon,
} from "./arcade-diorama-lettering.tsx";
import type { Machine } from "./arcade-model.ts";
import { ARCADE_3D, type CabinetSkin } from "./arcade-palette.ts";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { PROP_INK } from "./game3d-props.tsx";

/** The screen's attract colour: what the machine is doing. */
function attractColor(machine: Machine): string {
	if (machine.tilt) {
		return ARCADE_3D.tilt;
	}
	if (machine.jackpots.length > 0) {
		return ARCADE_3D.topper;
	}
	if (machine.running) {
		return ARCADE_3D.neon[1];
	}
	return ARCADE_3D.screenIdle;
}

const BULBS = [-0.36, -0.22, -0.08, 0.08, 0.22, 0.36] as const;

/**
 * One arcade cabinet, facing +z: a base and upper body in its player's
 * colour with a diagonal accent stripe as side art, a slanted control deck
 * with a joystick and three buttons, a big glowing screen in its attract
 * colour with the three reels on it (tipped back toward the camera so the
 * symbols read), a lit marquee with a row of bulbs, a jackpot light on top
 * and a red lamp when it tilts.
 */
/** The act layer's screen colour for a cabinet's words. */
function wordsAttract(words: CabinetWords): string {
	if (words.tone === "tilt") {
		return ARCADE_3D.tilt;
	}
	if (words.tone === "limit") {
		return ARCADE_3D.marqueeLimit;
	}
	if (words.tone === "paused") {
		return ARCADE_3D.screenIdle;
	}
	return words.reels.length > 0 ? ARCADE_3D.neon[1] : ARCADE_3D.screenIdle;
}

const WORD_COLOR: Record<CabinetWords["tone"], string> = {
	ink: ARCADE_3D.marqueeInk,
	limit: ARCADE_3D.marqueeLimit,
	paused: ARCADE_3D.marqueePaused,
	tilt: ARCADE_3D.marqueeTilt,
};

export function Cabinet({
	accent,
	body,
	machine,
	night,
	skin,
	words = null,
}: {
	accent: string;
	body: string;
	machine: Machine;
	night: boolean;
	skin: CabinetSkin;
	/**
	 * The act layer's lettering: the marquee (TILT and why, INSERT COIN,
	 * the step), the reels (the step's kind and the two before it) and the
	 * screen's attract line (what is next). Without it, today's cabinet.
	 */
	words?: CabinetWords | null;
}) {
	const won = words ? false : machine.jackpots.length > 0;
	const attract = words ? wordsAttract(words) : attractColor(machine);
	const tilted = words ? words.tone === "tilt" : machine.tilt !== null;
	return (
		<group>
			<RoundedBox
				args={[1.0, 1.1, 0.72]}
				castShadow
				position={[0, 0.55, 0]}
				radius={0.06}
				receiveShadow
			>
				<ToonMaterial color={body} />
			</RoundedBox>
			<ToonMesh color={skin.shade} position={[0, 0.52, 0.362]}>
				<boxGeometry args={[0.8, 0.84, 0.02]} />
			</ToonMesh>
			<mesh position={[0, 0.7, 0.375]}>
				<boxGeometry args={[0.3, 0.08, 0.01]} />
				<ToonMaterial {...emissive(skin.bulb, true, night)} />
			</mesh>
			{/* Side art: a diagonal stripe in the accent colour on both sides. */}
			{[-1, 1].map((side) => (
				<group key={side}>
					<mesh position={[side * 0.502, 0.95, 0]} rotation={[0.7, 0, 0]}>
						<boxGeometry args={[0.012, 0.14, 1.1]} />
						<ToonMaterial color={accent} />
					</mesh>
					<mesh position={[side * 0.502, 1.85, -0.12]} rotation={[0.7, 0, 0]}>
						<boxGeometry args={[0.012, 0.08, 0.6]} />
						<ToonMaterial color={accent} />
					</mesh>
				</group>
			))}
			{/* The slanted control deck: joystick and three buttons. */}
			<group position={[0, 1.14, 0.24]} rotation={[0.32, 0, 0]}>
				<ToonMesh castShadow color={skin.body} ink={PROP_INK * 0.7}>
					<boxGeometry args={[1.0, 0.1, 0.42]} />
				</ToonMesh>
				<ToonMesh color={ARCADE_3D.lever} position={[-0.24, 0.11, 0.02]}>
					<cylinderGeometry args={[0.016, 0.016, 0.16, 8]} />
				</ToonMesh>
				<ToonMesh
					color={ARCADE_3D.knob}
					ink={PROP_INK * 0.5}
					position={[-0.24, 0.2, 0.02]}
				>
					<sphereGeometry args={[0.05, 14, 10]} />
				</ToonMesh>
				{[0, 1, 2].map((index) => (
					<mesh key={index} position={[0.04 + index * 0.13, 0.06, 0.04]}>
						<cylinderGeometry args={[0.035, 0.035, 0.03, 14]} />
						<ToonMaterial
							{...emissive(
								ARCADE_3D.neon[index] ?? ARCADE_3D.topper,
								true,
								night
							)}
						/>
					</mesh>
				))}
			</group>
			{/* Upper body with the screen. */}
			<RoundedBox
				args={[1.0, 1.24, 0.5]}
				castShadow
				position={[0, 1.8, -0.11]}
				radius={0.05}
			>
				<ToonMaterial color={body} />
			</RoundedBox>
			<group position={[0, 1.9, 0.16]} rotation={[-0.24, 0, 0]}>
				<ToonMesh color={skin.trim} ink={PROP_INK * 0.6}>
					<boxGeometry args={[0.94, 0.84, 0.03]} />
				</ToonMesh>
				<mesh position={[0, 0, 0.018]}>
					<boxGeometry args={[0.86, 0.76, 0.01]} />
					<ToonMaterial {...emissive(attract, true, night)} />
				</mesh>
				{machine.reels.map((reel, index) => (
					<group
						key={`${index}:${reel.symbol}`}
						position={[(index - 1) * 0.28, 0, 0.026]}
					>
						<mesh>
							<boxGeometry args={[0.26, 0.6, 0.01]} />
							<ToonMaterial {...emissive(ARCADE_3D.reel, true, false)} />
						</mesh>
						<group position={[0, 0, 0.008]}>
							{words ? (
								// The act layer's reels show only step kinds;
								// never the legacy thread-status symbols.
								words.reels[index] ? (
									<Lettering
										color={ARCADE_3D.marqueeInk}
										height={0.25}
										night={night}
										position={[0, 0, 0]}
										text={reelIcon(words.reels[index])}
										width={0.25}
									/>
								) : null
							) : (
								<ReelSymbol3d night={night} symbol={reel.symbol} />
							)}
						</group>
					</group>
				))}
				{words?.next ? (
					<Lettering
						color={ARCADE_3D.marqueeInk}
						height={0.09}
						night={night}
						position={[0, -0.33, 0.026]}
						text={words.next}
						width={0.8}
					/>
				) : null}
			</group>
			{/* The lit marquee with its bulbs. */}
			<RoundedBox
				args={[1.04, 0.3, 0.56]}
				castShadow
				position={[0, 2.58, -0.09]}
				radius={0.06}
			>
				<ToonMaterial {...emissive(skin.sign, true, night)} />
			</RoundedBox>
			<mesh position={[0, 2.6, 0.196]}>
				<boxGeometry args={[0.78, 0.13, 0.01]} />
				<ToonMaterial {...emissive(skin.signText, true, night)} />
			</mesh>
			{words?.marquee ? (
				// The act's sign over the marquee, big enough to read across
				// the hall: TILT / PAUSED / INSERT COIN or the step on top,
				// why or when underneath.
				<group position={[0, MARQUEE_SIGN_Y, -0.02]}>
					<RoundedBox args={[1.5, 0.62, 0.08]} radius={0.04}>
						<ToonMaterial {...emissive(skin.sign, true, night)} />
					</RoundedBox>
					<Lettering
						color={WORD_COLOR[words.tone]}
						height={0.54}
						night={night}
						position={[0, 0, 0.045]}
						text={words.marquee}
						width={1.42}
					/>
				</group>
			) : null}
			{BULBS.map((x) => (
				<mesh key={x} position={[x * 1.1, 2.46, 0.2]}>
					<sphereGeometry args={[0.025, 8, 6]} />
					<ToonMaterial {...emissive(skin.bulb, true, night)} />
				</mesh>
			))}
			<RoundedBox
				args={[0.46, 0.12, 0.2]}
				position={[0, 2.8, -0.09]}
				radius={0.04}
			>
				<ToonMaterial
					{...emissive(
						won ? ARCADE_3D.topper : ARCADE_3D.topperOff,
						won,
						night
					)}
				/>
			</RoundedBox>
			{tilted ? (
				<mesh position={[0.34, 2.84, -0.09]}>
					<sphereGeometry args={[0.07, 14, 10]} />
					<ToonMaterial {...emissive(ARCADE_3D.tilt, true, true)} />
				</mesh>
			) : null}
		</group>
	);
}
