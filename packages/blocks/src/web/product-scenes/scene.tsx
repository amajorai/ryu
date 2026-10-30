import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties, ReactNode, SVGProps } from "react";
import { Stage } from "../iso/kit/react/live.tsx";
import kit from "./scene.module.css";

/**
 * The shared frame for every homepage product scene.
 *
 * Every animated scene draws on one 296x176 canvas through `SceneCanvas`,
 * which `SceneStage` centres in the card above its label band. The canvas
 * never draws larger than its own pixel size, so every card at least that
 * wide shows the scene at one scale, and the narrower cards (the four-up
 * desktop row, two-up tablets) shrink it only slightly. Labels are 11 units,
 * so they stay readable at the smallest card.
 *
 * The markup is each scene's explaining still. Motion is attached only while
 * `Stage` marks the card in view and the visitor allows motion, so the server
 * frame, the offscreen frame and the reduced-motion frame are the same frame.
 * Each scene's keyframes start and end on that still.
 */

export const SCENE_WIDTH = 296;
export const SCENE_HEIGHT = 176;

/** Inline custom properties (`--dx`, `--delay`) for the motion classes. */
export type MotionStyle = CSSProperties & Record<`--${string}`, string>;

export interface Point {
	readonly x: number;
	readonly y: number;
}

const join = (...names: (string | false | undefined)[]) =>
	names.filter(Boolean).join(" ");

/**
 * The homepage card backdrop every product scene draws inside. It is
 * decorative (`aria-hidden`); the card's own label and link carry the meaning.
 */
export function Scene({ children, id }: { children: ReactNode; id: string }) {
	return (
		<div
			aria-hidden="true"
			className="relative h-full w-full overflow-hidden bg-muted/65 text-foreground"
			data-testid={`realm-visual-${id}`}
		>
			{children}
		</div>
	);
}

type SceneSvgAttributes = Omit<
	SVGProps<SVGSVGElement>,
	"children" | "className" | "preserveAspectRatio" | "style" | "viewBox"
>;

/**
 * The one stage every animated product scene draws on. It fills the card
 * above the label band (`bottom-10`, where the card's link label sits) and
 * centres the scene on both axes at every card size. The svg keeps its
 * viewBox aspect ratio (`xMidYMid meet`) and never grows past the viewBox
 * size times `scale`, so labels stay at one size across the grid.
 *
 * `Stage` adds `data-inview` while the card is on screen, which the scene's
 * own stylesheet (passed as `className`) uses to pause motion off screen.
 */
export function SceneStage({
	children,
	className,
	scale = 1,
	svgClassName,
	viewBox,
	...svgAttributes
}: SceneSvgAttributes & {
	children: ReactNode;
	/** The scene's stylesheet class carrying its `[data-inview]` motion rules. */
	className?: string;
	/** The largest size the scene draws at, as a multiple of its viewBox. */
	scale?: number;
	svgClassName?: string;
	/** `"minX minY width height"`; also sets the scene's largest size. */
	viewBox: string;
}) {
	const [, , width = 0, height = 0] = viewBox.split(" ").map(Number);
	return (
		<Stage
			className={cn(
				"absolute inset-x-0 top-0 bottom-10 flex items-center justify-center p-4",
				className
			)}
		>
			<svg
				aria-hidden="true"
				className={cn("block h-full w-full", svgClassName)}
				focusable="false"
				preserveAspectRatio="xMidYMid meet"
				style={{ maxHeight: height * scale, maxWidth: width * scale }}
				viewBox={viewBox}
				{...svgAttributes}
			>
				{children}
			</svg>
		</Stage>
	);
}

/**
 * `Scene` plus `SceneStage` on the shared 296x176 canvas. The stage keeps a
 * narrow side gutter (`px-2`) so the four-up cards lose as little scale as
 * possible to padding.
 */
export function SceneCanvas({
	children,
	className,
	id,
}: {
	children: ReactNode;
	className: string;
	id: string;
}) {
	return (
		<Scene id={id}>
			<SceneStage
				className={join(kit.stage, className, "px-2")}
				data-scene-canvas=""
				svgClassName={kit.svg}
				viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
			>
				{children}
			</SceneStage>
		</Scene>
	);
}

/** An 11-unit mono label, centred on (x, y) unless anchored otherwise. */
export function Label({
	anchor = "middle",
	children,
	className,
	muted = false,
	x,
	y,
}: {
	anchor?: "start" | "middle" | "end";
	children: ReactNode;
	className?: string;
	muted?: boolean;
	x: number;
	y: number;
}) {
	return (
		<text
			className={join(kit.label, muted && kit.muted, className)}
			dominantBaseline="central"
			textAnchor={anchor}
			x={x}
			y={y}
		>
			{children}
		</text>
	);
}

/** A rounded hairline chip centred on (x, y) with an optional label. */
export function Chip({
	children,
	className,
	height = 20,
	label,
	labelClassName,
	width,
	x,
	y,
}: {
	children?: ReactNode;
	className?: string;
	height?: number;
	label?: string;
	labelClassName?: string;
	width: number;
	x: number;
	y: number;
}) {
	return (
		<g className={className}>
			<rect
				className={kit.frame}
				height={height}
				rx={height / 2}
				width={width}
				x={x - width / 2}
				y={y - height / 2}
			/>
			{children}
			{label ? (
				<Label className={labelClassName} x={x} y={y}>
					{label}
				</Label>
			) : null}
		</g>
	);
}

/** A straight hairline wire. */
export function Wire({
	className,
	from,
	to,
}: {
	className?: string;
	from: Point;
	to: Point;
}) {
	return (
		<line
			className={join(kit.wire, className)}
			x1={from.x}
			x2={to.x}
			y1={from.y}
			y2={to.y}
		/>
	);
}

/**
 * A packet on a straight wire. Drawn at `from` and moved by `transform` only:
 * the still parks it halfway along (or at the end with `parked`), and with
 * `loop` it travels the wire on the shared 2.4s cycle, staggered by `delay`.
 */
export function Packet({
	className,
	delay = 0,
	from,
	loop = false,
	parked = false,
	radius = 2.8,
	to,
}: {
	className?: string;
	delay?: number;
	from: Point;
	loop?: boolean;
	parked?: boolean;
	radius?: number;
	to: Point;
}) {
	const style: MotionStyle = {
		"--delay": `${delay}s`,
		"--dx": `${(to.x - from.x).toFixed(2)}px`,
		"--dy": `${(to.y - from.y).toFixed(2)}px`,
	};
	return (
		<circle
			className={join(
				kit.packet,
				parked ? kit.parked : kit.half,
				loop && kit.flow,
				className
			)}
			cx={from.x}
			cy={from.y}
			r={radius}
			style={style}
		/>
	);
}

/** The shared check mark, centred on the origin (wrap it in a translate). */
export function Check({ className }: { className?: string }) {
	return (
		<path className={join(kit.stroke, className)} d="M-3 0.2 L-1 2.2 L3 -2" />
	);
}
