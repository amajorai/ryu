import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { type CSSProperties, type PointerEvent, useRef } from "react";
import { ARCADE_FOCUS } from "./arcade-focus.ts";
import { useRovingStops } from "./arcade-hooks.ts";
import {
	type Machine,
	machineSummary,
	marqueeBulbs,
	marqueeFontSize,
	marqueePath,
	meterDigits,
	plural,
	sharedWith,
	spinningReels,
	threadTitle,
} from "./arcade-model.ts";
import {
	type ArcadePalette,
	bulbGlow,
	type CabinetSkin,
	cabinetSkin,
} from "./arcade-palette.ts";
import { REEL_HEIGHT, ReelDrum } from "./arcade-reels.tsx";

/**
 * One slot machine, front on: a topper slot (JACKPOT while a reply waits
 * on you, chasing while it is fresh; IN PLAY while its ticket is open), a marquee with chase lights and
 * the agent's name, three reels for its latest conversations, the credit
 * and win meters, a button deck (Collect, Spin), the payout tray with a
 * ticket for every reply waiting on you, and a pull lever on the right.
 * Sizes are fixed pixels on a 4px grid; the floor zooms the whole bank.
 */

export const CABINET_WIDTH = 200;
const MARQUEE_HEIGHT = 68;
/** Room for the name inside the bulb ring. */
const MARQUEE_ROOM = CABINET_WIDTH - 40;
const BULBS = 26;
const TRAY_TICKETS = 2;
/** Below this floor zoom a ticket drops its barcode to give the title room. */
const TICKET_BARCODE_ZOOM = 0.85;

/**
 * A text size that stays legible when the floor zooms the bank out: at
 * full size it is `px`; zoomed out it grows so it renders at no less than
 * `floor` pixels on screen.
 */
export function legibleSize(px: number, zoom: number, floor: number): number {
	if (zoom <= 0) {
		return px;
	}
	return Math.max(px, Math.ceil(floor / zoom));
}

type Lamp = "chase" | "dim" | "lit";

/**
 * A running light, as longhands only: switching it off clears every
 * property together, so no delay outlives the animation.
 */
function chaseStyle(
	on: boolean,
	name: string,
	duration: string,
	timing: string,
	delay = "0s"
): CSSProperties {
	if (!on) {
		return {};
	}
	return {
		animationDelay: delay,
		animationDuration: duration,
		animationIterationCount: "infinite",
		animationName: name,
		animationTimingFunction: timing,
	};
}

function Marquee({
	lamp,
	machine,
	mode,
	skin,
}: {
	lamp: Lamp;
	machine: Machine;
	mode: ArcadePalette["mode"];
	skin: CabinetSkin;
}) {
	const bulbs = marqueeBulbs(
		machine.marquee,
		CABINET_WIDTH,
		MARQUEE_HEIGHT,
		BULBS
	);
	const fontSize = marqueeFontSize(machine.name, MARQUEE_ROOM, 22, 13);
	return (
		<div
			className="relative block"
			style={{ height: MARQUEE_HEIGHT, width: CABINET_WIDTH }}
		>
			<svg
				aria-hidden="true"
				className="absolute inset-0 overflow-visible"
				height={MARQUEE_HEIGHT}
				viewBox={`0 0 ${CABINET_WIDTH} ${MARQUEE_HEIGHT}`}
				width={CABINET_WIDTH}
			>
				<path
					d={marqueePath(machine.marquee, CABINET_WIDTH, MARQUEE_HEIGHT)}
					fill={skin.sign}
					stroke={skin.trim}
					strokeWidth={3}
				/>
				{bulbs.map((bulb, index) => (
					<circle
						cx={bulb.x}
						cy={bulb.y}
						fill={skin.bulb}
						// Bulb positions are fixed per marquee: index is the identity.
						key={`bulb-${index.toString()}`}
						opacity={lamp === "dim" ? 0.4 : 1}
						r={2.6}
						style={chaseStyle(
							lamp === "chase",
							"arcade-chase",
							"0.9s",
							"steps(1, end)",
							`${(index % 3) * 0.3}s`
						)}
					/>
				))}
			</svg>
			<h3
				className="absolute inset-x-5 bottom-3 flex h-7 items-center justify-center truncate text-center font-bold font-heading uppercase leading-none tracking-[0.08em]"
				style={{
					color: skin.signText,
					fontSize,
					textShadow:
						mode === "dark" || lamp !== "dim"
							? bulbGlow("dark", skin.signText)
							: undefined,
				}}
				title={machine.name}
			>
				<span className="truncate">{machine.name}</span>
			</h3>
		</div>
	);
}

