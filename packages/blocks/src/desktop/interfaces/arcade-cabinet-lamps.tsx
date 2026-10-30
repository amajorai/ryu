import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties } from "react";
import {
	type Machine,
	marqueeBulbs,
	marqueeFontSize,
	marqueePath,
} from "./arcade-model.ts";
import {
	type ArcadePalette,
	bulbGlow,
	type CabinetSkin,
} from "./arcade-palette.ts";

export const CABINET_WIDTH = 200;
const MARQUEE_HEIGHT = 68;
/** Room for the name inside the bulb ring. */
const MARQUEE_ROOM = CABINET_WIDTH - 40;
const BULBS = 26;

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

export type Lamp = "chase" | "dim" | "lit";

/**
 * A running light, as longhands only: switching it off clears every
 * property together, so no delay outlives the animation.
 */
export function chaseStyle(
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

export function Marquee({
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
export function Topper({
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
