import {
	createContext,
	type ReactNode,
	type SVGProps,
	useContext,
	useId,
	useLayoutEffect,
	useRef,
} from "react";
import {
	latestLine,
	MARKING_LABELS,
	type PassportStamp,
	recordSerial,
	type StampBorder,
	type StampMarking,
	type StampShape,
	type StampStyle,
	stampDate,
} from "./passport-model.ts";
import { chromeInk, DENIED_INK, stampInk } from "./passport-palette.ts";
import { ellipsize, monoWidth, stampTextRows } from "./passport-stamp-text.ts";

/**
 * Stamp art. Every stamp is one SVG in a 168 × 140 box: the country's shape
 * and border in its ink, then the entry lines inside. A shared filter roughens
 * the edges and breaks the ink up, so it reads as rubber on paper.
 */

export const STAMP_WIDTH = 168;
export const STAMP_HEIGHT = 140;
const CX = STAMP_WIDTH / 2;
const CY = STAMP_HEIGHT / 2;

const ArtContext = createContext("pp");

/** Ids for the shared SVG defs, unique per mounted booklet. */
export function usePassportArtId(): string {
	return useContext(ArtContext);
}

export function grainFilter(prefix: string, grain: number): string {
	return `url(#${prefix}-grain-${grain % 3})`;
}

/**
 * A lighter grain for every letter on a stamp: the ink still breaks up a
 * little (at most about 15%), but no glyph loses a stroke.
 */
function softFilter(prefix: string): string {
	return `url(#${prefix}-soft)`;
}

/**
 * One hidden SVG that holds the ink filters and the guilloche pattern, plus
 * the context that lets every stamp and page point at them.
 */