/**
 * The sign on top of the cabinet; the slot is kept empty so rows line up.
 * A jackpot stays lit and pulses brighter (never goes dark), with a bulb
 * either side of the lettering chasing in turn.
 */
function Topper({
	blink,
	label,
	palette,
}: {
	blink: boolean;
	label: string | null;
	palette: ArcadePalette;
}) {
	if (!label) {
		return <div aria-hidden="true" className="h-7" />;
	}
	const bulbs = ["left", "right"] as const;
	return (
		<div aria-hidden="true" className="flex h-7 items-start">
			<span
				className="flex h-7 items-center gap-2 rounded-t-[6px] px-2.5"
				style={{
					background: palette.ledBackground,
					boxShadow: `inset 0 0 0 1px ${palette.ledDim}`,
				}}
			>
				{bulbs.map((side, index) => (
					<span
						className={cn(
							"size-1.5 rounded-full",
							side === "right" && "order-last"
						)}
						key={side}
						style={{
							...chaseStyle(
								blink,
								"arcade-chase",
								"0.9s",
								"steps(1, end)",
								`${index * 0.45}s`
							),
							background: palette.ledLit,
							boxShadow: bulbGlow(palette.mode, palette.ledLit),
						}}
					/>
				))}
				<span
					className="font-bold font-mono text-[12px] leading-none tracking-[0.24em]"
					style={{
						...chaseStyle(blink, "arcade-glow", "1.2s", "ease-in-out"),
						color: palette.ledLit,
						textShadow: bulbGlow(palette.mode, palette.ledLit),
					}}
				>
					{label}
				</span>
			</span>
		</div>
	);
}

function Meter({
	acted = false,
	blink,
	machine,
	palette,
	zoom,
}: {
	/** The act layer is on: only the credits; no legacy WIN or TILT. */
	acted?: boolean;
	blink: boolean;
	machine: Machine;
	palette: ArcadePalette;
	zoom: number;
}) {
	const wins = machine.jackpots.length;
	const labelSize = legibleSize(11, zoom, 10);
	// Enlarged labels give up their tracking so the row still fits.
	const labelTracking = labelSize > 11 ? "0.02em" : "0.12em";
	return (
		<div
			aria-hidden="true"
			className="flex h-7 items-center justify-between rounded-[4px] px-2 font-mono tabular-nums"
			style={{ background: palette.ledBackground }}
			title={
				acted
					? `Credit: ${plural(machine.credits, "message")} in conversations ${machine.name} leads.`
					: `Credit: ${plural(machine.credits, "message")} in conversations ${machine.name} leads. Win: ${plural(wins, "reply")} waiting on you.`
			}
		>
			<span className="flex items-baseline gap-1.5">
				<span
					className="leading-none"
					style={{
						color: palette.ledLabel,
						fontSize: labelSize,
						letterSpacing: labelTracking,
					}}
				>
					CREDIT
				</span>
				<span
					className="font-semibold text-[16px] leading-none"
					style={{ color: palette.ledLit }}
				>
					{meterDigits(machine.credits)}
				</span>
			</span>
			{acted ? null : machine.tilt ? (
				<span
					className="font-bold text-[14px] leading-none tracking-[0.2em]"
					style={{
						...chaseStyle(blink, "arcade-blink", "0.9s", "steps(1, end)"),
						color: palette.ledTilt,
						textShadow: bulbGlow(palette.mode, palette.ledTilt),
					}}
				>
					TILT
				</span>
			) : (
				<span className="flex items-baseline gap-1.5">
					<span
						className="leading-none"
						style={{
							color: palette.ledLabel,
							fontSize: labelSize,
							letterSpacing: labelTracking,
						}}
					>
						WIN
					</span>
					<span
						className="font-semibold text-[16px] leading-none"
						// No win reads as an unlit meter, still legible: label colour.
						style={{ color: wins > 0 ? palette.ledLit : palette.ledLabel }}
					>
						{meterDigits(wins, 2)}
					</span>
				</span>
			)}
		</div>
	);
}

