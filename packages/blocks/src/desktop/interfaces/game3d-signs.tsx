/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import {
	askAriaLabel,
	type InterfaceAct,
	type InterfaceAsk,
} from "@ryuhq/protocol/interfaces";
import { Mail, Package, ScrollText, StickyNote } from "lucide-react";
import { type ReactNode, useRef } from "react";
import type { Mesh } from "three";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import type { OffStage } from "./game3d-acts.ts";
import { ACT_ART } from "./game3d-acts-palette.ts";
import type { LifeItem } from "./game3d-life.ts";
import { ItemShape } from "./game3d-life.tsx";
import { ToonMesh } from "./game3d-materials.tsx";
import { MeterText, queuePlateText, WaitTimer3D } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";

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

/** What an opener plate is, for the browser checks. */
export type ActTargetKind =
	| "alarm"
	| "notice"
	| "suggestion"
	| "tally"
	| "tray"
	| "unread";

/** The DOM half of every act plate (pure DOM, testable without WebGL). */
export function ActPlateButton({
	budgeted,
	children,
	className,
	focusable,
	icon,
	iconOnly = false,
	kind,
	label,
	onActivate,
	tally,
	youSpot,
}: {
	/** A budgeted status overlay too (a tally): `data-budgeted-overlay`. */
	budgeted?: string;
	children?: ReactNode;
	className?: string;
	focusable: boolean;
	icon?: ReactNode;
	iconOnly?: boolean;
	kind: ActTargetKind;
	label: string;
	onActivate: () => void;
	/** A tally's scope (`data-tally`): the you-spot or the off-stage agents. */
	tally?: "off" | "you";
	/** Marks you-spot overlays (queue plates, tally, tray) for overlap checks. */
	youSpot?: "slot" | "tally" | "tray";
}) {
	return (
		<button
			aria-hidden={focusable ? undefined : true}
			aria-label={label}
			className={cn(
				GAME_PLATE,
				GAME_FOCUS,
				"gk-display flex h-7 min-w-7 cursor-pointer select-none items-center justify-center gap-1 whitespace-nowrap rounded-full text-[12px] leading-none [&_svg]:size-3.5 [&_svg]:shrink-0",
				iconOnly ? "px-1" : "px-2",
				className
			)}
			data-act-target={kind}
			data-budgeted-overlay={budgeted}
			data-icon-only={iconOnly ? "" : undefined}
			data-iso-plate={focusable ? undefined : ""}
			data-iso-target={focusable ? "" : undefined}
			data-tally={tally}
			data-you-spot={youSpot}
			onClick={(event) => {
				event.stopPropagation();
				onActivate();
			}}
			tabIndex={focusable ? 0 : -1}
			type="button"
		>
			{icon}
			{iconOnly ? null : children}
		</button>
	);
}

/** In front of every other act plate (a station's focus alarm). */
const FRONT_Z: [number, number] = [45, 36];

/** Space between stacked plate rows (px). */
export const PLATE_ROW_GAP = 4;

/**
 * An act plate billboarded at `at` in the scene; `front` keeps it on top.
 * `side` hangs it from `at`: "center" (default) centred on it, "right" with
 * its left edge on it, "left" with its right edge on it (beside a figure,
 * never over it). `row` lifts it that many plate heights (plus
 * PLATE_ROW_GAP) up the screen, whatever the camera's zoom; a negative row
 * drops it.
 */
export function ActPlate({
	at,
	front = false,
	row = 0,
	side = "center",
	...props
}: Parameters<typeof ActPlateButton>[0] & {
	at: Vec3;
	front?: boolean;
	row?: number;
	side?: "center" | "left" | "right";
}) {
	const lift = `${row} * (100% + ${PLATE_ROW_GAP}px)`;
	const button = <ActPlateButton {...props} />;
	let transform = `translateY(calc(0px - ${lift}))`;
	if (side === "right") {
		transform = `translate(0, calc(-50% - ${lift}))`;
	} else if (side === "left") {
		transform = `translate(-100%, calc(-50% - ${lift}))`;
	}
	return (
		<group position={at}>
			<Html center={side === "center"} zIndexRange={front ? FRONT_Z : [35, 0]}>
				{side === "center" && row === 0 ? (
					button
				) : (
					<div style={{ transform }}>{button}</div>
				)}
			</Html>
		</group>
	);
}