export function PassportArtProvider({ children }: { children: ReactNode }) {
	const prefix = `pp${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	return (
		<ArtContext.Provider value={prefix}>
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute size-0 overflow-hidden"
				focusable="false"
			>
				<defs>
					{[0, 1, 2].map((seed) => (
						<filter
							height="130%"
							id={`${prefix}-grain-${seed}`}
							key={seed}
							width="130%"
							x="-15%"
							y="-15%"
						>
							<feTurbulence
								baseFrequency="0.045"
								numOctaves={2}
								result="warp"
								seed={seed * 7 + 3}
								type="fractalNoise"
							/>
							<feDisplacementMap
								in="SourceGraphic"
								in2="warp"
								result="rough"
								scale={2.2}
								xChannelSelector="R"
								yChannelSelector="G"
							/>
							<feTurbulence
								baseFrequency="0.85"
								numOctaves={2}
								result="grain"
								seed={seed * 11 + 5}
								type="fractalNoise"
							/>
							<feColorMatrix
								in="grain"
								result="speckle"
								type="matrix"
								values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.25 0 0 0 1.5"
							/>
							<feComposite in="rough" in2="speckle" operator="in" />
						</filter>
					))}
					<filter
						height="130%"
						id={`${prefix}-soft`}
						width="130%"
						x="-15%"
						y="-15%"
					>
						<feTurbulence
							baseFrequency="0.06"
							numOctaves={1}
							result="warp"
							seed={13}
							type="fractalNoise"
						/>
						<feDisplacementMap
							in="SourceGraphic"
							in2="warp"
							result="rough"
							scale={0.6}
							xChannelSelector="R"
							yChannelSelector="G"
						/>
						<feTurbulence
							baseFrequency="0.9"
							numOctaves={1}
							result="grain"
							seed={17}
							type="fractalNoise"
						/>
						<feColorMatrix
							in="grain"
							result="speckle"
							type="matrix"
							values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -0.3 0 0 0 1.16"
						/>
						<feComposite in="rough" in2="speckle" operator="in" />
					</filter>
					<pattern
						height="18"
						id={`${prefix}-guilloche`}
						patternUnits="userSpaceOnUse"
						width="48"
					>
						<path
							d="M0 9 C 8 1, 16 1, 24 9 S 40 17, 48 9 M0 13 C 8 5, 16 5, 24 13 S 40 21, 48 13 M0 5 C 8 -3, 16 -3, 24 5 S 40 13, 48 5"
							fill="none"
							stroke="var(--pp-guilloche)"
							strokeWidth="0.6"
						/>
					</pattern>
				</defs>
			</svg>
			{children}
		</ArtContext.Provider>
	);
}

/** Outline path of a shape, inset by `inset` from the stamp's outer edge. */
function shapePath(shape: StampShape, inset: number): string {
	switch (shape) {
		case "circle": {
			const radius = 64 - inset;
			return `M ${CX - radius} ${CY} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0 Z`;
		}
		case "octagon": {
			const radius = 73 - inset * 1.08;
			const points = Array.from({ length: 8 }, (_, index) => {
				const angle = ((index * 45 + 22.5) * Math.PI) / 180;
				return `${(CX + radius * Math.cos(angle)).toFixed(2)} ${(CY + radius * Math.sin(angle)).toFixed(2)}`;
			});
			return `M ${points.join(" L ")} Z`;
		}
		case "triangle": {
			// Apex up; the inset keeps edges parallel (2 × inset at the apex).
			const top = 4 + inset * 2.1;
			const bottom = 136 - inset;
			const half = 80 - inset * 1.8;
			return `M ${CX} ${top} L ${CX + half} ${bottom} L ${CX - half} ${bottom} Z`;
		}
		default: {
			const x = 6 + inset;
			const y = 16 + inset;
			const width = STAMP_WIDTH - 12 - inset * 2;
			const height = STAMP_HEIGHT - 32 - inset * 2;
			const radius = Math.max(1, 6 - inset * 0.6);
			return `M ${x + radius} ${y} H ${x + width - radius} Q ${x + width} ${y} ${x + width} ${y + radius} V ${y + height - radius} Q ${x + width} ${y + height} ${x + width - radius} ${y + height} H ${x + radius} Q ${x} ${y + height} ${x} ${y + height - radius} V ${y + radius} Q ${x} ${y} ${x + radius} ${y} Z`;
		}
	}
}

interface StrokeSpec {
	dash?: string;
	inset: number;
	width: number;
}

/** The rings a border style draws, outermost first. */
function borderStrokes(
	border: StampBorder,
	marking: StampMarking | null
): StrokeSpec[] {
	if (marking === "processing") {
		return [
			{ dash: "7 4", inset: 0, width: 2 },
			{ dash: "3 3", inset: 4.5, width: 1 },
		];
	}
	const heavy = marking === "arrived";
	const outer = heavy ? 3.6 : 2;
	const inner = heavy ? 1.6 : 1;
	switch (border) {
		case "dotted":
			return [
				{ dash: "0.1 4", inset: 1, width: heavy ? 3.6 : 2.6 },
				{ inset: 5, width: inner },
			];
		case "ticked":
			return [
				{ inset: 0, width: outer },
				{ dash: "1 2.2", inset: 4, width: 3.2 },
			];
		case "solid":
			return [{ inset: 0, width: outer + 0.6 }];
		default:
			return [
				{ inset: 0, width: outer },
				{ inset: 4, width: inner },
			];
	}
}

/** Rim and band type sizes, in stamp units. */
const TYPE = {
	marking: 8.6,
	rim: 8,
} as const;

/** Shapes whose marking prints on the rim or band, not among the lines. */
function rimMarking(shape: StampShape): boolean {
	return shape !== "octagon";
}

/** The smallest a fitted line may shrink to, as a share of its set size. */
const MIN_FIT = 0.78;

/**
 * SVG text that keeps to `room`: after layout (and again once web fonts
 * load) it measures itself and, only if the real run is wider, steps the
 * type size down. Letters keep their shape; past the floor it closes up the
 * spacing rather than squeezing glyphs.
 */
function FitText({
	children,
	fontSize,
	room,
	...props
}: SVGProps<SVGTextElement> & { children: string; room: number }) {
	const ref = useRef<SVGTextElement>(null);
	const size = Number(fontSize);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element || typeof element.getComputedTextLength !== "function") {
			return;
		}
		let cancelled = false;
		const fitToRoom = () => {
			if (cancelled) {
				return;
			}
			element.removeAttribute("textLength");
			element.removeAttribute("lengthAdjust");
			element.setAttribute("font-size", String(size));
			const length = element.getComputedTextLength();
			if (length <= room || length === 0) {
				return;
			}
			const shrunk = Math.max(MIN_FIT, room / length) * size;
			element.setAttribute("font-size", shrunk.toFixed(2));
			if (element.getComputedTextLength() > room) {
				element.setAttribute("textLength", room.toFixed(1));
				element.setAttribute("lengthAdjust", "spacing");
			}
		};
		fitToRoom();
		document.fonts?.ready.then(fitToRoom).catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [room, size]);
	return (
		<text fontSize={size} ref={ref} {...props}>
			{children}
		</text>
	);
}

/** A circle's arc from `from` to `to` degrees (0 = right, 90 = bottom). */
function arcPath(radius: number, from: number, to: number): string {
	const point = (degrees: number) => {
		const radians = (degrees * Math.PI) / 180;
		return `${(CX + radius * Math.cos(radians)).toFixed(2)} ${(CY + radius * Math.sin(radians)).toFixed(2)}`;
	};
	const sweep = to > from ? 1 : 0;
	const large = Math.abs(to - from) > 180 ? 1 : 0;
	return `M ${point(from)} A ${radius} ${radius} 0 ${large} ${sweep} ${point(to)}`;
}

/** Circle rim radii: the name runs over the top, the marking under the bottom. */
const RIM_TOP = 49.5;
const RIM_BOTTOM = 57.6;
const RIM_INNER = 47;

/**
 * The rim and band text: the country across the top, and across the bottom
 * the marking (circle, rectangle, triangle) or the record number (octagon).
 * An awaiting entry prints its marking reversed out of a solid ink bar.
 */
function RimText({
	bottom,
	bottomIsMarking,
	inkFilter,
	letterFilter,
	prefix,
	reversed,
	shape,
	top,
}: {
	bottom: string;
	bottomIsMarking: boolean;
	/** The rough rubber grain, for the solid bar behind a reversed marking. */
	inkFilter: string;
	/** The light grain that keeps letters whole. */
	letterFilter: string;
	prefix: string;
	reversed: boolean;
	shape: StampShape;
	top: string;
}) {
	const pathId = `${prefix}-rim-${shape}`;
	const bottomSize = bottomIsMarking ? TYPE.marking : TYPE.rim;
	const bottomWeight = bottomIsMarking && reversed ? 800 : 700;
	const textFill = reversed ? "var(--pp-paper)" : "currentColor";
	if (shape === "circle") {
		const spacing = 0.8;
		const span =
			(monoWidth(bottom, bottomSize, spacing) / RIM_BOTTOM) * (180 / Math.PI) +
			14;
		return (
			<g className="font-mono" fontWeight={700} stroke="none">
				<defs>
					<path d={arcPath(RIM_TOP, 180, 360)} id={`${pathId}-top`} />
					<path d={arcPath(RIM_BOTTOM, 180, 0)} id={`${pathId}-bottom`} />
				</defs>
				{reversed ? (
					<path
						d={arcPath(RIM_BOTTOM - 3.3, 90 + span / 2, 90 - span / 2)}
						fill="none"
						filter={inkFilter}
						stroke="currentColor"
						strokeWidth={10.6}
					/>
				) : null}
				<g filter={letterFilter}>
					<text fontSize={TYPE.rim} letterSpacing="1.4" textAnchor="middle">
						<textPath href={`#${pathId}-top`} startOffset="50%">
							{fitMono(top, TYPE.rim, 1.4, 124)}
						</textPath>
					</text>
					<text
						fill={textFill}
						fontSize={bottomSize}
						fontWeight={bottomWeight}
						letterSpacing={spacing}
						textAnchor="middle"
					>
						<textPath href={`#${pathId}-bottom`} startOffset="50%">
							{bottom}
						</textPath>
					</text>
				</g>
			</g>
		);
	}
	const layout = RIM_LAYOUT[shape];
	const bottomSpacing = bottomIsMarking ? layout.markingSpacing : 0.2;
	const size = bottomIsMarking ? layout.markingSize : bottomSize;
	let bar: ReactNode = null;
	if (reversed && shape === "rectangle") {
		bar = <rect height={12} width={148} x={10} y={107.5} />;
	} else if (reversed && shape === "triangle") {
		// A band across the base between the rule and the inner border.
		bar = (
			<path
				d={`M ${CX - triangleEdge(TRIANGLE_RULE)} ${TRIANGLE_RULE} H ${CX + triangleEdge(TRIANGLE_RULE)} L ${CX + triangleEdge(131.5)} 131.5 H ${CX - triangleEdge(131.5)} Z`}
			/>
		);
	}
	return (
		<g className="font-mono" fontWeight={700} stroke="none" textAnchor="middle">
			{bar ? <g filter={inkFilter}>{bar}</g> : null}
			<g filter={letterFilter}>
				{layout.top === null ? null : (
					<FitText
						fontSize={TYPE.rim}
						letterSpacing={layout.topSpacing}
						room={layout.topRoom}
						x={CX}
						y={layout.top}
					>
						{fitMono(top, TYPE.rim, layout.topSpacing, layout.topRoom)}
					</FitText>
				)}
				<FitText
					fill={textFill}
					fontSize={size}
					fontWeight={bottomWeight}
					letterSpacing={bottomSpacing}
					room={layout.bottomRoom}
					x={CX}
					y={layout.bottom}
				>
					{bottom}
				</FitText>
			</g>
		</g>
	);
}