/** A few coins lying on the tray's ledge. */
function Coins({ palette }: { palette: ArcadePalette }) {
	const coins = [6, 15, 24];
	return (
		<svg
			aria-hidden="true"
			className="shrink-0"
			height={10}
			viewBox="0 0 32 10"
			width={32}
		>
			{coins.map((cx) => (
				<g key={cx}>
					<ellipse cx={cx} cy={5.5} fill={palette.coinEdge} rx={5.5} ry={3} />
					<ellipse
						cx={cx}
						cy={4.5}
						fill={palette.coin}
						rx={5.5}
						ry={3}
						stroke={palette.coinEdge}
						strokeWidth={0.75}
					/>
				</g>
			))}
		</svg>
	);
}

function Ticket({
	active,
	id,
	onOpen,
	palette,
	shared,
	tall,
	title,
	zoom,
}: {
	active: boolean;
	id: string;
	onOpen: () => void;
	palette: ArcadePalette;
	/** Other agents on this conversation (it has a ticket in their trays too). */
	shared: string[];
	/** The only ticket in the tray: room for two lines of title. */
	tall: boolean;
	title: string;
	zoom: number;
}) {
	const barcode = zoom >= TICKET_BARCODE_ZOOM;
	const withOthers =
		shared.length > 0 ? `${title}, with ${shared.join(", ")}` : title;
	return (
		<button
			aria-current={active ? "true" : undefined}
			aria-label={`Cash ticket: open ${withOthers}`}
			className={cn(
				"flex w-full items-center gap-2 rounded-[2px] pr-2 text-left transition-transform duration-100 hover:-translate-y-px",
				barcode ? "pl-1.5" : "pl-2",
				tall ? "h-12" : "h-[22px]",
				ARCADE_FOCUS
			)}
			data-arcade-stop={`ticket-${id}`}
			data-arcade-ticket={active ? "open" : undefined}
			onClick={onOpen}
			style={{
				background: palette.ticket,
				// The ticket being redeemed is lit along its edge, like its reel.
				boxShadow: active ? `inset 0 0 0 2px ${palette.selected}` : undefined,
				color: palette.ticketInk,
			}}
			title={withOthers}
			type="button"
		>
			{barcode ? (
				<span
					aria-hidden="true"
					className={cn("w-3 shrink-0", tall ? "h-8" : "h-3")}
					style={{ background: palette.ticketStripes }}
				/>
			) : null}
			<span
				className={cn(
					"min-w-0 flex-1 font-medium",
					tall ? "line-clamp-2" : "truncate"
				)}
				style={{
					fontSize: legibleSize(12, zoom, 11),
					lineHeight: tall ? 1.3 : 1.2,
				}}
			>
				{title}
			</span>
		</button>
	);
}

function Tray({
	activeThreadId,
	agents,
	machine,
	onOpen,
	palette,
	zoom,
}: {
	activeThreadId: string | null;
	agents: readonly InterfaceAgent[];
	machine: Machine;
	onOpen: (threadId: string) => void;
	palette: ArcadePalette;
	zoom: number;
}) {
	const shown = machine.jackpots.slice(0, TRAY_TICKETS);
	const extra = machine.jackpots.length - shown.length;
	const style = {
		background: palette.tray,
		boxShadow: `inset 0 4px 8px ${palette.floorShadow}`,
	};
	if (shown.length === 0) {
		return (
			<div
				className="flex h-[72px] items-center justify-center rounded-[6px]"
				style={style}
			>
				<span
					aria-hidden="true"
					className="font-bold font-mono text-[11px] tracking-[0.32em]"
					style={{ color: palette.trayText }}
				>
					PAYOUT
				</span>
			</div>
		);
	}
	return (
		<div
			className="flex h-[72px] flex-col gap-1 rounded-[6px] px-2 pt-2"
			style={style}
		>
			<ul
				aria-label={`Payout tray: ${plural(machine.jackpots.length, "reply")} waiting on you`}
				className="flex h-12 flex-col justify-start gap-1"
			>
				{shown.map((thread) => (
					<li key={thread.id}>
						<Ticket
							active={thread.id === activeThreadId}
							id={thread.id}
							onOpen={() => onOpen(thread.id)}
							palette={palette}
							shared={sharedWith(thread, machine, agents)}
							tall={shown.length === 1}
							title={threadTitle(thread)}
							zoom={zoom}
						/>
					</li>
				))}
			</ul>
			<span aria-hidden="true" className="flex h-3 items-center gap-1.5">
				<Coins palette={palette} />
				{extra > 0 ? (
					<span
						className="font-bold font-mono text-[11px] leading-3"
						style={{ color: palette.coin }}
					>
						+{extra}
					</span>
				) : null}
			</span>
		</div>
	);
}

