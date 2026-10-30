/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceProgress } from "@ryuhq/protocol/interfaces";
import { waitLabel } from "@ryuhq/protocol/interfaces";
import { useRef } from "react";
import type { Group, Mesh } from "three";
import { GAME_PLATE } from "./game-hud.tsx";
import { ACT_ART } from "./game3d-acts-palette.ts";
import { CurvedAnchor, type FollowBody } from "./game3d-anchor.tsx";
import { ToonMesh } from "./game3d-materials.tsx";
import {
	CandleTimer,
	HourglassTimer,
	type WaitTimerSpec,
} from "./game3d-meters-timer-props.tsx";
import type { Vec3 } from "./game3d-palette.ts";

export {
	bandColor,
	candleHeight,
	sandWidth,
	timerLevel,
	type WaitTimerSpec,
} from "./game3d-meters-timer-props.tsx";

/**
 * The act layer's meters, drawn at a station or a you-spot slot:
 * `ProgressPips3D` (real plan / workflow steps as pips, an estimate as a
 * hatched bar marked "~", nothing when there is no progress: never a guessed
 * value), `WaitTimer3D` (an hourglass draining from when an ask began,
 * coloured by its wait band, pulsing only in its last 2 minutes) and
 * `RunCue` (the amber "Longer than usual" ring and the "stalled?"
 * hourglass). Under reduced motion every meter is static at its level.
 * Text plates are budgeted overlays (`data-budgeted-overlay`); a game
 * passes `showText={false}` when the overlay budget drops them.
 */

/** A game's colours for the pips (done, to do, estimate fill). */
export interface PipSkin {
	done?: string;
	estimate?: string;
	todo?: string;
}

/** Pips beyond this scale down, and the plate shows "done/total". */
export const MAX_PIPS = 8;
const PIP_GAP = 0.2;
const PIP_SIZE = 0.13;
const VANISH_SECONDS = 0.45;

/** The look of a meter's text plate (also each line of a station board). */
export const METER_TEXT_CLASS = cn(
	GAME_PLATE,
	"gk-display pointer-events-none flex h-6 select-none items-center whitespace-nowrap rounded-lg px-2 text-[12px] leading-none"
);

/** A small text plate over a meter (a budgeted status overlay). */
export function MeterText({
	at,
	children,
	curved = false,
	follow,
	kind = "text",
}: {
	at: Vec3;
	children: string;
	/**
	 * Sits on a curved stage's ground (CurvedAnchor), so the words drop with
	 * it. Default: a plain group at `at`.
	 */
	curved?: boolean;
	/** Tracks a walking body (implies curved; `at` x and z are then ignored). */
	follow?: FollowBody;
	kind?: string;
}) {
	const words = (
		<Html center zIndexRange={[18, 0]}>
			<span
				aria-hidden="true"
				className={METER_TEXT_CLASS}
				data-budgeted-overlay={kind}
				data-iso-plate=""
			>
				{children}
			</span>
		</Html>
	);
	if (curved || follow) {
		return (
			<CurvedAnchor follow={follow} position={at}>
				{words}
			</CurvedAnchor>
		);
	}
	return <group position={at}>{words}</group>;
}

/** The pip plate's words: "3/7" for steps, "~" for an estimate. */
export function progressText(
	progress: InterfaceProgress | null
): string | null {
	if (!progress) {
		return null;
	}
	if (progress.kind === "estimate") {
		return "~";
	}
	return `${progress.done}/${progress.total}`;
}

/** A plan or workflow's step count, or null for an estimate or nothing. */
export function discreteTotal(
	progress: InterfaceProgress | null
): number | null {
	if (!progress || progress.kind === "estimate" || progress.total <= 0) {
		return null;
	}
	return progress.total;
}

/**
 * How many drawn pips shrink away when a plan is rewritten from `before`
 * to `after` steps (both discrete): only fewer drawn pips, at most 8.
 */
export function pipShrink(before: number | null, after: number | null): number {
	if (before === null || after === null) {
		return 0;
	}
	return Math.max(0, Math.min(before, MAX_PIPS) - Math.min(after, MAX_PIPS));
}