/** Baseline of the triangle's rule over its marking band. */
const TRIANGLE_RULE = 118.5;

/** Half-width of the triangle's inner border at height `y`, less a hair. */
function triangleEdge(y: number): number {
	return 72.8 * ((y - 12.4) / 119.6) - 1;
}

/** Rim and band text for the straight-edged shapes: baselines and room. */
const RIM_LAYOUT: Record<
	Exclude<StampShape, "circle">,
	{
		bottom: number;
		bottomRoom: number;
		markingSize: number;
		markingSpacing: number;
		top: number | null;
		topRoom: number;
		topSpacing: number;
	}
> = {
	octagon: {
		bottom: 124.5,
		bottomRoom: 70,
		markingSize: TYPE.marking,
		markingSpacing: 0.2,
		top: 23.5,
		topRoom: 70,
		topSpacing: 0.8,
	},
	rectangle: {
		bottom: 116.6,
		bottomRoom: 140,
		markingSize: TYPE.marking,
		markingSpacing: 0.3,
		top: 30.5,
		topRoom: 140,
		topSpacing: 1.4,
	},
	triangle: {
		bottom: 128.2,
		bottomRoom: 2 * (triangleEdge(122.6) - 4),
		markingSize: 7.8,
		markingSpacing: 0.2,
		top: null,
		topRoom: 0,
		topSpacing: 0,
	},
};