/** The arrowheads either side of the reel window that mark the pay line. */
function PaylineMarker({
	palette,
	side,
}: {
	palette: ArcadePalette;
	side: "left" | "right";
}) {
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute"
			height={10}
			style={{
				[side]: 0,
				top: 6 + REEL_HEIGHT / 2 - 5,
			}}
			viewBox="0 0 6 10"
			width={6}
		>
			<path
				d={side === "left" ? "M0 0L6 5L0 10Z" : "M6 0L0 5L6 10Z"}
				fill={palette.leverKnob}
			/>
		</svg>
	);
}

const PULL_TRAVEL = 72;

/**
 * The pull handle. Drag the knob down past half way, click it, or press
 * Enter or Space while it has focus: each pulls the lever. The play slip
 * opens on the pull itself; the handle's swing runs alongside it.
 */
function Lever({
	describedBy,
	machine,
	onPull,
	palette,
	reduced,
}: {
	describedBy?: string;
	machine: Machine;
	onPull: () => void;
	palette: ArcadePalette;
	reduced: boolean;
}) {
	const progress = useMotionValue(0);
	const rodScale = useTransform(progress, [0, 1], [1, -0.55]);
	const knobY = useTransform(progress, [0, 1], [0, PULL_TRAVEL]);
	const drag = useRef<{
		moved: boolean;
		pulled: number;
		startY: number;
	} | null>(null);
	const skipClick = useRef(false);

	const release = (fire: boolean) => {
		if (fire) {
			onPull();
		}
		if (reduced) {
			progress.set(0);
			return;
		}
		if (!fire) {
			animate(progress, 0, { damping: 18, stiffness: 420, type: "spring" });
			return;
		}
		animate(progress, 1, { duration: 0.14, ease: "easeIn" }).then(() => {
			animate(progress, 0, { damping: 11, stiffness: 300, type: "spring" });
		});
	};

	const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0) {
			return;
		}
		event.currentTarget.setPointerCapture?.(event.pointerId);
		drag.current = { moved: false, pulled: 0, startY: event.clientY };
	};
	const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
		const current = drag.current;
		if (!current) {
			return;
		}
		const delta = event.clientY - current.startY;
		if (Math.abs(delta) > 4) {
			current.moved = true;
		}
		if (!current.moved) {
			return;
		}
		current.pulled = Math.min(1, Math.max(0, delta / PULL_TRAVEL));
		if (!reduced) {
			progress.set(current.pulled);
		}
	};
	const onPointerUp = () => {
		const current = drag.current;
		drag.current = null;
		if (!current?.moved) {
			return;
		}
		skipClick.current = true;
		release(current.pulled > 0.5);
	};
	const onClick = () => {
		if (skipClick.current) {
			skipClick.current = false;
			return;
		}
		release(true);
	};

	return (
		<button
			aria-describedby={describedBy}
			aria-label={`Pull lever: message ${machine.name}`}
			className={cn(
				"group/lever absolute top-[20px] -right-[26px] flex h-[124px] w-7 cursor-grab touch-none select-none flex-col items-center rounded-[4px] active:cursor-grabbing",
				ARCADE_FOCUS
			)}
			data-arcade-stop="lever"
			onClick={onClick}
			onPointerCancel={onPointerUp}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			title="Pull to message"
			type="button"
		>
			<span aria-hidden="true" className="relative mt-[2px] h-[86px] w-full">
				<motion.span
					className="absolute bottom-0 left-1/2 h-[72px] w-[5px] -translate-x-1/2 rounded-full"
					style={{
						background: palette.lever,
						originY: 1,
						scaleY: rodScale,
					}}
				/>
				<motion.span
					className="absolute top-0 left-1/2 block size-5 -translate-x-1/2 rounded-full transition-[filter] duration-150 group-hover/lever:brightness-110"
					style={{
						background: palette.leverKnob,
						boxShadow: `inset -2px -3px 0 ${palette.floorShadow}`,
						y: knobY,
					}}
				/>
			</span>
			<span
				aria-hidden="true"
				className="relative -mt-2 ml-[2px] h-11 w-[22px] self-start rounded-r-[6px]"
				style={{
					background: palette.metal,
					boxShadow: `inset -2px -2px 0 ${palette.metalShade}`,
				}}
			>
				<span
					className="absolute top-1 left-[6px] size-3 rounded-full"
					style={{
						background: palette.lever,
						boxShadow: `inset 0 0 0 2px ${palette.metalShade}`,
					}}
				/>
			</span>
		</button>
	);
}