/** An opener's accessible name: its first ask, "and N more" for the rest. */
export function openerLabel(
	asks: readonly InterfaceAsk[],
	ownerName: string | null,
	nowMs: number,
	privacy: "full" | "redacted" = "full"
): string {
	const first = asks[0];
	if (!first) {
		return "";
	}
	const label = askAriaLabel(first, ownerName, nowMs, privacy);
	return asks.length > 1 ? `${label} and ${asks.length - 1} more` : label;
}

/** A small post: the base of notices and signs. */
function Post({ color, height }: { color: string; height: number }) {
	return (
		<ToonMesh
			color={color}
			ink={0.012}
			position={[0, height / 2, 0]}
			scale={[0.06, height, 0.06]}
		>
			<boxGeometry />
		</ToonMesh>
	);
}

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

/**
 * A soft glow under an item: steady (`steady`, and always under reduced
 * motion) or gently pulsing.
 */
function Glow({
	reducedMotion,
	steady = false,
	y = 0.05,
}: {
	reducedMotion: boolean;
	steady?: boolean;
	y?: number;
}) {
	const ref = useRef<Mesh>(null);
	useFrame(({ clock }) => {
		if (ref.current && !(reducedMotion || steady)) {
			const pulse = 1 + Math.sin(clock.elapsedTime * 3) * 0.12;
			ref.current.scale.set(pulse, pulse, 1);
		}
	});
	return (
		<mesh position={[0, y, 0]} ref={ref} rotation={[-Math.PI / 2, 0, 0]}>
			<circleGeometry args={[0.32, 24]} />
			<meshBasicMaterial
				color={ACT_ART.glow}
				opacity={0.55}
				toneMapped={false}
				transparent
			/>
		</mesh>
	);
}

/**
 * Unread answers at a station (an idle or working agent with unread
 * replies, or a reply too old to walk): a sealed envelope that glows. Its
 * plate counts them and opens the newest reply's ask card.
 */