/** Cut a rim line (a long agent name) so it fits with an ellipsis. */
function fitMono(
	text: string,
	size: number,
	spacing: number,
	room: number
): string {
	return ellipsize(text, room, (value) => monoWidth(value, size, spacing));
}

function ShapeStrokes({
	border,
	marking,
	shape,
}: {
	border: StampBorder;
	marking: StampMarking | null;
	shape: StampShape;
}) {
	const strokes = borderStrokes(border, marking);
	return (
		<g fill="none" strokeLinecap="round" strokeLinejoin="round">
			{strokes.map((stroke) => (
				<path
					d={shapePath(shape, stroke.inset)}
					key={`${stroke.inset}-${stroke.width}`}
					strokeDasharray={stroke.dash}
					strokeWidth={stroke.width}
				/>
			))}
			{shape === "circle" ? (
				<path d={shapePath(shape, 64 - RIM_INNER)} strokeWidth={0.9} />
			) : null}
			{shape === "rectangle" ? (
				<path d="M 12 36 H 156 M 12 106 H 156" strokeWidth={0.9} />
			) : null}
			{shape === "triangle" ? (
				<path
					d={`M ${CX - triangleEdge(TRIANGLE_RULE)} ${TRIANGLE_RULE} H ${CX + triangleEdge(TRIANGLE_RULE)}`}
					strokeWidth={0.9}
				/>
			) : null}
		</g>
	);
}

/** Where the refusal overprint lands: over the marking's place, clear of the entry lines. */
const DENIED_AT: Record<StampShape, { width: number; y: number }> = {
	circle: { width: 116, y: 116 },
	octagon: { width: 116, y: 122 },
	rectangle: { width: 132, y: 113 },
	triangle: { width: 132, y: 125 },
};

/** The red overprint across a refused entry's marking band. */
function DeniedOverprint({
	prefix,
	shape,
}: {
	prefix: string;
	shape: StampShape;
}) {
	const { width, y } = DENIED_AT[shape];
	return (
		<g
			filter={grainFilter(prefix, 2)}
			stroke={DENIED_INK}
			transform={`rotate(-5 ${CX} ${y})`}
		>
			<rect
				fill="var(--pp-paper)"
				height="20"
				rx="1.5"
				strokeWidth="2.2"
				width={width}
				x={CX - width / 2}
				y={y - 10}
			/>
			<rect
				fill="none"
				height="15"
				rx="1"
				strokeWidth="0.8"
				width={width - 5}
				x={CX - (width - 5) / 2}
				y={y - 7.5}
			/>
			<text
				className="font-mono"
				fill={DENIED_INK}
				fontSize="11"
				fontWeight={800}
				letterSpacing="1.6"
				stroke="none"
				textAnchor="middle"
				x={CX}
				y={y + 4}
			>
				ENTRY DENIED
			</text>
		</g>
	);
}

