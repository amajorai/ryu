/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	blockerAriaLabel,
	type ClockOptions,
	type InterfaceBlocker,
} from "@ryuhq/protocol/interfaces";
import { AlarmClock, CalendarX, Flag, Siren } from "lucide-react";
import { useRef } from "react";
import type { Group } from "three";
import { ACT_ART } from "./game3d-acts-palette.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { MeterText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { ActPlate } from "./game3d-signs.tsx";

/**
 * Why a run stopped, at the thread's station: `AlarmBeacon`, one per
 * counted blocker, whatever the agent is doing now (a working agent's
 * recent failure still shows). Tones: a red lantern with smoke for errors
 * and billing (and failed commands, tools, logins), a grey flag when a run
 * was interrupted, an amber clock for a rate limit, a crossed calendar tag
 * for a failed routine. An older failure is a dim, unlit mark with no
 * plate. Each lit alarm's plate shows the blocker's title and opens the
 * read-only blocker card. `LimitCue` is the amber clock and "back 15:10"
 * plate of a limited agent with no blocker of its own.
 */

export type AlarmTone = "calendar" | "grey" | "red" | "amber";

export function alarmTone(blocker: Pick<InterfaceBlocker, "kind">): AlarmTone {
	switch (blocker.kind) {
		case "interrupted":
			return "grey";
		case "rate-limited":
			return "amber";
		case "schedule-failed":
			return "calendar";
		default:
			return "red";
	}
}

const TONE_CLASS: Record<AlarmTone, string> = {
	amber: "bg-(--gk-warn) text-(--gk-edge)",
	calendar: "bg-(--gk-bad) text-white",
	grey: "bg-(--gk-plate-sunk) text-(--gk-ink)",
	red: "bg-(--gk-bad) text-white",
};

const SMOKE_PUFFS = 4;

/** Smoke rising from a red lantern (never under reduced motion). */
function Smoke() {
	const ref = useRef<Group>(null);
	useFrame(({ clock }) => {
		const group = ref.current;
		if (!group) {
			return;
		}
		for (const [index, puff] of group.children.entries()) {
			const t = (clock.elapsedTime * 0.4 + index / SMOKE_PUFFS) % 1;
			puff.position.set(Math.sin(index * 2.1 + t * 3) * 0.08, t * 0.7, 0);
			puff.scale.setScalar(0.05 + t * 0.09);
		}
	});
	return (
		<group position={[0, 0.85, 0]} ref={ref}>
			{Array.from({ length: SMOKE_PUFFS }, (_, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: puffs are interchangeable.
				<mesh key={index}>
					<sphereGeometry args={[1, 8, 6]} />
					<meshBasicMaterial
						color={ACT_ART.alarmDim}
						opacity={0.6}
						transparent
					/>
				</mesh>
			))}
		</group>
	);
}