export function UnreadMark({
	asks,
	at,
	focusable,
	iconOnly,
	nowMs,
	onOpen,
	ownerName,
	privacy = "full",
	reducedMotion,
}: {
	/** The unread reply asks, newest first. */
	asks: readonly InterfaceAsk[];
	at: Vec3;
	focusable: boolean;
	iconOnly?: boolean;
	nowMs: number;
	onOpen: (askId: string) => void;
	ownerName: string | null;
	privacy?: "full" | "redacted";
	reducedMotion: boolean;
}) {
	const first = asks[0];
	if (!first) {
		return null;
	}
	return (
		<group position={at}>
			<Glow reducedMotion={reducedMotion} steady />
			<ToonMesh
				color={ACT_ART.envelope}
				ink={0.012}
				position={[0, 0.12, 0]}
				rotation={[-0.4, 0, 0]}
				scale={[0.3, 0.2, 0.03]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={ACT_ART.sealRed}
				position={[0, 0.13, 0.03]}
				rotation={[Math.PI / 2 - 0.4, 0, 0]}
				scale={[0.04, 0.01, 0.04]}
			>
				<cylinderGeometry args={[1, 1, 1, 10]} />
			</ToonMesh>
			<ActPlate
				at={[0, 0.55, 0]}
				focusable={focusable}
				icon={<Mail aria-hidden="true" />}
				iconOnly={iconOnly}
				kind="unread"
				label={openerLabel(asks, ownerName, nowMs, privacy)}
				onActivate={() => onOpen(first.id)}
			>
				{String(asks.length)}
			</ActPlate>
		</group>
	);
}

/**
 * A suggestion at a station (a heal fix, a skill proposal, a question for
 * when you have time): a pinned note, never walked to the you-spot and
 * never counted in "need you". Its plate opens the first suggestion.
 */
export function SuggestionNote({
	asks,
	at,
	focusable,
	iconOnly,
	nowMs,
	onOpen,
	ownerName,
	privacy = "full",
	reducedMotion,
}: {
	asks: readonly InterfaceAsk[];
	at: Vec3;
	focusable: boolean;
	iconOnly?: boolean;
	nowMs: number;
	onOpen: (askId: string) => void;
	ownerName: string | null;
	privacy?: "full" | "redacted";
	reducedMotion: boolean;
}) {
	const first = asks[0];
	if (!first) {
		return null;
	}
	const question = first.kind === "question";
	return (
		<group position={at}>
			<Glow reducedMotion={reducedMotion} y={0.02} />
			<Post color={ACT_ART.post} height={0.4} />
			<ToonMesh
				color={ACT_ART.note}
				ink={0.012}
				position={[0, 0.45, 0.04]}
				rotation={[-0.1, 0, -0.08]}
				scale={[0.22, 0.22, 0.015]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={ACT_ART.notePin}
				position={[0, 0.54, 0.06]}
				scale={0.025}
			>
				<sphereGeometry args={[1, 8, 6]} />
			</ToonMesh>
			<ActPlate
				at={[0, 0.85, 0]}
				focusable={focusable}
				icon={
					question ? (
						<ScrollText aria-hidden="true" />
					) : (
						<StickyNote aria-hidden="true" />
					)
				}
				iconOnly={iconOnly}
				kind="suggestion"
				label={openerLabel(asks, ownerName, nowMs, privacy)}
				onActivate={() => onOpen(first.id)}
			>
				{String(asks.length)}
			</ActPlate>
		</group>
	);
}

/**
 * A delivered answer on the you-spot tray: the game's produce, glowing
 * until it is read, with its file count. Its plate opens the reply.
 */
export function TrayItem({
	ask,
	at,
	count,
	focusable,
	iconOnly,
	item,
	nowMs,
	onOpen,
	ownerName,
	privacy = "full",
	reducedMotion,
	showCount = true,
	tag = null,
}: {
	ask: InterfaceAsk;
	at: Vec3;
	/** Files changed, when known: the count sticker. */
	count?: number | null;
	focusable: boolean;
	iconOnly?: boolean;
	item: LifeItem;
	nowMs: number;
	onOpen: (askId: string) => void;
	ownerName: string | null;
	privacy?: "full" | "redacted";
	reducedMotion: boolean;
	/** False when the overlay budget drops the count sticker. */
	showCount?: boolean;
	/**
	 * A short tag on the item's plate (the answer's headline, `trayHeadline`);
	 * hidden on icon-only stages. Default none.
	 */
	tag?: string | null;
}) {
	return (
		<group position={at}>
			<Glow reducedMotion={reducedMotion} />
			<ToonMesh
				color={ACT_ART.tray}
				ink={0.012}
				position={[0, 0.02, 0]}
				scale={[0.5, 0.04, 0.36]}
			>
				<boxGeometry />
			</ToonMesh>
			<group position={[0, 0.16, 0]}>
				<ItemShape item={item} />
			</group>
			<ActPlate
				at={[0, 0.65, 0]}
				focusable={focusable}
				icon={<Package aria-hidden="true" />}
				iconOnly={iconOnly}
				kind="tray"
				label={askAriaLabel(ask, ownerName, nowMs, privacy)}
				onActivate={() => onOpen(ask.id)}
				youSpot="tray"
			>
				{showCount && count ? (
					<span data-budgeted-overlay="count">{String(count)}</span>
				) : null}
				{tag && !iconOnly ? <span data-tray-tag="">{tag}</span> : null}
			</ActPlate>
		</group>
	);
}