/**
 * The marking as the rim or band prints it. The triangle's base band is too
 * short for the full arrival line, so it keeps the part that matters.
 */
function bandLabel(shape: StampShape, marking: StampMarking): string {
	if (shape === "triangle" && marking === "arrived") {
		return "AWAITING ENTRY";
	}
	return MARKING_LABELS[marking];
}

/** How strongly each marking prints its frame: fresh, bold, faded, or overprinted. */
const FRAME_OPACITY: Record<StampMarking, number> = {
	applied: 0.66,
	arrived: 1,
	denied: 0.7,
	exited: 0.76,
	processing: 0.9,
};

/** The lines inside print more evenly than the frame, so they stay legible. */
const BODY_OPACITY: Record<StampMarking, number> = {
	applied: 0.82,
	arrived: 1,
	denied: 0.86,
	exited: 0.9,
	processing: 1,
};

/** Hover, focus and the selected entry print at full ink. */
const FULL_INK =
	"transition-opacity duration-150 group-hover/stamp:opacity-100 group-focus-visible/stamp:opacity-100 group-aria-[current=true]/stamp:opacity-100 motion-reduce:transition-none";

/**
 * A conversation's entry stamp, drawn in its country's ink. The frame and
 * rim carry the rubber texture; the lines inside print cleaner so the
 * destination reads. Inside a `group/stamp` button it prints at full ink on
 * hover, focus, or when selected, and draws a focus ring along its outline.
 */
export function EntryStamp({
	code,
	large = false,
	name,
	selected = false,
	stamp,
	style,
}: {
	code: string;
	/**
	 * The desk's printing, read from a low angle: full ink, and the date and
	 * destination in larger type (no latest line).
	 */
	large?: boolean;
	name: string;
	/** The open entry: prints at full ink regardless of hover or focus. */
	selected?: boolean;
	stamp: PassportStamp;
	style: StampStyle;
}) {
	const fullInk = selected || large;
	const prefix = usePassportArtId();
	const denied = stamp.marking === "denied";
	const markingOnRim = rimMarking(style.shape);
	const lines = stampTextRows({
		date: stampDate(stamp.entryAt),
		large,
		latest: latestLine(stamp),
		marking: markingOnRim || denied ? null : MARKING_LABELS[stamp.marking],
		shape: style.shape,
		title: stamp.thread.title || "Untitled conversation",
	});
	const rimTop =
		style.shape === "circle"
			? `${name.toUpperCase()} · ${code}`
			: `${code} · ${name.toUpperCase()}`;
	let rimBottom = `NO ${recordSerial(stamp.thread.id)}`;
	if (markingOnRim) {
		rimBottom = denied ? "" : bandLabel(style.shape, stamp.marking);
	}
	const ink = stamp.countryId ? stampInk(style.ink) : "var(--pp-ink)";
	const reversed = stamp.marking === "arrived";
	return (
		<svg
			aria-hidden="true"
			className="block overflow-visible"
			focusable="false"
			height={STAMP_HEIGHT}
			viewBox={`0 0 ${STAMP_WIDTH} ${STAMP_HEIGHT}`}
			width={STAMP_WIDTH}
		>
			<path
				className="opacity-0 group-focus-visible/stamp:opacity-100"
				d={shapePath(style.shape, -5)}
				fill="none"
				stroke="var(--ring)"
				strokeLinejoin="round"
				strokeWidth={2.5}
			/>
			<g color={ink} fill="currentColor" stroke="currentColor">
				<g
					className={FULL_INK}
					opacity={fullInk ? 1 : FRAME_OPACITY[stamp.marking]}
				>
					<g filter={grainFilter(prefix, stamp.grain)}>
						<ShapeStrokes
							border={style.border}
							marking={stamp.marking}
							shape={style.shape}
						/>
					</g>
					<RimText
						bottom={rimBottom}
						bottomIsMarking={markingOnRim}
						inkFilter={grainFilter(prefix, stamp.grain)}
						letterFilter={softFilter(prefix)}
						prefix={`${prefix}-${stamp.thread.id.replace(/[^a-zA-Z0-9]/g, "")}`}
						reversed={reversed && markingOnRim}
						shape={style.shape}
						top={rimTop}
					/>
					{style.shape === "triangle" ? (
						<text
							className="font-mono"
							filter={softFilter(prefix)}
							fontSize="11"
							fontWeight={800}
							letterSpacing="1.6"
							stroke="none"
							textAnchor="middle"
							x={CX + 0.8}
							y={60}
						>
							{code}
						</text>
					) : null}
				</g>
				<g
					className={FULL_INK}
					filter={softFilter(prefix)}
					opacity={fullInk ? 1 : BODY_OPACITY[stamp.marking]}
					stroke="none"
					textAnchor="middle"
				>
					{lines.map((line) => (
						<FitText
							className={line.family === "mono" ? "font-mono" : "font-sans"}
							fontSize={line.size}
							fontWeight={line.weight}
							key={`${line.y.toFixed(1)}-${line.text}`}
							letterSpacing={line.spacing}
							room={line.room}
							x={CX}
							y={line.y}
						>
							{line.text}
						</FitText>
					))}
				</g>
			</g>
			{denied ? <DeniedOverprint prefix={prefix} shape={style.shape} /> : null}
		</svg>
	);
}