/**
 * The pips drawn for discrete progress: at most 8 (scaled down past 8),
 * filled by floor, so a pip only fills once its step is done and all of
 * them only when every step is.
 */
export function pipCounts(
	progress: Pick<InterfaceProgress, "done" | "total">
): {
	count: number;
	filled: number;
	scale: number;
} {
	const count = Math.min(progress.total, MAX_PIPS);
	const filled =
		progress.done >= progress.total
			? count
			: Math.min(
					count - 1,
					Math.floor((progress.done / progress.total) * count)
				);
	return {
		count,
		filled: Math.max(0, filled),
		scale: progress.total > MAX_PIPS ? 0.65 : 1,
	};
}

/**
 * Real progress at a station. Plan and workflow steps are solid pips (done
 * filled, the rest pale); past 8 they shrink and the plate reads "12/20".
 * When a plan is rewritten shorter, the extra pips shrink away. An
 * estimate is a translucent bar, hatched, with "~". No progress draws
 * nothing: the game's station prop stays idle.
 */
export function ProgressPips3D({
	at,
	progress,
	reducedMotion,
	showText = true,
	skin = {},
}: {
	at: Vec3;
	progress: InterfaceProgress | null;
	reducedMotion: boolean;
	showText?: boolean;
	skin?: PipSkin;
}) {
	const previous = useRef<number | null>(discreteTotal(progress));
	const vanishing = useRef<{ count: number; since: number } | null>(null);
	const group = useRef<Group>(null);
	const total = discreteTotal(progress);
	if (total === null) {
		// Not drawing pips: nothing can be shrinking.
		vanishing.current = null;
	} else if (total !== previous.current) {
		const shrink = reducedMotion ? 0 : pipShrink(previous.current, total);
		vanishing.current = shrink > 0 ? { count: shrink, since: -1 } : null;
	}
	previous.current = total;
	useFrame(({ clock }) => {
		const fading = vanishing.current;
		const root = group.current;
		if (!(fading && root)) {
			return;
		}
		if (fading.since < 0) {
			fading.since = clock.elapsedTime;
		}
		const t = Math.min(1, (clock.elapsedTime - fading.since) / VANISH_SECONDS);
		for (const child of root.children) {
			if (child.userData.vanishing) {
				child.scale.setScalar(1 - t);
			}
		}
		if (t >= 1) {
			vanishing.current = null;
		}
	});
	if (!progress || progress.total <= 0) {
		return null;
	}
	const done = skin.done ?? ACT_ART.pipDone;
	const todo = skin.todo ?? ACT_ART.pipTodo;
	const text = progressText(progress);
	if (progress.kind === "estimate") {
		const fraction = Math.min(1, Math.max(0, progress.done / progress.total));
		const width = 0.9;
		return (
			<group position={at}>
				<ToonMesh color={todo} ink={0.012} scale={[width, 0.08, 0.12]}>
					<boxGeometry />
				</ToonMesh>
				<ToonMesh
					color={skin.estimate ?? ACT_ART.pipEstimate}
					position={[-width / 2 + (width * fraction) / 2, 0.01, 0.005]}
					scale={[width * fraction, 0.085, 0.125]}
				>
					<boxGeometry />
				</ToonMesh>
				{/* Hatching: thin pale bars across the fill, so it never reads as exact. */}
				{[0.15, 0.35, 0.55, 0.75].map((x) =>
					x < fraction ? (
						<ToonMesh
							color={todo}
							key={x}
							position={[-width / 2 + width * x, 0.012, 0.066]}
							rotation={[0, 0, 0.6]}
							scale={[0.025, 0.11, 0.004]}
						>
							<boxGeometry />
						</ToonMesh>
					) : null
				)}
				{showText && text ? (
					<MeterText at={[0, 0.32, 0]}>{text}</MeterText>
				) : null}
			</group>
		);
	}
	const { count, filled, scale } = pipCounts(progress);
	const gap = PIP_GAP * scale;
	const extra = Math.min(vanishing.current?.count ?? 0, MAX_PIPS);
	const span = (count + extra - 1) * gap;
	return (
		<group position={at}>
			<group ref={group}>
				{Array.from({ length: count + extra }, (_, index) => (
					<group
						// biome-ignore lint/suspicious/noArrayIndexKey: pips are positional.
						key={index}
						position={[-span / 2 + index * gap, 0, 0]}
						userData={{ vanishing: index >= count }}
					>
						<ToonMesh
							color={index < filled ? done : todo}
							ink={0.01}
							scale={PIP_SIZE * scale}
						>
							<sphereGeometry args={[0.5, 10, 8]} />
						</ToonMesh>
					</group>
				))}
			</group>
			{showText && (progress.total > MAX_PIPS || text) ? (
				<MeterText at={[0, 0.3, 0]}>{text ?? ""}</MeterText>
			) : null}
		</group>
	);
}

