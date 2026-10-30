import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { type CSSProperties, type PointerEvent, useRef } from "react";
import { legibleSize } from "./arcade-cabinet-lamps.tsx";
import { ARCADE_FOCUS } from "./arcade-focus.ts";
import type { Machine } from "./arcade-model.ts";
import type { ArcadePalette, CabinetSkin } from "./arcade-palette.ts";
import { REEL_HEIGHT } from "./arcade-reels.tsx";

/** The arrowheads either side of the reel window that mark the pay line. */
export function PaylineMarker({
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
export function Lever({
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
	const tl = useLiteralMessages();
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
			aria-label={tl("Pull lever: message {name}", { name: machine.name })}
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
export function DeckButton({
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
