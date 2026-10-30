/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import {
	askAriaLabel,
	type InterfaceAct,
	type InterfaceAsk,
} from "@ryuhq/protocol/interfaces";
import type { OffStage } from "./game3d-acts.ts";
import { ACT_ART } from "./game3d-acts-palette.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { MeterText, queuePlateText, WaitTimer3D } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { ActPlate, ActPlateButton, Post } from "./game3d-signs-plate.tsx";

export {
	SuggestionNote,
	TrayItem,
	UnreadMark,
} from "./game3d-signs-openers.tsx";
export {
	ActPlate,
	ActPlateButton,
	type ActTargetKind,
	openerLabel,
	PLATE_ROW_GAP,
} from "./game3d-signs-plate.tsx";

/**
 * The act layer's signs and openers: `NextSign` (what's next, never
 * invented), `TallyPlate` ("+3 more", a button opening the Queue sheet),
 * `NoticePost` (an unowned or parked ask pinned at a you-spot slot),
 * `UnreadMark` (unread answers at a station), `SuggestionNote` (a heal
 * fix, skill proposal or question for later) and `TrayItem` (a delivered
 * answer at the you-spot tray).
 *
 * Every opener's plate is an `ActPlateButton`: named by `askAriaLabel`
 * (plus "and N more"), opening the ask card. With `focusable` (games whose
 * in-scene props are DOM targets) it is a `data-iso-target` in the Tab and
 * arrow-key order; otherwise it is a pointer target only and the game's
 * DOM lists carry keyboard access. These plates are exempt from the
 * overlay budget; `iconOnly` collapses them on narrow stages.
 */

/** "Next: write tests" on a little chalkboard. Hidden when there is nothing. */
export function NextSign({
	at,
	color,
	showText = true,
	text,
}: {
	at: Vec3;
	color?: string;
	showText?: boolean;
	text: string | null;
}) {
	if (!text) {
		return null;
	}
	return (
		<group position={at}>
			<Post color={ACT_ART.post} height={0.5} />
			<ToonMesh
				color={color ?? ACT_ART.board}
				ink={0.014}
				position={[0, 0.55, 0]}
				scale={[0.5, 0.3, 0.04]}
			>
				<boxGeometry />
			</ToonMesh>
			{showText ? <MeterText at={[0, 0.95, 0]}>{text}</MeterText> : null}
		</group>
	);
}

const TALLY_ORDER: InterfaceAct[] = [
	"asking",
	"blocked",
	"limited",
	"working",
	"delivering",
	"waiting",
	"idle",
];

/** "+6: 1 limited, 2 working, 1 delivering, 2 idle". */
export function offStageText(offStage: OffStage): string {
	const parts = TALLY_ORDER.flatMap((act) => {
		const count = offStage.byAct[act] ?? 0;
		return count > 0 ? [`${count} ${act}`] : [];
	});
	return parts.length > 0
		? `+${offStage.count}: ${parts.join(", ")}`
		: `+${offStage.count}`;
}

/** "6 more agents. Open the queue". */
export function offStageLabel(count: number): string {
	return `${count} more ${count === 1 ? "agent" : "agents"}. Open the queue`;
}

/** "+3 more" asks at the you-spot. */
export function overflowLabel(count: number): string {
	return `${count} more ${count === 1 ? "ask" : "asks"} waiting. Open the queue`;
}

/**
 * A tally: "+3 more" at the you-spot, or "+6: 1 limited, …" beside the
 * stations for agents off stage. A button opening the Queue sheet.
 */
export function TallyPlate({
	at,
	focusable,
	label,
	onOpen,
	scope,
	text,
}: {
	at: Vec3;
	focusable: boolean;
	label: string;
	onOpen: () => void;
	/**
	 * Which tally: "you" is the you-spot "+N more" (data-you-spot="tally"),
	 * "off" counts the agents off stage (data-tally="off"). Required.
	 */
	scope: "off" | "you";
	text: string;
}) {
	return (
		<group position={at}>
			<Html center zIndexRange={[35, 0]}>
				<span className="contents">
					<ActPlateButton
						budgeted="tally"
						focusable={focusable}
						kind="tally"
						label={label}
						onActivate={onOpen}
						tally={scope}
						youSpot={scope === "you" ? "tally" : undefined}
					>
						{text}
					</ActPlateButton>
				</span>
			</Html>
		</group>
	);
}

/** A pinned letter, its seal red when the ask has a destructive choice. */
function Letter({ ask }: { ask: InterfaceAsk }) {
	const destructive = ask.choices?.some((choice) => choice.destructive);
	return (
		<group position={[0, 0.62, 0.05]} rotation={[-0.15, 0, 0.08]}>
			<ToonMesh color={ACT_ART.letter} ink={0.012} scale={[0.3, 0.22, 0.02]}>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={destructive ? ACT_ART.sealRed : ACT_ART.sealAmber}
				position={[0, 0, 0.015]}
				rotation={[Math.PI / 2, 0, 0]}
				scale={[0.045, 0.012, 0.045]}
			>
				<cylinderGeometry args={[1, 1, 1, 12]} />
			</ToonMesh>
		</group>
	);
}

/**
 * An ask waiting at a you-spot slot with no villager: a workflow gate
 * (no owner, "Inbox asks: …") or an agent's parked ask while it works. A
 * letter on a post with an hourglass; its queue plate reads "Inbox · 20m"
 * and opens the ask card.
 */
export function NoticePost({
	ask,
	at,
	focusable,
	nowMs,
	onOpen,
	ownerName,
	privacy = "full",
	reducedMotion,
}: {
	ask: InterfaceAsk;
	at: Vec3;
	focusable: boolean;
	nowMs: number;
	onOpen: (askId: string) => void;
	/** The owning agent's name, or null for an unowned ask. */
	ownerName: string | null;
	privacy?: "full" | "redacted";
	reducedMotion: boolean;
}) {
	const timer = {
		approx: ask.sinceApprox,
		since: ask.since,
		until: ask.expiresAt ?? null,
		untilApprox: ask.expiresApprox,
	};
	return (
		<group position={at}>
			<Post color={ACT_ART.post} height={0.62} />
			<Letter ask={ask} />
			<WaitTimer3D
				at={[0.3, 0, 0.1]}
				nowMs={nowMs}
				reducedMotion={reducedMotion}
				timer={timer}
			/>
			<ActPlate
				at={[0, 1.1, 0]}
				focusable={focusable}
				kind="notice"
				label={askAriaLabel(ask, ownerName, nowMs, privacy)}
				onActivate={() => onOpen(ask.id)}
				youSpot="slot"
			>
				{queuePlateText(ownerName ?? "Inbox", timer, nowMs)}
			</ActPlate>
		</group>
	);
}
