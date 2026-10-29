import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import { ARCADE_FOCUS } from "./arcade-focus.ts";
import {
	type Reel,
	type ReelSymbol,
	reelLabel,
	SPIN_STRIP,
	threadTitle,
} from "./arcade-model.ts";
import type { ArcadePalette } from "./arcade-palette.ts";

/**
 * The reel glyphs and the reel drums. Glyphs are drawn on a 40-unit grid
 * so they share weight and stroke. At rest a reel shows its symbol on the
 * pay line between empty stops, shaded like a drum, so the symbol is the
 * only thing to read; a quiet conversation lands on the cherry, and only a
 * reel with no conversation shows the blank stop (a dash, smoked over). A
 * spinning reel runs the strip past the window with a vertical motion
 * blur, and lands on its symbol with a short overshoot.
 */

export const REEL_WIDTH = 48;
export const REEL_HEIGHT = 64;
const PITCH = 48;
const GLYPH = 34;

export function ReelGlyph({
	palette,
	size = GLYPH,
	symbol,
}: {
	palette: ArcadePalette;
	size?: number;
	symbol: ReelSymbol;
}) {
	const { glyph } = palette;
	return (
		<svg
			aria-hidden="true"
			className="block shrink-0"
			height={size}
			viewBox="0 0 40 40"
			width={size}
		>
			{symbol === "bell" ? (
				<g stroke={glyph.bellEdge} strokeLinejoin="round" strokeWidth={1.5}>
					<circle cx={20} cy={5.5} fill={glyph.bell} r={2.2} />
					<path
						d="M20 7.5C13.5 7.5 11.5 13 11.5 18.5C11.5 24 9.5 26.5 6.5 28.5H33.5C30.5 26.5 28.5 24 28.5 18.5C28.5 13 26.5 7.5 20 7.5Z"
						fill={glyph.bell}
					/>
					<rect fill={glyph.bell} height={4} rx={2} width={30} x={5} y={28} />
					<circle cx={20} cy={34.5} fill={glyph.bellEdge} r={2.8} />
					<path
						d="M15.5 12.5C14.2 15 14 19 13.6 22.5"
						fill="none"
						opacity={0.7}
						stroke={palette.reelFace}
						strokeLinecap="round"
						strokeWidth={2}
					/>
				</g>
			) : null}
			{symbol === "cherry" ? (
				<g>
					<path
						d="M13 23C15 15.5 20.5 10 28 7.5M27 23.5C26.5 17 27 11.5 28 7.5"
						fill="none"
						stroke={glyph.leaf}
						strokeLinecap="round"
						strokeWidth={2}
					/>
					<path
						d="M28 7.5C30.5 3.5 35.5 3.5 37.5 6.5C34 9 30.5 9.5 28 7.5Z"
						fill={glyph.leaf}
					/>
					<circle
						cx={13}
						cy={28.5}
						fill={glyph.cherry}
						r={7}
						stroke={glyph.sevenEdge}
						strokeWidth={1.25}
					/>
					<circle
						cx={27}
						cy={29.5}
						fill={glyph.cherry}
						r={7}
						stroke={glyph.sevenEdge}
						strokeWidth={1.25}
					/>
					<circle
						cx={10.5}
						cy={26}
						fill={palette.reelFace}
						opacity={0.75}
						r={1.8}
					/>
					<circle
						cx={24.5}
						cy={27}
						fill={palette.reelFace}
						opacity={0.75}
						r={1.8}
					/>
				</g>
			) : null}
			{symbol === "seven" ? (
				<path
					d="M8.5 6.5H31.5V12.5C25.5 18 22 25.5 21 34H12.5C13.5 25.5 17 19 22 13.5H8.5Z"
					fill={glyph.seven}
					stroke={glyph.sevenEdge}
					strokeLinejoin="round"
					strokeWidth={1.5}
				/>
			) : null}
			{symbol === "bar" ? (
				<g>
					<rect
						fill={glyph.bar}
						height={15}
						rx={2.5}
						width={34}
						x={3}
						y={12.5}
					/>
					<text
						fill={glyph.barText}
						fontFamily="var(--font-heading), sans-serif"
						fontSize={10}
						fontWeight={800}
						letterSpacing={1.2}
						textAnchor="middle"
						x={20.6}
						y={23.6}
					>
						BAR
					</text>
				</g>
			) : null}
			{symbol === "flame" ? (
				<g>
					<path
						d="M20 3.5C22 10.5 30.5 14 30.5 24C30.5 31 25.8 36.5 20 36.5C14.2 36.5 9.5 31 9.5 24C9.5 18.5 13 15.5 14.8 11C16.3 14 17 16 18.5 17.2C18.4 12 19 7.5 20 3.5Z"
						fill={glyph.flame}
					/>
					<path
						d="M20 18.5C21.5 22.5 25 24.5 25 28.5C25 31.8 22.8 34.3 20 34.3C17.2 34.3 15 31.8 15 28.8C15 25.8 18.5 23.3 20 18.5Z"
						fill={glyph.flameCore}
					/>
				</g>
			) : null}
			{symbol === "blank" ? (
				<rect fill={glyph.blank} height={4} rx={2} width={20} x={10} y={18} />
			) : null}
		</svg>
	);
}

/** One stop on the strip; a `filler` stop is the empty gap between symbols. */
function Cell({
	palette,
	symbol,
}: {
	palette: ArcadePalette;
	symbol: ReelSymbol | "filler";
}) {
	return (
		<div
			className="flex shrink-0 items-center justify-center"
			style={{ height: PITCH, width: REEL_WIDTH }}
		>
			{symbol === "filler" ? null : (
				<ReelGlyph palette={palette} symbol={symbol} />
			)}
		</div>
	);
}