/** Lit (gold), plain (the cabinet's shade), or off: an unlit lamp. */
function deckStyle(
	lit: boolean,
	disabled: boolean,
	palette: ArcadePalette,
	skin: CabinetSkin
): CSSProperties {
	if (disabled) {
		return {
			background: palette.ledBackground,
			borderBottomColor: palette.floorShadow,
			// An unlit lamp, but its legend still reads (about 4.5:1).
			color: palette.ledLabel,
		};
	}
	return {
		background: lit ? palette.ledLit : skin.shade,
		borderBottomColor: lit ? palette.coinEdge : palette.floorShadow,
		color: lit ? palette.ledBackground : skin.bulb,
	};
}

function DeckButton({
	children,
	describedBy,
	disabled,
	label,
	lit,
	onClick,
	palette,
	skin,
	stop,
	wide,
	zoom,
}: {
	children: string;
	/** The id of the agent's act sentence. */
	describedBy?: string;
	disabled?: boolean;
	label: string;
	lit: boolean;
	onClick: () => void;
	palette: ArcadePalette;
	skin: CabinetSkin;
	/** Its key in the machine's roving tab order. */
	stop: string;
	wide?: boolean;
	zoom: number;
}) {
	return (
		<button
			aria-describedby={describedBy}
			aria-label={label}
			className={cn(
				"h-7 rounded-[4px] border-b-2 font-bold font-mono tracking-[0.16em] transition-[filter,transform] duration-100 enabled:active:translate-y-px enabled:hover:brightness-110 disabled:cursor-default",
				ARCADE_FOCUS,
				wide ? "flex-1" : "w-[80px]"
			)}
			data-arcade-stop={stop}
			disabled={disabled}
			onClick={onClick}
			style={{
				...deckStyle(lit, Boolean(disabled), palette, skin),
				fontSize: legibleSize(11, zoom, 10),
			}}
			type="button"
		>
			{children}
		</button>
	);
}

