/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { waitBand } from "@ryuhq/protocol/interfaces";
import { useRef } from "react";
import type { Mesh } from "three";
import { ACT_ART } from "./game3d-acts-palette.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";

/**
 * The wait timers' props and pure levels behind `WaitTimer3D` (re-exported
 * from `game3d-meters.tsx`): the band colour, the hourglass and the candle.
 */

/** The timer fill colour for a wait band. */
export function bandColor(band: ReturnType<typeof waitBand>): string {
	switch (band) {
		case "fresh":
			return ACT_ART.bandFresh;
		case "waiting":
			return ACT_ART.bandWaiting;
		case "long":
			return ACT_ART.bandLong;
		case "stale":
			return ACT_ART.bandStale;
		case "expiring":
			return ACT_ART.bandExpiring;
		default:
			return ACT_ART.bandUnknown;
	}
}

/** One ask's wait, as `WaitTimer3D` and the queue plate read it. */
export interface WaitTimerSpec {
	approx?: boolean;
	since: string | null;
	until?: string | null;
	untilApprox?: boolean;
}

/** The width of the sand left on top for a level (never a sliver). */
export function sandWidth(level: number): number {
	return 0.11 * Math.max(0.2, level);
}

/** How full the hourglass top is (1 full, 0 run out). */
export function timerLevel(timer: WaitTimerSpec, nowMs: number): number {
	const since = timer.since ? Date.parse(timer.since) : null;
	const until = timer.until ? Date.parse(timer.until) : null;
	if (since !== null && until !== null && until > since) {
		return Math.min(1, Math.max(0, (until - nowMs) / (until - since)));
	}
	if (since === null) {
		return 1;
	}
	// No deadline: drains over an hour of waiting, then stays nearly empty.
	return Math.max(0.08, 1 - (nowMs - since) / 3_600_000);
}

/** How tall a candle's wax stands for a level (never a stub). */
export function candleHeight(level: number): number {
	return 0.42 * Math.max(0.12, level);
}

export interface TimerPropProps {
	at: Vec3;
	color?: string;
	nowMs: number;
	reducedMotion: boolean;
	timer: WaitTimerSpec;
}

/** A candle on a dish: the wax melts to the timer's level; the flame wears its band. */
export function CandleTimer({
	at,
	color,
	nowMs,
	reducedMotion,
	timer,
}: TimerPropProps) {
	const flame = useRef<Mesh>(null);
	const band = waitBand(
		timer.since ? Date.parse(timer.since) : null,
		nowMs,
		timer.until ? Date.parse(timer.until) : null
	);
	const height = candleHeight(timerLevel(timer, nowMs));
	const pulse = band === "expiring" && !reducedMotion;
	useFrame(({ clock }) => {
		const mesh = flame.current;
		if (!(mesh && pulse)) {
			return;
		}
		const flicker = 1 + Math.sin(clock.elapsedTime * 8) * 0.18;
		mesh.scale.set(0.045 * flicker, 0.09 * flicker, 0.045 * flicker);
	});
	return (
		<group position={at}>
			<ToonMesh
				color={color ?? ACT_ART.timerFrame}
				ink={0.01}
				position={[0, 0.015, 0]}
				scale={[0.17, 0.03, 0.17]}
			>
				<cylinderGeometry args={[1, 1, 1, 12]} />
			</ToonMesh>
			<ToonMesh
				color={ACT_ART.candleWax}
				ink={0.01}
				position={[0, 0.03 + height / 2, 0]}
				scale={[0.07, height, 0.07]}
			>
				<cylinderGeometry args={[1, 1, 1, 12]} />
			</ToonMesh>
			<ToonMesh
				color={ACT_ART.candleWick}
				position={[0, 0.06 + height, 0]}
				scale={[0.008, 0.05, 0.008]}
			>
				<cylinderGeometry args={[1, 1, 1, 6]} />
			</ToonMesh>
			<mesh
				position={[0, 0.13 + height, 0]}
				ref={flame}
				scale={[0.045, 0.09, 0.045]}
			>
				<sphereGeometry args={[1, 10, 8]} />
				<meshBasicMaterial color={bandColor(band)} toneMapped={false} />
			</mesh>
		</group>
	);
}

/** The kit's hourglass: sand on top drains to the timer's level. */
export function HourglassTimer({
	at,
	color,
	nowMs,
	reducedMotion,
	timer,
}: TimerPropProps) {
	const sand = useRef<Mesh>(null);
	const band = waitBand(
		timer.since ? Date.parse(timer.since) : null,
		nowMs,
		timer.until ? Date.parse(timer.until) : null
	);
	const level = timerLevel(timer, nowMs);
	const pulse = band === "expiring" && !reducedMotion;
	useFrame(({ clock }) => {
		const mesh = sand.current;
		if (!(mesh && pulse)) {
			return;
		}
		mesh.scale.x =
			sandWidth(level) * (1 + Math.sin(clock.elapsedTime * 8) * 0.12);
		mesh.scale.z = mesh.scale.x;
	});
	const fill = bandColor(band);
	const frame = color ?? ACT_ART.timerFrame;
	return (
		<group position={at}>
			{[0, 0.42].map((y) => (
				<ToonMesh
					color={frame}
					ink={0.01}
					key={y}
					position={[0, y, 0]}
					scale={[0.16, 0.03, 0.16]}
				>
					<cylinderGeometry args={[1, 1, 1, 12]} />
				</ToonMesh>
			))}
			<ToonMesh
				color={ACT_ART.timerGlass}
				position={[0, 0.31, 0]}
				rotation={[Math.PI, 0, 0]}
				scale={[0.12, 0.2, 0.12]}
			>
				<coneGeometry args={[1, 1, 12, 1, true]} />
			</ToonMesh>
			<ToonMesh
				color={ACT_ART.timerGlass}
				position={[0, 0.11, 0]}
				scale={[0.12, 0.2, 0.12]}
			>
				<coneGeometry args={[1, 1, 12, 1, true]} />
			</ToonMesh>
			{/* Sand left on top, and the pile below. */}
			<mesh
				position={[0, 0.22 + 0.09 * level, 0]}
				ref={sand}
				scale={[sandWidth(level), 0.18 * level, sandWidth(level)]}
			>
				<cylinderGeometry args={[1, 0.15, 1, 10]} />
				<meshBasicMaterial color={fill} toneMapped={false} />
			</mesh>
			<mesh
				position={[0, 0.05 + 0.04 * (1 - level), 0]}
				scale={[0.1, 0.08 * (1 - level) + 0.01, 0.1]}
			>
				<coneGeometry args={[1, 1, 10]} />
				<meshBasicMaterial color={fill} toneMapped={false} />
			</mesh>
		</group>
	);
}