const SPIN_CYCLE = SPIN_STRIP.length * PITCH;

function SpinningStrip({
	blurId,
	index,
	palette,
}: {
	blurId: string;
	index: number;
	palette: ArcadePalette;
}) {
	return (
		<div
			className="absolute inset-x-0 top-0 flex flex-col"
			data-arcade-spin=""
			style={{
				animationDelay: `${-index * 0.13}s`,
				animationDuration: "0.42s",
				animationIterationCount: "infinite",
				animationName: "arcade-spin",
				animationTimingFunction: "linear",
				filter: `url(#${blurId})`,
			}}
		>
			{[...SPIN_STRIP, ...SPIN_STRIP].map((symbol, position) => (
				<Cell
					// The strip is a fixed repeat: position is the identity.
					key={`${symbol}-${position.toString()}`}
					palette={palette}
					symbol={symbol}
				/>
			))}
		</div>
	);
}

function RestingStrip({
	index,
	palette,
	reduced,
	symbol,
}: {
	index: number;
	palette: ArcadePalette;
	reduced: boolean;
	symbol: ReelSymbol;
}) {
	const offset = (REEL_HEIGHT - PITCH) / 2 - PITCH;
	return (
		<motion.div
			animate={{ y: offset }}
			className="absolute inset-x-0 top-0 flex flex-col"
			initial={reduced ? false : { y: offset - PITCH * 1.5 }}
			transition={{
				damping: 15,
				delay: index * 0.12,
				stiffness: 320,
				type: "spring",
			}}
		>
			<Cell palette={palette} symbol="filler" />
			<Cell palette={palette} symbol={symbol} />
			<Cell palette={palette} symbol="filler" />
		</motion.div>
	);
}

/**
 * One drum. When it holds a conversation it is a button that opens it; an
 * empty reel (fewer than three conversations) is decoration.
 */
export function ReelDrum({
	acted = false,
	active,
	blurId,
	describedBy,
	index,
	onOpen,
	palette,
	reduced,
	reel,
	spinning,
}: {
	/**
	 * The act layer is on: the reel shows no thread-status symbol and is
	 * named by its conversation alone (the act says what the agent is doing).
	 */
	acted?: boolean;
	active: boolean;
	blurId: string;
	/** The id of the agent's act sentence. */
	describedBy?: string;
	index: number;
	onOpen: (threadId: string) => void;
	palette: ArcadePalette;
	reduced: boolean;
	reel: Reel;
	spinning: boolean;
}) {
	const tl = useLiteralMessages();
	const showSpin = spinning && !reduced;
	const face = (
		<>
			{showSpin ? (
				<SpinningStrip blurId={blurId} index={index} palette={palette} />
			) : (
				<RestingStrip
					// Remount on settle so the reel lands again on its new symbol.
					index={index}
					key={reel.symbol}
					palette={palette}
					reduced={reduced}
					symbol={acted ? "blank" : reel.symbol}
				/>
			)}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0"
				style={{ background: palette.reelShade }}
			/>
		</>
	);
	const style = {
		background: palette.reelFace,
		height: REEL_HEIGHT,
		width: REEL_WIDTH,
	};
	const { thread } = reel;
	if (!thread) {
		// No conversation: the reel window is smoked over, a stop with nothing on it.
		return (
			<div
				aria-hidden="true"
				className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
				data-arcade-reel="empty"
				style={style}
			>
				<span className="opacity-60">
					<ReelGlyph palette={palette} symbol="blank" />
				</span>
				<span
					className="pointer-events-none absolute inset-0"
					style={{ background: palette.reelCover }}
				/>
			</div>
		);
	}
	return (
		<button
			aria-current={active ? "true" : undefined}
			aria-describedby={describedBy}
			aria-label={tl("Open {reelName}", {
				reelName: acted ? threadTitle(thread) : reelLabel(reel),
			})}
			className={cn(
				"relative shrink-0 overflow-hidden rounded-[3px] transition-[filter] duration-150 hover:brightness-105 focus-visible:z-10",
				ARCADE_FOCUS
			)}
			data-arcade-reel={active ? "open" : undefined}
			data-arcade-stop={`reel-${index.toString()}`}
			onClick={() => onOpen(thread.id)}
			style={style}
			title={acted ? threadTitle(thread) : reelLabel(reel)}
			type="button"
		>
			{face}
			{active ? (
				// The open conversation's reel is lit around its window edge.
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 rounded-[3px]"
					style={{
						boxShadow: `inset 0 0 0 3px ${palette.selected}`,
					}}
				/>
			) : null}
		</button>
	);
}

/** Shared SVG defs: the vertical motion blur the spinning strips use. */
export function ReelDefs({ blurId }: { blurId: string }) {
	return (
		<svg aria-hidden="true" className="absolute size-0" focusable="false">
			<defs>
				<filter height="140%" id={blurId} width="100%" x="0%" y="-20%">
					<feGaussianBlur stdDeviation="0 3.2" />
				</filter>
			</defs>
		</svg>
	);
}

/** Keyframes for the floor (no colours: those come from the palette). */
export const ARCADE_KEYFRAMES = `
@keyframes arcade-spin { from { transform: translateY(0); } to { transform: translateY(-${SPIN_CYCLE}px); } }
@keyframes arcade-chase { 0%, 30% { opacity: 1; } 36%, 100% { opacity: 0.22; } }
@keyframes arcade-blink { 0%, 55% { opacity: 1; } 60%, 100% { opacity: 0.5; } }
@keyframes arcade-glow { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.45); } }
@keyframes arcade-power { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
@keyframes arcade-attract { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
[data-arcade-paused="true"] * { animation-play-state: paused !important; }
@media (prefers-reduced-motion: reduce) { [data-arcade-floor] * { animation: none !important; } }
`;