/**
 * A queue plate's words: the name, then the countdown when the ask has a
 * deadline ("in 7m", "≤ 7m"), else how long it has waited ("14m", "~7m").
 */
export function queuePlateText(
	name: string,
	timer: WaitTimerSpec,
	nowMs: number
): string {
	const label = waitLabel(timer.since, nowMs, {
		approx: timer.approx,
		until: timer.until,
		untilApprox: timer.untilApprox,
	});
	return label ? `${name} · ${label}` : name;
}

/** A wait timer's prop: the kit's hourglass, or a candle that melts. */
export type WaitTimerShape = "candle" | "hourglass";

/**
 * An hourglass beside a queued ask (or a limit, counting to its reset).
 * It drains from `since` toward the deadline, coloured by the wait band;
 * only the last 2 minutes pulse, and under reduced motion it is a static
 * fill at its level. Its words live in the slot's queue plate. `shape`
 * "candle" draws a candle instead, its wax melting down to the same level
 * and its flame in the band colour.
 */
export function WaitTimer3D({
	at,
	color,
	nowMs,
	reducedMotion,
	shape = "hourglass",
	timer,
}: {
	at: Vec3;
	/** A game skin's frame colour (the hourglass caps, the candle's dish). */
	color?: string;
	nowMs: number;
	reducedMotion: boolean;
	shape?: WaitTimerShape;
	timer: WaitTimerSpec;
}) {
	if (shape === "candle") {
		return (
			<CandleTimer
				at={at}
				color={color}
				nowMs={nowMs}
				reducedMotion={reducedMotion}
				timer={timer}
			/>
		);
	}
	return (
		<HourglassTimer
			at={at}
			color={color}
			nowMs={nowMs}
			reducedMotion={reducedMotion}
			timer={timer}
		/>
	);
}

/**
 * Run cues at a station: an amber ring when the routine runs longer than
 * usual ("Longer than usual · 48m" when the start is exact), or a grey
 * hourglass with "stalled?" when the run shows no progress.
 */
export function RunCue({
	at,
	elapsed,
	longerThanUsual,
	reducedMotion,
	showText = true,
	stalled,
}: {
	at: Vec3;
	elapsed: string | null;
	longerThanUsual: boolean;
	reducedMotion: boolean;
	showText?: boolean;
	stalled: boolean;
}) {
	const tl = useLiteralMessages();
	const ring = useRef<Mesh>(null);
	useFrame(({ clock }) => {
		if (ring.current && !reducedMotion) {
			ring.current.rotation.z = clock.elapsedTime * 0.6;
		}
	});
	if (stalled) {
		return (
			<group position={at}>
				<WaitTimer3D
					at={[0, 0, 0]}
					color={ACT_ART.cueStalled}
					nowMs={0}
					reducedMotion
					timer={{ since: null }}
				/>
				{showText ? <MeterText at={[0, 0.7, 0]}>stalled?</MeterText> : null}
			</group>
		);
	}
	if (!longerThanUsual) {
		return null;
	}
	return (
		<group position={at}>
			<mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]}>
				<torusGeometry args={[0.55, 0.035, 8, 40]} />
				<meshBasicMaterial color={ACT_ART.cueAmber} toneMapped={false} />
			</mesh>
			{showText ? (
				<MeterText at={[0, 0.5, 0]}>
					{elapsed
						? tl("Longer than usual · {elapsed}", { elapsed })
						: "Longer than usual"}
				</MeterText>
			) : null}
		</group>
	);
}