function Lantern({ glass, lit }: { glass: string; lit: boolean }) {
	return (
		<group>
			<ToonMesh
				color={ACT_ART.alarmMetal}
				ink={0.012}
				position={[0, 0.3, 0]}
				scale={[0.05, 0.6, 0.05]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={ACT_ART.alarmMetal}
				ink={0.012}
				position={[0, 0.62, 0]}
				scale={[0.2, 0.04, 0.2]}
			>
				<boxGeometry />
			</ToonMesh>
			<mesh position={[0, 0.74, 0]}>
				<boxGeometry args={[0.16, 0.2, 0.16]} />
				{lit ? (
					<meshBasicMaterial color={glass} toneMapped={false} />
				) : (
					<meshLambertMaterial color={ACT_ART.alarmDim} />
				)}
			</mesh>
			<ToonMesh
				color={ACT_ART.alarmMetal}
				position={[0, 0.86, 0]}
				scale={[0.12, 0.05, 0.12]}
			>
				<coneGeometry args={[1, 1, 4]} />
			</ToonMesh>
		</group>
	);
}

function AlarmMesh({ dim, tone }: { dim: boolean; tone: AlarmTone }) {
	switch (tone) {
		case "grey":
			return (
				<group>
					<ToonMesh
						color={ACT_ART.post}
						ink={0.012}
						position={[0, 0.4, 0]}
						scale={[0.04, 0.8, 0.04]}
					>
						<boxGeometry />
					</ToonMesh>
					<ToonMesh
						color={dim ? ACT_ART.alarmDim : ACT_ART.flagGrey}
						ink={0.012}
						position={[0.14, 0.68, 0]}
						scale={[0.26, 0.17, 0.015]}
					>
						<boxGeometry />
					</ToonMesh>
				</group>
			);
		case "calendar":
			return (
				<group>
					<ToonMesh
						color={ACT_ART.post}
						ink={0.012}
						position={[0, 0.25, 0]}
						scale={[0.04, 0.5, 0.04]}
					>
						<boxGeometry />
					</ToonMesh>
					<ToonMesh
						color={dim ? ACT_ART.alarmDim : ACT_ART.calendar}
						ink={0.012}
						position={[0, 0.56, 0.03]}
						scale={[0.26, 0.24, 0.02]}
					>
						<boxGeometry />
					</ToonMesh>
					{dim
						? null
						: [0.7, -0.7].map((roll) => (
								<ToonMesh
									color={ACT_ART.calendarCross}
									key={roll}
									position={[0, 0.55, 0.05]}
									rotation={[0, 0, roll]}
									scale={[0.22, 0.03, 0.01]}
								>
									<boxGeometry />
								</ToonMesh>
							))}
				</group>
			);
		case "amber":
			return dim ? (
				<Lantern glass={ACT_ART.alarmAmber} lit={false} />
			) : (
				<AmberClock />
			);
		default:
			return <Lantern glass={ACT_ART.alarmRed} lit={!dim} />;
	}
}

function ToneIcon({ tone }: { tone: AlarmTone }) {
	switch (tone) {
		case "grey":
			return <Flag aria-hidden="true" />;
		case "amber":
			return <AlarmClock aria-hidden="true" />;
		case "calendar":
			return <CalendarX aria-hidden="true" />;
		default:
			return <Siren aria-hidden="true" />;
	}
}

/**
 * One blocker's alarm at its station. Lit, it has a plate (the title, in
 * bubble style) named by `blockerAriaLabel` that opens the blocker card;
 * `old` draws only a dim mark (an uncounted, older failure) with no plate.
 */
export function AlarmBeacon({
	agentName,
	at,
	blocker,
	clock,
	focusable,
	front = false,
	iconOnly,
	nowMs,
	old = false,
	onOpen,
	plateAt = [0, 1.15, 0],
	privacy = "full",
	reducedMotion,
	row = 0,
	side = "center",
}: {
	agentName: string;
	at: Vec3;
	blocker: InterfaceBlocker;
	clock?: ClockOptions;
	focusable: boolean;
	/** Keep the plate above every other act plate (the focus alarm). */
	front?: boolean;
	iconOnly?: boolean;
	nowMs: number;
	old?: boolean;
	onOpen?: () => void;
	/** Where the plate sits, from the beacon (default just above it). */
	plateAt?: Vec3;
	privacy?: "full" | "redacted";
	reducedMotion: boolean;
	/** Plate rows to lift the plate up the screen (stacked alarms). */
	row?: number;
	/** Where the plate hangs from its anchor (see `ActPlate`). */
	side?: "center" | "left" | "right";
}) {
	const tl = useLiteralMessages();
	const tone = alarmTone(blocker);
	return (
		<group position={at} scale={old ? 0.7 : 1}>
			<AlarmMesh dim={old} tone={tone} />
			{tone === "red" && !old && !reducedMotion ? <Smoke /> : null}
			{old || !onOpen ? null : (
				<ActPlate
					at={plateAt}
					className={TONE_CLASS[tone]}
					focusable={focusable}
					front={front}
					icon={<ToneIcon tone={tone} />}
					iconOnly={iconOnly}
					kind="alarm"
					label={blockerAriaLabel(blocker, agentName, nowMs, privacy, clock)}
					onActivate={onOpen}
					row={row}
					side={side}
				>
					{blocker.source === "estimate"
						? tl("Likely {title}", { title: blocker.title })
						: blocker.title}
				</ActPlate>
			)}
		</group>
	);
}

/** Space between a station's alarm beacons on the ground. */
export const ALARM_SPACING = 0.42;

/**
 * The default climb per further alarm plate in world units: none, so each
 * plate climbs one plate row (its height plus PLATE_ROW_GAP) on screen,
 * whatever the zoom. A game's own non-zero `step` is the whole climb, as
 * before plate rows existed (no row lift on top).
 */
export const ALARM_STEP: Vec3 = [0, 0, 0];

/** How an alarm plate hangs: "auto" picks from where the alarms sit. */
export type AlarmSide = "auto" | "center" | "left" | "right";

/** Below this screen-right offset (world units) a plate stays centred. */
const SIDE_DEADBAND = 0.35;

/**
 * The side for alarms set at `offset` from their figure (isometric yaw
 * 45°): right when they sit clearly screen-right of it (0.707·(x − z)),
 * left when clearly left, centred otherwise, so a plate never hangs across
 * the figure it explains.
 */
export function alarmSideFor(offset: Vec3): "center" | "left" | "right" {
	const right = Math.SQRT1_2 * (offset[0] - offset[2]);
	if (right > SIDE_DEADBAND) {
		return "right";
	}
	if (right < -SIDE_DEADBAND) {
		return "left";
	}
	return "center";
}

/**
 * Plate rows each further alarm climbs on screen: one up with the default
 * step, none with a game's own step (it is the whole climb). `rows`
 * overrides: 1 up, -1 down, 0 none.
 */
export function alarmRows(step: Vec3, rows?: -1 | 0 | 1): -1 | 0 | 1 {
	if (rows !== undefined) {
		return rows;
	}
	return step[0] === 0 && step[1] === 0 && step[2] === 0 ? 1 : 0;
}

/** The `index`th alarm plate's place, from that alarm's beacon. */
export function alarmPlateAt(index: number, step: Vec3 = ALARM_STEP): Vec3 {
	return [
		index * (step[0] - ALARM_SPACING),
		1.15 + index * step[1],
		index * step[2],
	];
}

/**
 * Every counted blocker of a station's agent, newest first: the beacons
 * side by side on the ground (with the dim marks of older failures after
 * them), and their plates in one column over the first beacon, hanging
 * from it by `side` (ActStation picks the side away from the figure), each
 * `alarmRows(step, rows)` plate rows past the last on screen plus `step` in
 * world units. The focus alarm (index 0) is nearest its beacon and drawn
 * in front of every other plate.
 */
export function AlarmStack({
	agentName,
	at,
	blockers,
	old = [],
	onOpen,
	rows,
	side = "center",
	step = ALARM_STEP,
	...rest
}: Omit<
	Parameters<typeof AlarmBeacon>[0],
	"at" | "blocker" | "front" | "old" | "onOpen" | "plateAt" | "row" | "side"
> & {
	at: Vec3;
	blockers: readonly InterfaceBlocker[];
	old?: readonly InterfaceBlocker[];
	onOpen?: (blocker: InterfaceBlocker) => void;
	/** Plate rows each further plate climbs (default: `alarmRows(step)`). */
	rows?: -1 | 0 | 1;
	/** Where the plates hang (default "center"; ActStation picks by offset). */
	side?: "center" | "left" | "right";
	/** Each further plate's climb from the last (default `ALARM_STEP`). */
	step?: Vec3;
}) {
	const rowStep = alarmRows(step, rows);
	const all = [
		...blockers.map((blocker) => ({ blocker, old: false })),
		...old.map((blocker) => ({ blocker, old: true })),
	];
	return (
		<group position={at}>
			{all.map((entry, index) => (
				<AlarmBeacon
					{...rest}
					agentName={agentName}
					at={[index * ALARM_SPACING, 0, 0]}
					blocker={entry.blocker}
					front={index === 0}
					// biome-ignore lint/suspicious/noArrayIndexKey: a station's alarms are ordered.
					key={index}
					old={entry.old}
					onOpen={onOpen ? () => onOpen(entry.blocker) : undefined}
					plateAt={alarmPlateAt(index, step)}
					row={index * rowStep}
					side={side}
				/>
			))}
		</group>
	);
}

/** The amber clock on a post: a limit, counting to when it resets. */
function AmberClock() {
	return (
		<group>
			<ToonMesh
				color={ACT_ART.post}
				ink={0.012}
				position={[0, 0.25, 0]}
				scale={[0.04, 0.5, 0.04]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={ACT_ART.alarmAmber}
				ink={0.014}
				position={[0, 0.58, 0.02]}
				rotation={[Math.PI / 2, 0, 0]}
				scale={[0.17, 0.04, 0.17]}
			>
				<cylinderGeometry args={[1, 1, 1, 18]} />
			</ToonMesh>
			<ToonMesh
				color={ACT_ART.alarmMetal}
				position={[0.03, 0.62, 0.05]}
				rotation={[0, 0, -0.9]}
				scale={[0.012, 0.09, 0.01]}
			>
				<boxGeometry />
			</ToonMesh>
		</group>
	);
}

/**
 * A limited agent's cue: an amber clock with its "back 15:10" plate (a
 * budgeted limit overlay; the words come from the act's bubble).
 */
export function LimitCue({
	at,
	showText = true,
	text,
}: {
	at: Vec3;
	showText?: boolean;
	text: string | null;
}) {
	return (
		<group position={at}>
			<AmberClock />
			{showText && text ? (
				<MeterText at={[0, 1, 0]} kind="limit">
					{text}
				</MeterText>
			) : null}
		</group>
	);
}