function emblemColor(
	ink: number,
	surface: "chrome" | "paper",
	neutral: boolean
): string {
	if (neutral) {
		return surface === "chrome" ? "var(--muted-foreground)" : "var(--pp-ink)";
	}
	return surface === "chrome" ? chromeInk(ink) : stampInk(ink);
}

/** Below this width the emblem's code would print under ~10px: leave it off. */
const EMBLEM_CODE_FROM = 56;
/** Below this width the inner border blurs into the outer: draw a silhouette. */
const EMBLEM_DETAIL_FROM = 28;

/**
 * A country's emblem: its stamp shape and border with the code inside. Sized
 * freely: from 56px it prints the code, from 28px the double border, and
 * smaller it keeps a bold silhouette. On paper it prints in raw ink; on the
 * app's chrome (`surface="chrome"`) the ink is lifted toward the theme's
 * foreground so it holds its contrast on dark backgrounds too.
 */
export function CountryEmblem({
	code,
	neutral = false,
	size,
	style,
	surface = "paper",
	textured = false,
}: {
	code: string;
	/** The workspace's own stamp (unassigned entries): page ink, not a country's. */
	neutral?: boolean;
	size: number;
	style: StampStyle;
	surface?: "chrome" | "paper";
	textured?: boolean;
}) {
	const prefix = usePassportArtId();
	const showCode = size >= EMBLEM_CODE_FROM;
	const detailed = size >= EMBLEM_DETAIL_FROM;
	// Strokes in stamp units, thickened as the emblem shrinks so every size
	// draws about a 1.5px outline.
	let outer = 14;
	let inner = 0;
	if (showCode) {
		outer = 3;
		inner = 1.4;
	} else if (detailed) {
		outer = 7;
		inner = 4;
	}
	return (
		<svg
			aria-hidden="true"
			className="block shrink-0"
			focusable="false"
			height={size * (STAMP_HEIGHT / STAMP_WIDTH)}
			viewBox={`0 0 ${STAMP_WIDTH} ${STAMP_HEIGHT}`}
			width={size}
		>
			<g
				color={emblemColor(style.ink, surface, neutral)}
				fill="currentColor"
				filter={textured ? grainFilter(prefix, 1) : undefined}
				stroke="currentColor"
			>
				<g fill="none" strokeLinejoin="round">
					<path d={shapePath(style.shape, 0)} strokeWidth={outer} />
					{inner > 0 ? (
						<path
							d={shapePath(style.shape, showCode ? 7 : 16)}
							strokeWidth={inner}
						/>
					) : null}
				</g>
				{showCode ? (
					<text
						className="font-mono"
						fontSize="30"
						fontWeight={800}
						letterSpacing="3"
						stroke="none"
						textAnchor="middle"
						x={CX + 1.5}
						y={style.shape === "triangle" ? 112 : CY + 11}
					>
						{code}
					</text>
				) : null}
			</g>
		</svg>
	);
}