export function SlotCabinet({
	actLabel,
	active,
	activeThreadId,
	agents,
	blurId,
	composing,
	describedBy,
	feedback,
	machine,
	onCompose,
	onOpen,
	palette,
	reduced,
	zoom,
}: {
	/**
	 * The player's act sentence: with it the cabinet is named by the act and
	 * drops its legacy counters (the JACKPOT topper, Collect and the payout
	 * tickets), which count thread statuses the act layer replaces.
	 */
	actLabel?: string;
	/** This machine's ticket is open at the counter. */
	active: boolean;
	activeThreadId: string | null;
	/** Every agent, to name the others on a shared ticket. */
	agents: readonly InterfaceAgent[];
	blurId: string;
	/** The play slip is open for this machine. */
	composing: boolean;
	/** The id of the agent's act sentence (the act layer's row description). */
	describedBy?: string;
	/** A message just went in: every reel spins, then settles left to right. */
	feedback: boolean;
	machine: Machine;
	onCompose: () => void;
	onOpen: (threadId: string) => void;
	palette: ArcadePalette;
	reduced: boolean;
	/** The floor's zoom, so small print stays legible when the bank shrinks. */
	zoom: number;
}) {
	const articleRef = useRef<HTMLElement>(null);
	const roving = useRovingStops(articleRef, "lever");
	const skin = cabinetSkin(palette.mode, machine.skin);
	const acted = actLabel !== undefined;
	const newest = acted ? undefined : machine.jackpots[0];
	const inPlay = active || composing;
	const spins = spinningReels(machine, feedback);
	const spinning = spins.includes(true);
	const won = !acted && machine.jackpots.length > 0;
	// One moving signal per cabinet: spinning reels win over a chase.
	const calm = reduced || spinning;
	const chasing = machine.hot && !calm && !inPlay;
	let lamp: Lamp = "dim";
	if (chasing) {
		lamp = "chase";
	} else if (inPlay || won) {
		lamp = "lit";
	}
	let topper: string | null = null;
	if (inPlay) {
		topper = "IN PLAY";
	} else if (won) {
		topper = "JACKPOT";
	}
	return (
		<article
			aria-label={actLabel ?? machineSummary(machine)}
			className="relative flex flex-col items-center"
			data-active={inPlay ? "" : undefined}
			data-arcade-machine={machine.id}
			data-composing={composing ? "" : undefined}
			data-hot={machine.hot ? "" : undefined}
			data-jackpot={won ? "" : undefined}
			data-spinning={spinning ? "" : undefined}
			data-tilt={machine.tilt ? "" : undefined}
			onFocus={roving.onFocus}
			onKeyDown={roving.onKeyDown}
			ref={articleRef}
			style={{ width: CABINET_WIDTH }}
		>
			<Topper blink={chasing} label={topper} palette={palette} />
			<Marquee lamp={lamp} machine={machine} mode={palette.mode} skin={skin} />
			<div
				className="relative flex w-full flex-col gap-2 p-3"
				style={{
					background: skin.body,
					borderLeft: `6px solid ${skin.shade}`,
					borderRight: `6px solid ${skin.shade}`,
					borderTop: `3px solid ${skin.trim}`,
				}}
			>
				<div
					className="relative flex items-center justify-between rounded-[6px] p-1.5"
					style={{
						background: skin.trim,
						boxShadow: `inset 0 2px 6px ${palette.floorShadow}`,
					}}
				>
					{machine.reels.map((reel, index) => (
						<ReelDrum
							acted={acted}
							active={reel.thread !== null && reel.thread.id === activeThreadId}
							blurId={blurId}
							describedBy={describedBy}
							index={index}
							// Reels are positional: left, centre, right.
							key={`reel-${index.toString()}`}
							onOpen={onOpen}
							palette={palette}
							reduced={reduced}
							reel={reel}
							spinning={spins[index] ?? false}
						/>
					))}
					<PaylineMarker palette={palette} side="left" />
					<PaylineMarker palette={palette} side="right" />
				</div>
				<Meter
					acted={acted}
					blink={!calm}
					machine={machine}
					palette={palette}
					zoom={zoom}
				/>
				<div className="flex items-center gap-2">
					{acted ? null : (
						<DeckButton
							disabled={!newest}
							label={
								newest
									? `Collect: open ${threadTitle(newest)}`
									: "Collect: no replies waiting"
							}
							lit={Boolean(newest)}
							onClick={() => {
								if (newest) {
									onOpen(newest.id);
								}
							}}
							palette={palette}
							skin={skin}
							stop="collect"
							zoom={zoom}
						>
							COLLECT
						</DeckButton>
					)}
					<DeckButton
						describedBy={describedBy}
						label={`Spin: message ${machine.name}`}
						lit={false}
						onClick={onCompose}
						palette={palette}
						skin={skin}
						stop="spin"
						wide
						zoom={zoom}
					>
						SPIN
					</DeckButton>
				</div>
				<Tray
					activeThreadId={activeThreadId}
					agents={agents}
					machine={acted ? { ...machine, jackpots: [] } : machine}
					onOpen={onOpen}
					palette={palette}
					zoom={zoom}
				/>
				<Lever
					describedBy={describedBy}
					machine={machine}
					onPull={onCompose}
					palette={palette}
					reduced={reduced}
				/>
			</div>
			<div
				aria-hidden="true"
				className="h-3 w-full rounded-b-[4px]"
				style={{
					background: skin.shade,
					boxShadow: `0 10px 14px -4px ${palette.floorShadow}`,
				}}
			/>
		</article>
	);
}
